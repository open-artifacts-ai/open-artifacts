import { HttpResponse, http } from "msw";

// TODO(C1): replace with the mocks generated from the contract.
export const me = {
  email: "admin@example.com",
  role: "platform_admin",
  env: "staging",
  csrf: "csrf-token",
};

export const handlers = [http.get("*/v1/me", () => HttpResponse.json(me))];
