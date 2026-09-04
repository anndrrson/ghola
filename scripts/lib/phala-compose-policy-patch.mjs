const FORCE_FALSE_FLAGS = Object.freeze([
  "PRIVATE_AGENT_ARB_LIVE_SUBMIT",
  "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT",
  "PRIVATE_AGENT_CARRY_LIVE_SUBMIT",
  "PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT",
  "PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED",
  "PRIVATE_AGENT_KRAKEN_V2_LIVE_SUBMIT",
  "PRIVATE_AGENT_MARKET_MAKER_LIVE_SUBMIT",
]);

const POLICY_SPECS = Object.freeze([
  required("PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY", "true", bool),
  required("PRIVATE_AGENT_VENUE_DRY_RUN", "false", bool),
  required("PRIVATE_AGENT_GLOBAL_KILL_SWITCH", "false", bool),

  required("PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET", "true", bool, ["GHOLA_HYPERLIQUID_ALLOW_MAINNET"]),
  required("PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE", "full_ticket", fullTicket, ["GHOLA_HYPERLIQUID_LIVE_MODE"]),
  required("PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD", "15", positiveDecimal),
  required("PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD", "25", positiveDecimal, ["GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD"]),
  required("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD", "100", positiveDecimal),
  required("PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD", "500", positiveDecimal),
  required("PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS", "100", positiveInteger, ["GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS"]),
  optional("PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS", "30000", positiveInteger),

  optional("PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC", "11000000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MAX_UNHEDGED_MS", "2000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS", "2000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS", "25", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS", "50", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_AUTO_EXIT_ENABLED", "true", bool),
  optional("PRIVATE_AGENT_CARRY_EXECUTION_SWEEP_MS", "2000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_EXECUTION_STALL_MS", "6000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_EXECUTION_CONCURRENCY", "8", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_EXIT_VERIFY_RETRY_MS", "30000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MONITOR_ENABLED", "true", bool),
  optional("PRIVATE_AGENT_CARRY_MONITOR_INITIAL_DELAY_MS", "5000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS", "5000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MONITOR_STALL_MS", "15000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY", "8", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED", "true", bool),
  optional("PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INITIAL_DELAY_MS", "5000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS", "60000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_STALL_MS", "180000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ASSETS", "BTC,ETH,SOL", carryAssets),
  optional("PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES", "3", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS", "600000", positiveInteger),
  optional("PRIVATE_AGENT_CARRY_QUALIFICATION_MAX_AGE_MS", "7776000000", positiveInteger),

  required("PRIVATE_AGENT_ASTER_ALLOW_MAINNET", "true", bool, ["GHOLA_ASTER_ALLOW_MAINNET"]),
  required("PRIVATE_AGENT_ASTER_LIVE_MODE", "full_ticket", fullTicket, ["GHOLA_ASTER_LIVE_MODE"]),
  optional("PRIVATE_AGENT_ASTER_FULL_TICKET_MAX_NOTIONAL_USD", "25", positiveDecimal),
  optional("PRIVATE_AGENT_ASTER_DAILY_NOTIONAL_CAP_USD", "100", positiveDecimal),

  required("PRIVATE_AGENT_LIGHTER_ALLOW_MAINNET", "true", bool, ["GHOLA_LIGHTER_ALLOW_MAINNET"]),
  required("PRIVATE_AGENT_LIGHTER_LIVE_MODE", "full_ticket", fullTicket, ["GHOLA_LIGHTER_LIVE_MODE"]),
  optional("PRIVATE_AGENT_LIGHTER_FULL_TICKET_MAX_NOTIONAL_USD", "25", positiveDecimal),
  optional("PRIVATE_AGENT_LIGHTER_DAILY_NOTIONAL_CAP_USD", "100", positiveDecimal),
]);

const SECRET_ENV_NAMES = Object.freeze([
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
]);

export function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = decodeEnvValue(match[2]);
  }
  return env;
}

export function buildWorkerPolicy(webEnv) {
  const policy = {};
  const sources = {};
  for (const spec of POLICY_SPECS) {
    const resolved = firstValue(webEnv, [spec.key, ...spec.aliases]);
    if (spec.required && !resolved) {
      throw new Error(`${spec.key} is required in the web environment`);
    }
    const value = resolved?.value ?? spec.fallback;
    if (!spec.validate(value)) throw new Error(`${spec.key} has an invalid policy value`);
    policy[spec.key] = value;
    sources[spec.key] = resolved?.key ?? "safe_default";
  }
  for (const key of FORCE_FALSE_FLAGS) {
    policy[key] = "false";
    sources[key] = "forced_no_submit";
  }
  return { policy, sources };
}

export function patchWorkerCompose(original, requestedPolicy) {
  if (typeof original !== "string" || !original.trim()) throw new Error("worker compose is empty");
  const lines = original.split("\n");
  const bounds = workerEnvironmentBounds(lines);
  const policy = { ...requestedPolicy };

  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const entry = environmentEntry(lines[index], bounds.valueIndent);
    if (entry && submitOrPilotFlag(entry.key)) policy[entry.key] = "false";
  }

  const indexes = new Map();
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const entry = environmentEntry(lines[index], bounds.valueIndent);
    if (!entry || !(entry.key in policy)) continue;
    if (indexes.has(entry.key)) throw new Error(`duplicate worker environment key: ${entry.key}`);
    indexes.set(entry.key, index);
  }

  const changed = [];
  for (const [key, value] of Object.entries(policy)) {
    const index = indexes.get(key);
    if (index === undefined) continue;
    const replacement = `${" ".repeat(bounds.valueIndent)}${key}: ${JSON.stringify(value)}`;
    if (lines[index] !== replacement) {
      changed.push({ key, kind: "changed" });
      lines[index] = replacement;
    }
  }

  const added = Object.entries(policy)
    .filter(([key]) => !indexes.has(key))
    .map(([key, value]) => {
      changed.push({ key, kind: "added" });
      return `${" ".repeat(bounds.valueIndent)}${key}: ${JSON.stringify(value)}`;
    });
  lines.splice(bounds.end, 0, ...added);
  const desired = lines.join("\n");
  validateComposePatch(original, desired, policy);
  return { desired, changed, policy };
}

export function validateComposePatch(original, desired, policy) {
  const originalLines = original.split("\n");
  const desiredLines = desired.split("\n");
  const originalBounds = workerEnvironmentBounds(originalLines);
  const desiredBounds = workerEnvironmentBounds(desiredLines);
  const keys = new Set(Object.keys(policy));

  const originalUntouched = withoutPolicyLines(originalLines, originalBounds, keys);
  const desiredUntouched = withoutPolicyLines(desiredLines, desiredBounds, keys);
  if (originalUntouched.join("\n") !== desiredUntouched.join("\n")) {
    throw new Error("compose patch changed content outside the policy allowlist");
  }

  for (const [key, expected] of Object.entries(policy)) {
    const values = environmentValues(desiredLines, desiredBounds, key);
    if (values.length !== 1 || values[0] !== expected) {
      throw new Error(`compose policy validation failed: ${key}`);
    }
  }

  for (let index = desiredBounds.start + 1; index < desiredBounds.end; index += 1) {
    const entry = environmentEntry(desiredLines[index], desiredBounds.valueIndent);
    if (entry && submitOrPilotFlag(entry.key) && scalarValue(entry.rawValue) !== "false") {
      throw new Error(`submit/pilot flag is not false: ${entry.key}`);
    }
  }

  for (const key of SECRET_ENV_NAMES) {
    if (environmentValues(originalLines, originalBounds, key, false).join("\0") !==
        environmentValues(desiredLines, desiredBounds, key, false).join("\0")) {
      throw new Error(`secret placeholder changed: ${key}`);
    }
  }

  if (imageLines(originalLines).join("\0") !== imageLines(desiredLines).join("\0")) {
    throw new Error("worker image changed");
  }
  if (volumeLines(originalLines).join("\0") !== volumeLines(desiredLines).join("\0")) {
    throw new Error("worker volumes changed");
  }
  return true;
}

export function workerImage(compose) {
  const lines = imageLines(String(compose).split("\n"));
  if (lines.length !== 1) throw new Error("expected exactly one worker image");
  return scalarValue(lines[0].replace(/^\s*image\s*:\s*/, ""));
}

function required(key, fallback, validate, aliases = []) {
  return Object.freeze({ key, fallback, validate, aliases, required: true });
}

function optional(key, fallback, validate, aliases = []) {
  return Object.freeze({ key, fallback, validate, aliases, required: false });
}

function firstValue(env, keys) {
  for (const key of keys) {
    const value = typeof env?.[key] === "string" ? env[key].trim() : "";
    if (value) return { key, value };
  }
  return null;
}

function decodeEnvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value)).trim();
    } catch {
      throw new Error("invalid quoted value in web environment file");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).trim();
  return value.trim();
}

function workerEnvironmentBounds(lines) {
  const service = lines.findIndex((line) => /^  private-agent-worker:\s*(?:#.*)?$/.test(line));
  if (service < 0) throw new Error("private-agent-worker service is missing");
  let start = -1;
  for (let index = service + 1; index < lines.length; index += 1) {
    const indent = leadingSpaces(lines[index]);
    if (lines[index].trim() && indent <= 2) break;
    if (/^    environment:\s*(?:#.*)?$/.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) throw new Error("private-agent-worker environment block is missing");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && leadingSpaces(lines[index]) <= 4) {
      end = index;
      break;
    }
  }
  const sample = lines.slice(start + 1, end).find((line) => /^\s+[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line));
  const valueIndent = sample ? leadingSpaces(sample) : 6;
  if (valueIndent <= 4) throw new Error("invalid worker environment indentation");
  return { start, end, valueIndent };
}

function environmentEntry(line, indent) {
  const match = new RegExp(`^ {${indent}}([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*(.*?)\\s*$`).exec(line);
  return match ? { key: match[1], rawValue: match[2] } : null;
}

function environmentValues(lines, bounds, key, decode = true) {
  const values = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const entry = environmentEntry(lines[index], bounds.valueIndent);
    if (entry?.key === key) values.push(decode ? scalarValue(entry.rawValue) : entry.rawValue);
  }
  return values;
}

function withoutPolicyLines(lines, bounds, keys) {
  return lines.filter((line, index) => {
    if (index <= bounds.start || index >= bounds.end) return true;
    const entry = environmentEntry(line, bounds.valueIndent);
    return !entry || !keys.has(entry.key);
  });
}

function imageLines(lines) {
  return lines.filter((line) => /^\s+image\s*:/.test(line));
}

function volumeLines(lines) {
  const result = [];
  let inVolumes = false;
  for (const line of lines) {
    if (/^\s*volumes:\s*(?:#.*)?$/.test(line)) inVolumes = true;
    if (inVolumes) result.push(line);
  }
  return result;
}

function scalarValue(raw) {
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function submitOrPilotFlag(key) {
  return /(?:LIVE_SUBMIT|PILOT_ENABLED)$/.test(key);
}

function leadingSpaces(value) {
  return /^ */.exec(value)?.[0].length ?? 0;
}

function bool(value) {
  return value === "true" || value === "false";
}

function fullTicket(value) {
  return value === "full_ticket";
}

function positiveDecimal(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

function positiveInteger(value) {
  return /^[1-9]\d*$/.test(value);
}

function carryAssets(value) {
  return value === "BTC,ETH,SOL";
}
