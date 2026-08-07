import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const composePath = fileURLToPath(new URL("../docker-compose.phala.yml", import.meta.url));

test("Phala full-ticket mode has bounded founding-beta defaults", () => {
  const compose = readFileSync(composePath, "utf8");

  assert.match(
    compose,
    /image: "ghcr\.io\/anndrrson\/ghola\/private-agent-worker:prod-68c24c48@sha256:b4f751c2286ccd69e91e917c3954271102c37b5d2718bf5ee2ab6cd6eebf0917"/,
  );
  assert.match(
    compose,
    /PHALA_CVM_IMAGE_DIGEST: "sha256:b4f751c2286ccd69e91e917c3954271102c37b5d2718bf5ee2ab6cd6eebf0917"/,
  );
  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true"/,
  );
  assert.match(compose, /PRIVATE_AGENT_STATE_STORE: "postgres"/);
  assert.match(compose, /PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE: "60"/);
  assert.match(compose, /PRIVATE_AGENT_MAX_GLOBAL_VENUE_WEIGHT_PER_MINUTE: "1000"/);
  assert.match(compose, /PRIVATE_AGENT_MAX_HYPERLIQUID_STREAMING_USERS: "10"/);
  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket"/,
  );
  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "15"/,
  );
  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "25"/,
  );
  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "50"/,
  );
});
