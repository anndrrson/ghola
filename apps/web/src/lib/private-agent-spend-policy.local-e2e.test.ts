import { afterEach, describe, expect, it } from "vitest";
import { privateAgentLocalDryRunAllowed, privateAgentSpendPolicy } from "./private-agent-spend-policy";

const before = { ...process.env };
afterEach(() => { process.env = { ...before }; });

describe("loopback-only private agent E2E", () => {
  it("permits explicit local dry-run transport", () => {
    const env = {
      NODE_ENV: "development",
      GHOLA_PRIVATE_AGENT_LOCAL_E2E_ENABLED: "true",
      GHOLA_PRIVATE_AGENT_LOCAL_E2E_DRY_RUN: "true",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "http://127.0.0.1:8787",
    };
    expect(privateAgentLocalDryRunAllowed(env)).toBe(true);
    expect(privateAgentSpendPolicy("session", env).allowed).toBe(true);
  });

  it("rejects remote or non-dry-run development transport", () => {
    const env = {
      NODE_ENV: "development",
      GHOLA_PRIVATE_AGENT_LOCAL_E2E_ENABLED: "true",
      GHOLA_PRIVATE_AGENT_LOCAL_E2E_DRY_RUN: "true",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example.com",
    };
    expect(privateAgentLocalDryRunAllowed(env)).toBe(false);
    expect(privateAgentSpendPolicy("session", env).allowed).toBe(false);
    expect(privateAgentLocalDryRunAllowed({
      ...env,
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "http://127.0.0.1:8787",
      GHOLA_PRIVATE_AGENT_LOCAL_E2E_DRY_RUN: "false",
    })).toBe(false);
  });
});
