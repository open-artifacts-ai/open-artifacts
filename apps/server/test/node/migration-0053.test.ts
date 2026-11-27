import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  applyMigration,
  D1_MIGRATIONS,
} from "../../scripts/migration-timing.ts";

const dir = join(__dirname, "../../migrations");
const file = "0053_account_push.sql";

it("keeps only previously enabled devices, account preferences and non-update deliveries on upgrade", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(D1_MIGRATIONS);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < file)
    .sort()) {
    applyMigration(db, name, readFileSync(join(dir, name), "utf8"));
  }
  db.exec("pragma foreign_keys = on");
  const user = db.prepare(
    "insert into users(id,email,name,role,created_at) values (?,?,'Fixture','member',1)",
  );
  const pref = db.prepare(
    "insert into notification_prefs(user_id,needs_you_browser,updates_browser,browser_all_asks,quiet_start,quiet_end,time_zone,lock_detail,phone_push,updated_at) values (?,?,1,1,'22:00','07:00','Europe/Paris',1,1,1)",
  );
  for (const id of ["enabled", "disabled", "device-less", "default"]) {
    user.run(id, `${id}@example.invalid`);
    if (id !== "default") pref.run(id, id === "disabled" ? 0 : 1);
  }
  const sub = db.prepare(
    "insert into push_subscriptions(id,user_id,endpoint,p256dh,auth,label,needs_you,updates,created_at,last_sent_at) values (?,?,?,'test','test','laptop',?,?,1,2)",
  );
  for (const id of ["enabled", "disabled", "default"]) {
    for (const flag of [0, 1]) {
      for (const updates of [0, 1]) {
        const key = `${id}-${flag}-${updates}`;
        sub.run(key, id, `https://${key}.example.invalid`, flag, updates);
      }
    }
  }
  const pending = db.prepare(
    "insert into push_pending(id,user_id,key,kind,artifact_id,thread_id,asker_name,excerpt,send_after,created_at) values (?,'enabled',?,?,'page','thread','Fixture','',2,1)",
  );
  for (const kind of ["update", "ask", "later"]) pending.run(kind, kind, kind);
  const prefs = db.prepare("select * from notification_prefs order by user_id");
  const subscriptions = db.prepare(
    "select * from push_subscriptions order by id",
  );
  const kept = db
    .prepare(
      "select * from push_subscriptions where id in ('enabled-1-0','enabled-1-1') order by id",
    )
    .all();
  expect(kept).toHaveLength(2);
  const before = prefs.all();
  const schema = db.prepare("select name,sql from sqlite_schema order by name");
  const oldSchema = schema.all();
  const sql = readFileSync(join(dir, file), "utf8");
  for (let i = 0; i < 2; i++) {
    db.exec(sql);
    expect(subscriptions.all()).toEqual(kept);
    expect(prefs.all()).toEqual(before);
    expect(
      db.prepare("select kind from push_pending order by kind").all(),
    ).toEqual([{ kind: "ask" }, { kind: "later" }]);
    expect(db.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(schema.all()).toEqual(oldSchema);
  }
});
