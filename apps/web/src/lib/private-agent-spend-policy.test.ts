import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brandPrivateAgentMockTransport,
  privateAgentEmergencyControlPolicy,
  privateAgentEmergencyControlTransportAllowed,
  privateAgentSpendPolicy,
  privateAgentTransportAllowed,
} from "./private-agent-spend-policy";

const POLICY_ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "VITEST",
  "GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED",
  "GHOLA_PRIVATE_AGENT_SPEND_ARMED",
  "GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN",
] as const;
const ORIGINAL_POLICY_ENV = Object.fromEntries(
  POLICY_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof POLICY_ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of POLICY_ENV_KEYS) {
    const value = ORIGINAL_POLICY_ENV[key];
    if (value === undefined) delete process.env[key];
    else Reflect.set(process.env, key, value);
  }
});

describe("private-agent spend policy", () => {
  it.each(["discover", "wake", "provision", "session", "execute", "keep_warm"] as const)(
    "blocks %s in localhost development even when all client/operator flags are armed",
    (action) => {
      expect(privateAgentSpendPolicy(action, {
        NODE_ENV: "development",
        GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
        GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED: "true",
        GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
        PHALA_CLOUD_API_KEY: "present",
      })).toMatchObject({
        allowed: false,
        environment: "development",
        reason: "private_agent_nonproduction_environment",
      });
    },
  );

  it("blocks tests and previews", () => {
    expect(privateAgentSpendPolicy("execute", { NODE_ENV: "test", VERCEL_ENV: "production" }).allowed).toBe(false);
    expect(privateAgentSpendPolicy("execute", { NODE_ENV: "production", VERCEL_ENV: "preview" }).allowed).toBe(false);
  });

  it("requires both production markers and honors every server spend lock", () => {
    const production = { NODE_ENV: "production", VERCEL_ENV: "production" };
    expect(privateAgentSpendPolicy("wake", production)).toMatchObject({
      allowed: false,
      reason: "private_agent_spend_not_armed",
    });
    expect(privateAgentSpendPolicy("wake", { ...production, GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true" }).allowed).toBe(true);
    expect(privateAgentSpendPolicy("wake", { ...production, GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "true" }).allowed).toBe(false);
    expect(privateAgentSpendPolicy("wake", { ...production, GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "true" }).allowed).toBe(false);
    expect(privateAgentSpendPolicy("wake", { ...production, GHOLA_PRIVATE_AGENT_SPEND_ARMED: "false" }).allowed).toBe(false);
    expect(privateAgentSpendPolicy("wake", { ...production, GHOLA_PRIVATE_AGENT_SPEND_ARMED: "TRUE" }).allowed).toBe(false);
    expect(privateAgentSpendPolicy("wake", { ...production, GHOLA_PRIVATE_AGENT_SPEND_ARMED: " true " }).allowed).toBe(false);
  });

  it.each(["pause", "kill"] as const)(
    "keeps authenticated production %s control available while every spend flag is locked",
    (action) => {
      expect(privateAgentEmergencyControlPolicy(action, {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        GHOLA_PRIVATE_AGENT_SPEND_ARMED: "false",
        GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "true",
        GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "true",
      })).toEqual({ allowed: true, action, environment: "production" });
      expect(privateAgentEmergencyControlPolicy(action, { NODE_ENV: "development" })).toMatchObject({
        allowed: false,
        reason: "private_agent_nonproduction_environment",
      });
      expect(privateAgentEmergencyControlPolicy(action, { NODE_ENV: "test" })).toMatchObject({
        allowed: false,
        reason: "private_agent_test_environment",
      });
    },
  );

  it("does not let caller-supplied production flags authorize a real transport in tests", () => {
    const spoofedProduction = {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
    };

    expect(privateAgentTransportAllowed("execute", spoofedProduction, globalThis.fetch)).toBe(false);
    expect(
      privateAgentTransportAllowed(
        "execute",
        spoofedProduction,
        globalThis.fetch.bind(globalThis) as typeof fetch,
      ),
    ).toBe(false);
    expect(() => brandPrivateAgentMockTransport(
      globalThis.fetch.bind(globalThis) as typeof fetch,
    )).toThrow("private_agent_mock_transport_must_not_wrap_global_fetch");
  });

  it("allows only an explicitly injected test mock while the actual environment is test", () => {
    const plainTransport = (async () => new Response("{}")) as typeof fetch;
    const frameworkMock = vi.fn<typeof fetch>();
    const unbrandedEmergencyMock = vi.fn<typeof fetch>();

    expect(privateAgentTransportAllowed("execute", {}, plainTransport)).toBe(false);
    expect(privateAgentTransportAllowed("execute", {}, frameworkMock)).toBe(false);
    expect(
      privateAgentTransportAllowed(
        "execute",
        {},
        brandPrivateAgentMockTransport(frameworkMock),
      ),
    ).toBe(true);
    expect(
      privateAgentTransportAllowed(
        "execute",
        {},
        brandPrivateAgentMockTransport(plainTransport),
      ),
    ).toBe(true);
    expect(privateAgentEmergencyControlTransportAllowed("kill", {}, globalThis.fetch)).toBe(false);
    expect(privateAgentEmergencyControlTransportAllowed("pause", {}, unbrandedEmergencyMock)).toBe(false);
    expect(privateAgentEmergencyControlTransportAllowed(
      "kill",
      { NODE_ENV: "production", VERCEL_ENV: "production" },
      brandPrivateAgentMockTransport((async () => new Response("{}")) as typeof fetch),
    )).toBe(true);
  });

  it("uses only real production policy state for remote transport", () => {
    delete process.env.VITEST;
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.VERCEL_ENV = "production";
    process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED = "true";
    delete process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN;
    delete process.env.GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED;

    expect(privateAgentTransportAllowed("execute", { NODE_ENV: "development" }, globalThis.fetch)).toBe(true);
    process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN = "true";
    expect(privateAgentTransportAllowed("execute", {}, globalThis.fetch)).toBe(false);
    process.env.GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED = "true";
    process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED = "false";
    expect(privateAgentEmergencyControlTransportAllowed("kill", {}, globalThis.fetch)).toBe(true);
    expect(privateAgentEmergencyControlTransportAllowed("pause", {}, globalThis.fetch)).toBe(true);
  });

  it("denies nonproduction global emergency transport despite caller production flags", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVercelEnv = process.env.VERCEL_ENV;
    const originalVitest = process.env.VITEST;
    try {
      delete process.env.VITEST;
      Reflect.set(process.env, "NODE_ENV", "development");
      delete process.env.VERCEL_ENV;
      expect(privateAgentEmergencyControlTransportAllowed("kill", {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      }, globalThis.fetch)).toBe(false);
    } finally {
      if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
      if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = originalVercelEnv;
      if (originalVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
    }
  });
});
