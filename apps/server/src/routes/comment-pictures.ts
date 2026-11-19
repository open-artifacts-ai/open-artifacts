import { CommentPictureReserveSchema, isId } from "@oa/shared";
import { interactiveSession } from "../auth/authz.js";
import { isGuestRole } from "../auth/policy.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { runtimeStub } from "../runtime/do.js";
import {
  getPicture,
  pictureComment,
  putPicture,
  reservePicture,
} from "../services/comment-pictures.js";
import { open } from "./comments.js";
import type { AppType } from "./index.js";

// Pictures on comments (#2508). Reserve like writing a comment (members and
// agents, never a guest or a signed-out visitor); the signed PUT stores the
// checked bytes; the GET serves them to whoever may read the page's comments,
// checked on every request.

const PICTURES = "/api/v1/artifacts/:id/pictures";
const PICTURE = `${PICTURES}/:pictureId`;

/** What a served picture must never be: the type is the server's, the browser may not sniff or run it. */
const SERVED = {
  "x-content-type-options": "nosniff",
  "content-disposition": "inline",
  "cache-control": "private, max-age=300",
  "content-security-policy": "default-src 'none'",
} as const;

export function mountCommentPictures(app: AppType): void {
  app.post(PICTURES, async (c) => {
    const { id } = await open(c, "comments.write");
    const input = await jsonBody(c, CommentPictureReserveSchema);
    const user = c.var.user;
    // Guests and signed-out visitors can't add pictures (yet). After the body
    // check, so every caller the policy admits answers a bad body the same.
    if (!user || isGuestRole(user.role))
      throw new ApiError("forbidden", "Log in as a member to add pictures");
    return c.json(await reservePicture(c.env, user, id, input), 201);
  });

  // Authorized by its signature alone (app.ts exempts the session and CSRF).
  app.put(PICTURE, async (c) => {
    const pic = await putPicture(
      c.env,
      c.req.param("id") ?? "",
      c.req.param("pictureId") ?? "",
      c.req.query("exp") ?? "",
      c.req.query("sig") ?? "",
      c.req.raw,
    );
    return c.json(pic, 200);
  });

  app.get(PICTURE, async (c) => {
    const { id } = await open(c, "comments.read");
    const pictureId = c.req.param("pictureId") ?? "";
    // A malformed id is a 400 (so access shows in the answer); a well-formed
    // one that is unknown, foreign or unusable is a 404.
    if (!isId(pictureId))
      throw new ApiError("bad_request", "Invalid pictureId");
    // #2577: an agent of the person a request is held for (a token or grant,
    // not their own browser session) reads no picture of that request.
    const me = c.var.user?.id ?? null;
    if (me && !interactiveSession(c)) {
      const at = await pictureComment(c.env, id, pictureId);
      if (at) {
        const t = await runtimeStub(c.env, id).commentsGet(at.threadId);
        const held = t.comments
          .find((x) => x.id === at.commentId)
          ?.held?.some((h) => h.state === "held" && h.owner === me);
        if (held) throw new ApiError("not_found", "Not found");
      }
    }
    const hit = await getPicture(c.env, id, pictureId, c.var.user?.id ?? null);
    if (!hit) throw new ApiError("not_found", "Not found");
    return new Response(hit.body, {
      status: 200,
      headers: {
        ...SERVED,
        "content-type": hit.type,
        "content-length": String(hit.bytes),
      },
    });
  });
}
