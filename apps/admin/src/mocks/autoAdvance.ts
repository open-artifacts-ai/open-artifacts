import type { ProvisioningMock } from "@oa/shared/provisioning/mocks";

/**
 * Dev only: the contract mock never moves a job on by itself. For every job an
 * accepted write returns, go running after `stepMs` and done after `2 * stepMs`,
 * so the job page visibly progresses.
 */
export function autoAdvance(
  events: {
    on(
      type: "response:mocked",
      cb: (e: { response: Response }) => void,
    ): unknown;
  },
  mock: Pick<ProvisioningMock, "advanceJob">,
  stepMs: number,
) {
  events.on("response:mocked", ({ response }) => {
    if (response.status !== 202 || response.headers.has("oa-idempotent-replay"))
      return;
    void response
      .clone()
      .json()
      .then((b: { job?: { id?: string } }) => {
        const id = b.job?.id;
        if (!id) return;
        const move = (status: "running" | "done", after: number) =>
          setTimeout(() => {
            try {
              mock.advanceJob(id, status);
            } catch {
              // Canceled or already finished: nothing to move.
            }
          }, after);
        move("running", stepMs);
        move("done", 2 * stepMs);
      })
      .catch(() => {});
  });
}
