import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const composePath = fileURLToPath(new URL("../docker-compose.phala.yml", import.meta.url));

test("Phala full-ticket mode has bounded founding-beta defaults", () => {
  const compose = readFileSync(composePath, "utf8");

  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "\$\{PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD:-15\}"/,
  );
  assert.match(
    compose,
    /PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "\$\{PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD:-25\}"/,
  );
});
