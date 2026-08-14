export type PrivateAgentSpendAction =
  | "discover"
  | "execute"
  | "keep_warm"
  | "provision"
  | "session"
  | "wake";

export type PrivateAgentEmergencyControlAction = "pause" | "kill";

export type PrivateAgentSpendPolicyDecision =
  | { allowed: true; action: PrivateAgentSpendAction; environment: "production" | "development" }
  | {
      allowed: false;
      action: PrivateAgentSpendAction;
      environment: "production" | "test" | "development" | "preview" | "unknown";
      reason:
        | "private_agent_test_environment"
        | "private_agent_nonproduction_environment"
        | "private_agent_remote_execution_disabled"
        | "private_agent_spend_lockdown"
        | "private_agent_spend_not_armed";
    };

export type PrivateAgentEmergencyControlPolicyDecision =
  | {
      allowed: true;
      action: PrivateAgentEmergencyControlAction;
      environment: "production" | "development";
    }
  | {
      allowed: false;
      action: PrivateAgentEmergencyControlAction;
      environment: "test" | "development" | "preview" | "unknown";
      reason: "private_agent_test_environment" | "private_agent_nonproduction_environment";
    };

const privateAgentMockTransports = new WeakSet<typeof fetch>();

/** Server-only, fail-closed authority for every action that can consume private-agent compute. */
export function privateAgentSpendPolicy(
  action: PrivateAgentSpendAction,
  env: Record<string, string | undefined> = process.env,
): PrivateAgentSpendPolicyDecision {
  const environment = privateAgentEnvironment(env);
  if (privateAgentLocalDryRunAllowed(env)) return { allowed: true, action, environment: "development" };
  if (environment === "test") {
    return { allowed: false, action, environment, reason: "private_agent_test_environment" };
  }
  if (environment !== "production") {
    return { allowed: false, action, environment, reason: "private_agent_nonproduction_environment" };
  }
  if (trueEnv(env.GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED)) {
    return { allowed: false, action, environment, reason: "private_agent_remote_execution_disabled" };
  }
  if (trueEnv(env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN)) {
    return { allowed: false, action, environment, reason: "private_agent_spend_lockdown" };
  }
  if (env.GHOLA_PRIVATE_AGENT_SPEND_ARMED !== "true") {
    return { allowed: false, action, environment, reason: "private_agent_spend_not_armed" };
  }
  return { allowed: true, action, environment };
}

/**
 * Pause and kill reduce authority and must remain available in production when
 * spend is disarmed or locked down. Authentication and session ownership are
 * enforced by the calling control route/service before this transport gate.
 */
export function privateAgentEmergencyControlPolicy(
  action: PrivateAgentEmergencyControlAction,
  env: Record<string, string | undefined> = process.env,
): PrivateAgentEmergencyControlPolicyDecision {
  const environment = privateAgentEnvironment(env);
  if (privateAgentLocalDryRunAllowed(env)) return { allowed: true, action, environment: "development" };
  if (environment === "production") return { allowed: true, action, environment };
  return {
    allowed: false,
    action,
    environment,
    reason: environment === "test"
      ? "private_agent_test_environment"
      : "private_agent_nonproduction_environment",
  };
}

/**
 * Brands a hand-written test transport. The brand is process-local and cannot be
 * supplied through request data or environment variables.
 */
export function brandPrivateAgentMockTransport<T extends typeof fetch>(transport: T): T {
  if (transport === globalThis.fetch || isBoundTransport(transport)) {
    throw new Error("private_agent_mock_transport_must_not_wrap_global_fetch");
  }
  privateAgentMockTransports.add(transport);
  return transport;
}

/** Tests may exercise serialization only through an explicitly injected mock transport. */
export function privateAgentTransportAllowed(
  action: PrivateAgentSpendAction,
  _env: Record<string, string | undefined>,
  injectedFetch?: typeof fetch,
): boolean {
  if (privateAgentLocalDryRunAllowed(process.env)) return true;
  const actualEnvironment = privateAgentEnvironment(process.env);
  if (actualEnvironment === "production") {
    return privateAgentSpendPolicy(action, process.env).allowed;
  }
  if (actualEnvironment !== "test" || typeof injectedFetch !== "function") return false;
  if (injectedFetch === globalThis.fetch || isBoundTransport(injectedFetch)) return false;
  return privateAgentMockTransports.has(injectedFetch);
}

/** Tests may exercise emergency controls only through an explicitly branded mock. */
export function privateAgentEmergencyControlTransportAllowed(
  action: PrivateAgentEmergencyControlAction,
  _env: Record<string, string | undefined>,
  injectedFetch?: typeof fetch,
): boolean {
  const decision = privateAgentEmergencyControlPolicy(action, process.env);
  if (decision.allowed) return true;
  if (decision.environment !== "test" || typeof injectedFetch !== "function") return false;
  if (injectedFetch === globalThis.fetch || isBoundTransport(injectedFetch)) return false;
  return privateAgentMockTransports.has(injectedFetch);
}

export function privateAgentLocalDryRunAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (privateAgentEnvironment(env) !== "development") return false;
  if (env.GHOLA_PRIVATE_AGENT_LOCAL_E2E_ENABLED !== "true" || env.GHOLA_PRIVATE_AGENT_LOCAL_E2E_DRY_RUN !== "true") {
    return false;
  }
  const raw = env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || env.GHOLA_PRIVATE_AGENT_WORKER_URL || "";
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function privateAgentEnvironment(
  env: Record<string, string | undefined> = process.env,
): "production" | "test" | "development" | "preview" | "unknown" {
  if (env.NODE_ENV?.trim().toLowerCase() === "test" || trueEnv(env.VITEST)) return "test";
  const vercelEnvironment = env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnvironment === "preview") return "preview";
  if (env.NODE_ENV?.trim().toLowerCase() === "development" || vercelEnvironment === "development") {
    return "development";
  }
  if (env.NODE_ENV?.trim().toLowerCase() === "production" && vercelEnvironment === "production") {
    return "production";
  }
  return "unknown";
}

function trueEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function isBoundTransport(transport: typeof fetch): boolean {
  return transport.name.trim().toLowerCase().startsWith("bound ");
}
