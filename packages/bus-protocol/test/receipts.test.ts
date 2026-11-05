import { describe, expect, it } from "vitest";
import {
  RECEIPT_STATES,
  REFUSAL_REASONS,
  ReceiptSchema,
  receiptLabel,
} from "../src/receipts.ts";

describe("receipts", () => {
  it("pins states and refusal reasons", () => {
    expect(RECEIPT_STATES).toEqual([
      "pending",
      "delivered",
      "expired",
      "refused",
    ]);
    expect(REFUSAL_REASONS).toEqual([
      "unknown_agent",
      "closed",
      "inbox_full",
      "too_large",
      "other_namespace",
      "revoked",
      "ambiguous",
      "role_vacant",
      "agent_gone",
      "mailbox_full",
      "reserved_name",
    ]);
  });
  it("rejects ambiguous on expired", () => {
    expect(
      ReceiptSchema.safeParse({
        msg_id: "a".repeat(16),
        state: "expired",
        reason: "ambiguous",
      }).success,
    ).toBe(false);
  });
  it("accepts ambiguous on a refused receipt and labels it", () => {
    const r = { msg_id: "a".repeat(16), state: "refused", reason: "ambiguous" };
    expect(ReceiptSchema.safeParse(r).success).toBe(true);
    expect(receiptLabel(ReceiptSchema.parse(r))).toBe("refused: ambiguous");
  });
  it("allows a reason on refused and on expired, never on delivered", () => {
    expect(
      ReceiptSchema.safeParse({
        msg_id: "a".repeat(16),
        state: "refused",
        reason: "inbox_full",
      }).success,
    ).toBe(true);
    expect(
      ReceiptSchema.safeParse({
        msg_id: "a".repeat(16),
        state: "expired",
        reason: "recipient_closed",
      }).success,
    ).toBe(true);
    expect(
      ReceiptSchema.safeParse({ msg_id: "a".repeat(16), state: "delivered" })
        .success,
    ).toBe(true);
    expect(
      ReceiptSchema.safeParse({
        msg_id: "a".repeat(16),
        state: "pending",
        reason: "closed",
      }).success,
    ).toBe(false);
  });
  it("has a label for every reason", () => {
    expect(
      receiptLabel({
        msg_id: "a".repeat(16),
        state: "refused",
        reason: "closed",
      }),
    ).toBe("refused: closed");
    expect(receiptLabel({ msg_id: "a".repeat(16), state: "pending" })).toBe(
      "pending",
    );
  });
  it("carries an optional to_name (a former-name hit, #393)", () => {
    const r = { msg_id: "a".repeat(16), state: "pending" };
    expect(ReceiptSchema.safeParse(r).success).toBe(true);
    expect(ReceiptSchema.safeParse({ ...r, to_name: "code-96" }).success).toBe(
      true,
    );
    expect(ReceiptSchema.safeParse({ ...r, to_name: "openbus" }).success).toBe(
      false,
    );
  });
  it("role_vacant is a refusal (#1296); a card role field stays dropped", () => {
    expect(
      ReceiptSchema.safeParse({
        msg_id: "a".repeat(16),
        state: "refused",
        reason: "role_vacant",
      }).success,
    ).toBe(true);
    expect(
      ReceiptSchema.safeParse({
        msg_id: "a".repeat(16),
        state: "pending",
        role: "backend-lead",
      }).success,
    ).toBe(false);
  });
});
