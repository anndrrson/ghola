import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const composePath = fileURLToPath(new URL("../docker-compose.phala.yml", import.meta.url));

test("Phala full-ticket mode has bounded founding-beta defaults", () => {
  const compose = readFileSync(composePath, "utf8");

  assert.match(
    compose,
    /image: "ghcr\.io\/anndrrson\/ghola\/private-agent-worker:prod-394790fb@sha256:7a5320baec2d4caa565cb19926523ec136d1a7008006e14ea5dd4d56350c8588"/,
  );
  assert.match(
    compose,
    /PHALA_CVM_IMAGE_DIGEST: "sha256:7a5320baec2d4caa565cb19926523ec136d1a7008006e14ea5dd4d56350c8588"/,
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
