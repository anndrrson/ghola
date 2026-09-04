import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkerPolicy,
  parseEnvText,
  patchWorkerCompose,
  validateComposePatch,
} from "./phala-compose-policy-patch.mjs";

const webEnv = Object.freeze({
  PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
  PRIVATE_AGENT_VENUE_DRY_RUN: "false",
  PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "15\n",
  PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25\n",
  PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
  PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
  PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
  PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true",
  PRIVATE_AGENT_ASTER_LIVE_MODE: "full_ticket",
  PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET: "true",
  PRIVATE_AGENT_LIGHTER_LIVE_MODE: "full_ticket",
  PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT: "true",
  PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: "true",
});

const compose = `services:
  private-agent-worker:
    image: ghcr.io/example/worker:release@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    restart: unless-stopped
    environment:
      PRIVATE_AGENT_EXECUTION_TOKEN: "\${PRIVATE_AGENT_EXECUTION_TOKEN}"
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "\${PRIVATE_AGENT_WORKER_CAPABILITY_SECRET:?required}"
      PRIVATE_AGENT_FUNDING_SIGNING_KEY: "\${PRIVATE_AGENT_FUNDING_SIGNING_KEY:?required}"
      PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "\${PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY:-true}"
      PRIVATE_AGENT_VENUE_DRY_RUN: "\${PRIVATE_AGENT_VENUE_DRY_RUN:-false}"
      PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "\${PRIVATE_AGENT_GLOBAL_KILL_SWITCH:-false}"
      PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: "\${PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT:-false}"
      PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "\${PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET:-false}"
      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "\${PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE:-disabled}"
      PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true"
      PRIVATE_AGENT_ASTER_LIVE_MODE: "full_ticket"
      PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET: "true"
      PRIVATE_AGENT_LIGHTER_LIVE_MODE: "full_ticket"
      PRIVATE_AGENT_SOMETHING_LIVE_SUBMIT: "true"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock
      - private-agent-data:/data

volumes:
  private-agent-data:
`;

test("literalizes venue and carry policy without changing image, volumes, or secrets", () => {
  const { policy } = buildWorkerPolicy(webEnv);
  const result = patchWorkerCompose(compose, policy);
  assert.equal(validateComposePatch(compose, result.desired, result.policy), true);
  assert.match(result.desired, /PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "15"/);
  assert.match(result.desired, /PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT: "false"/);
  assert.match(result.desired, /PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: "false"/);
  assert.match(result.desired, /PRIVATE_AGENT_SOMETHING_LIVE_SUBMIT: "false"/);
  assert.match(result.desired, /PRIVATE_AGENT_ASTER_FULL_TICKET_MAX_NOTIONAL_USD: "25"/);
  assert.match(result.desired, /PRIVATE_AGENT_LIGHTER_DAILY_NOTIONAL_CAP_USD: "100"/);
  assert.match(result.desired, /image: ghcr\.io\/example\/worker:release@sha256:a{64}/);
  assert.match(result.desired, /PRIVATE_AGENT_EXECUTION_TOKEN: "\$\{PRIVATE_AGENT_EXECUTION_TOKEN\}"/);
  assert.match(result.desired, /- private-agent-data:\/data/);
});

test("web submit and pilot requests are forced off", () => {
  const { policy, sources } = buildWorkerPolicy(webEnv);
  assert.equal(policy.PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT, "false");
  assert.equal(policy.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED, "false");
  assert.equal(sources.PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT, "forced_no_submit");
});

test("parses quoted Vercel values and trims embedded newline", () => {
  assert.deepEqual(parseEnvText('A="15\\n"\nB=full_ticket\n'), { A: "15", B: "full_ticket" });
});

test("requires explicit live venue policy from the web environment", () => {
  assert.throws(() => buildWorkerPolicy({}), /PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY is required/);
});

test("rejects duplicate policy keys", () => {
  const duplicated = compose.replace(
    '      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "\${PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE:-disabled}"',
    '      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "disabled"\n      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket"',
  );
  const { policy } = buildWorkerPolicy(webEnv);
  assert.throws(() => patchWorkerCompose(duplicated, policy), /duplicate worker environment key/);
});
