import { describe, expect, it } from "vitest";
import { workerAuthorizationHeader } from "./private-agent-capability";

describe("worker capability configuration", () => {
  it("refuses to sign when capability secret aliases disagree", () => {
    expect(() => workerAuthorizationHeader({
      env: {
        PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "current-secret",
        GHOLA_WORKER_CAPABILITY_SECRET: "stale-secret",
      },
      method: "POST",
      path: "/hyperliquid/verify",
      scope: "order:verify",
      body: {},
    })).toThrow("worker_capability_secret_alias_mismatch");
  });

  it("signs when aliases agree", () => {
    const authorization = workerAuthorizationHeader({
      env: {
        PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "shared-secret",
        GHOLA_WORKER_CAPABILITY_SECRET: "shared-secret",
      },
      method: "POST",
      path: "/hyperliquid/verify",
      scope: "order:verify",
      body: {},
    });

    expect(authorization).toMatch(/^Bearer ghcap_v1\./);
  });
});
