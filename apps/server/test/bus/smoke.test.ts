import { describe, expect, it } from "vitest";
import { machine, ready, waitFor } from "./helpers.js";

describe("bus smoke", () => {
  it("a machine token connects and gets hello_ok with its machine id", async () => {
    const m = await machine("Laptop");
    const d = await ready(m.token);
    d.send({ v: 1, id: "h2", type: "hello", machine_label: "Laptop", client_version: "0.1.0" });
    const ok = await waitFor(d, "hello_ok");
    expect(ok.machine_id).toBe(m.id);
    expect(ok.machine_label).toBe("Laptop");
    d.close();
  });
});
