#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildWorkerPolicy,
  parseEnvText,
  patchWorkerCompose,
  validateComposePatch,
  workerImage,
} from "./lib/phala-compose-policy-patch.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
if (!args.cvm) usage("Missing --cvm <existing-cvm-name-or-id>");
if (!args.webEnv) usage("Missing --web-env <vercel-production.env>");
if (!existsSync(args.webEnv)) fail(`Web environment file does not exist: ${args.webEnv}`);
if (args.apply && (!args.expectedCvmId || !args.expectedComposeHash)) {
  usage("--apply requires --expected-cvm-id and --expected-compose-hash");
}
if (args.expectedComposeHash && !/^[0-9a-f]{64}$/i.test(args.expectedComposeHash)) {
  usage("--expected-compose-hash must be a 64-character SHA-256 hex digest");
}

try {
  const sdk = await loadSdk(args.sdk);
  const credentials = loadCredentials(args.credentials);
  const client = sdk.createClient({
    apiKey: credentials.apiKey,
    ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
  });
  const webEnv = {
    ...process.env,
    ...parseEnvText(readFileSync(args.webEnv, "utf8")),
  };
  const { policy, sources } = buildWorkerPolicy(webEnv);
  const current = await fetchCurrent(client, sdk, args.cvm);
  const encryptedEnv = await encryptedEnvEvidence(client, sdk, current);
  const prepared = preparePatch(sdk, current, policy);
  const healthUrl = await resolveHealthUrl(client, args, current.id);
  const preflightHealth = await checkHealth(healthUrl);

  if (!args.apply) {
    printResult({
      ok: true,
      mode: "dry_run",
      mutates_cloud: false,
      ...summary(current, prepared, encryptedEnv, sources),
      health_url: healthUrl,
      current_health_ready: preflightHealth.ready,
      apply_guard: {
        expected_cvm_id: current.id,
        expected_compose_hash: current.composeHash,
      },
    });
    process.exit(0);
  }

  if (!preflightHealth.ready) throw new Error(`existing worker health is not ready: ${preflightHealth.reason}`);
  assertExpectedTarget(current, args);
  const fresh = await fetchCurrent(client, sdk, current.id);
  assertExpectedTarget(fresh, args);
  if (fresh.appComposeFingerprint !== current.appComposeFingerprint) {
    throw new Error("CVM compose changed after inspection; rerun dry-run and review the new diff");
  }
  const freshPrepared = preparePatch(sdk, fresh, policy);
  const provision = await client.provisionCvmComposeFileUpdate(
    {
      id: fresh.id,
      app_compose: freshPrepared.desiredAppCompose,
      update_env_vars: false,
    },
    { schema: false },
  );
  const provisionedHash = stringField(provision, "compose_hash").toLowerCase();
  if (!provisionedHash || provisionedHash !== freshPrepared.desiredComposeHash) {
    throw new Error("Phala provisioned an unexpected compose hash; commit was not attempted");
  }
  const provisionedAppId = stringField(provision, "app_id").replace(/^app_/, "");
  if (provisionedAppId && provisionedAppId !== fresh.appId) {
    throw new Error("Phala provision targeted an unexpected app; commit was not attempted");
  }

  let verified = false;
  let health = { ready: false, reason: "compose_not_verified" };
  let commitError = null;
  try {
    await client.commitCvmComposeFileUpdate({
      id: fresh.id,
      compose_hash: provisionedHash,
      update_env_vars: false,
    });
    verified = await waitForCompose(client, sdk, fresh.id, provisionedHash, freshPrepared.desiredText);
    if (verified) health = await waitForHealth(healthUrl);
  } catch (error) {
    commitError = safeMessage(error);
  }
  if (!verified || !health.ready || commitError) {
    const rollback = await rollbackCompose(client, sdk, fresh, healthUrl);
    printResult({
      ok: false,
      mode: "apply",
      mutates_cloud: true,
      commit_accepted: !commitError,
      post_commit_compose_verified: verified,
      post_commit_health: health,
      commit_error: commitError,
      rollback,
      ...summary(fresh, freshPrepared, encryptedEnv, sources),
    });
    process.exitCode = 2;
    process.exit();
  }
  printResult({
    ok: true,
    mode: "apply",
    mutates_cloud: true,
    commit_accepted: true,
    verified: true,
    post_commit_health: health,
    ...summary(fresh, freshPrepared, encryptedEnv, sources),
  });
} catch (error) {
  fail(safeMessage(error));
}

function preparePatch(sdk, current, policy) {
  const patched = patchWorkerCompose(current.composeText, policy);
  validateComposePatch(current.composeText, patched.desired, patched.policy);
  const desiredAppCompose = {
    ...current.appCompose,
    docker_compose_file: patched.desired,
  };
  if (metadataFingerprint(current.appCompose) !== metadataFingerprint(desiredAppCompose)) {
    throw new Error("app-compose metadata changed unexpectedly");
  }
  const desiredComposeHash = String(sdk.getComposeHash(desiredAppCompose)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(desiredComposeHash)) throw new Error("desired compose hash is invalid");
  return {
    ...patched,
    desiredAppCompose,
    desiredComposeHash,
    desiredText: patched.desired,
  };
}

async function fetchCurrent(client, sdk, id) {
  const [infoValue, composeValue] = await Promise.all([
    client.getCvmInfo({ id }, { schema: false }),
    client.getCvmComposeFile({ id }, { schema: false }),
  ]);
  const info = record(infoValue, "CVM info");
  const appCompose = plainAppCompose(record(composeValue, "CVM app compose"));
  const composeText = stringField(appCompose, "docker_compose_file");
  if (!composeText) throw new Error("CVM docker compose is missing");
  const canonicalId = stringField(info, "id");
  const appId = stringField(info, "app_id").replace(/^app_/, "");
  const vmUuid = stringField(info, "vm_uuid");
  const composeHash = stringField(info, "compose_hash").toLowerCase();
  if (!canonicalId || !appId || !vmUuid || !/^[0-9a-f]{64}$/.test(composeHash)) {
    throw new Error("CVM identity or compose hash is incomplete");
  }
  const computedHash = String(sdk.getComposeHash(appCompose)).toLowerCase();
  if (computedHash !== composeHash) {
    throw new Error("CVM info and fetched app compose are not from the same revision");
  }
  return {
    id: canonicalId,
    name: stringField(info, "name") || id,
    appId,
    vmUuid,
    status: stringField(info, "status") || null,
    composeHash,
    composeText,
    appCompose,
    appComposeFingerprint: sha256(stableJson(appCompose)),
  };
}

async function encryptedEnvEvidence(client, sdk, current) {
  if (typeof sdk.getAppRevisions !== "function" || typeof sdk.getAppRevisionDetail !== "function") {
    throw new Error("installed @phala/cloud cannot inspect encrypted-env revision evidence");
  }
  const response = await sdk.getAppRevisions(client, {
    appId: current.appId,
    page: 1,
    page_size: 100,
  });
  const revisions = Array.isArray(response?.revisions)
    ? [...response.revisions].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    : [];
  for (const revision of revisions) {
    if (revision.app_id !== current.appId || revision.vm_uuid !== current.vmUuid) continue;
    const detail = await sdk.getAppRevisionDetail(client, {
      appId: current.appId,
      revisionId: revision.revision_id,
      rawComposeFile: true,
    });
    if (typeof detail?.encrypted_env === "string" && detail.encrypted_env.length > 0) {
      return {
        present: true,
        sourceRevision: revision.revision_id,
        fingerprint: sha256(detail.encrypted_env).slice(0, 16),
      };
    }
  }
  throw new Error("no encrypted environment revision was found; refusing a compose update");
}

async function waitForCompose(client, sdk, id, expectedHash, expectedText) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await fetchCurrent(client, sdk, id).catch(() => null);
    if (current?.composeHash === expectedHash && current.composeText === expectedText) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  return false;
}

async function rollbackCompose(client, sdk, prior, healthUrl) {
  try {
    const provision = await client.provisionCvmComposeFileUpdate(
      { id: prior.id, app_compose: prior.appCompose, update_env_vars: false },
      { schema: false },
    );
    const hash = stringField(provision, "compose_hash").toLowerCase();
    if (hash !== prior.composeHash) throw new Error("rollback provision hash mismatch");
    await client.commitCvmComposeFileUpdate({
      id: prior.id,
      compose_hash: hash,
      update_env_vars: false,
    });
    const composeRestored = await waitForCompose(client, sdk, prior.id, prior.composeHash, prior.composeText);
    const health = composeRestored ? await waitForHealth(healthUrl) : { ready: false, reason: "compose_not_restored" };
    return { attempted: true, compose_restored: composeRestored, health };
  } catch (error) {
    return { attempted: true, compose_restored: false, health: null, error: safeMessage(error) };
  }
}

async function resolveHealthUrl(client, input, cvmId) {
  if (input.healthUrl) return normalizedHealthUrl(input.healthUrl);
  const network = await client.getCvmNetwork({ id: cvmId }, { schema: false });
  const publicUrls = Array.isArray(network?.public_urls) ? network.public_urls : [];
  for (const candidate of publicUrls) {
    const value = typeof candidate === "string" ? candidate : candidate?.app;
    if (typeof value === "string" && value.startsWith("https://")) return normalizedHealthUrl(value);
  }
  throw new Error("worker health URL could not be discovered; pass --health-url");
}

function normalizedHealthUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("health URL must use HTTPS");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/health`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function checkHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) return { ready: false, reason: `http_${response.status}` };
    const body = await response.json();
    const ready = body?.ready === true && body?.attested === true &&
      body?.sealed_execution_required === true && body?.carry_supervision?.transaction_broadcast === false;
    return { ready, reason: ready ? null : "health_contract_failed" };
  } catch {
    return { ready: false, reason: "health_unreachable" };
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 90_000;
  let result = { ready: false, reason: "health_unreachable" };
  while (Date.now() < deadline) {
    result = await checkHealth(url);
    if (result.ready) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  return result;
}

function summary(current, prepared, encryptedEnv, sources) {
  return {
    existing_cvm_only: true,
    builds_or_images_created: false,
    cvm: {
      id: current.id,
      name: current.name,
      app_id: current.appId,
      status: current.status,
    },
    current_compose_hash: current.composeHash,
    desired_compose_hash: prepared.desiredComposeHash,
    image_preserved: workerImage(current.composeText),
    volumes_preserved: true,
    secret_placeholders_preserved: true,
    app_compose_metadata_preserved: true,
    encrypted_env_preserved: true,
    encrypted_env_update_mode: false,
    static_state_store_fields_preserved: true,
    encrypted_env_source_revision: encryptedEnv.sourceRevision,
    encrypted_env_fingerprint: encryptedEnv.fingerprint,
    changed_policy_fields: prepared.changed,
    policy: prepared.policy,
    policy_sources: sources,
  };
}

function assertExpectedTarget(current, input) {
  if (current.id !== input.expectedCvmId) throw new Error("CVM ID does not match --expected-cvm-id");
  if (current.composeHash !== input.expectedComposeHash.toLowerCase()) {
    throw new Error("compose hash does not match --expected-compose-hash; rerun dry-run");
  }
}

async function loadSdk(explicitPath) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (explicitPath) candidates.push(resolve(explicitPath));
  for (const base of [import.meta.url, pathToFileURL(join(here, "../apps/web/package.json")).href]) {
    try {
      candidates.push(createRequire(base).resolve("@phala/cloud"));
    } catch {
      // Continue to the next deterministic location.
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const sdk = await import(pathToFileURL(candidate).href);
    if (typeof sdk.createClient === "function" && typeof sdk.getComposeHash === "function") return sdk;
  }
  throw new Error("@phala/cloud is unavailable; install web dependencies or pass --sdk <dist/index.js>");
}

function loadCredentials(explicitPath) {
  if (process.env.PHALA_CLOUD_API_KEY?.trim()) {
    return {
      apiKey: process.env.PHALA_CLOUD_API_KEY.trim(),
      baseURL: process.env.PHALA_CLOUD_API_PREFIX?.trim() || undefined,
    };
  }
  const path = resolve(explicitPath || join(homedir(), ".phala-cloud", "credentials.json"));
  if (!existsSync(path)) throw new Error("Phala credentials are unavailable");
  const document = JSON.parse(readFileSync(path, "utf8"));
  const profile = document?.profiles?.[document?.current_profile];
  const apiKey = typeof profile?.token === "string" ? profile.token.trim() : "";
  if (!apiKey) throw new Error("active Phala profile has no API token");
  return {
    apiKey,
    baseURL: typeof profile?.api_prefix === "string" ? profile.api_prefix.trim() : undefined,
  };
}

function plainAppCompose(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => typeof child !== "function"));
}

function metadataFingerprint(appCompose) {
  return sha256(stableJson(Object.fromEntries(
    Object.entries(appCompose).filter(([key]) => key !== "docker_compose_file"),
  )));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function stringField(value, key) {
  return value && typeof value === "object" && typeof value[key] === "string" ? value[key].trim() : "";
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

function printResult(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    credentials: "",
    cvm: "",
    expectedComposeHash: "",
    expectedCvmId: "",
    help: false,
    healthUrl: "",
    sdk: "",
    webEnv: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--credentials") parsed.credentials = argv[++index] || "";
    else if (arg === "--cvm") parsed.cvm = argv[++index] || "";
    else if (arg === "--expected-compose-hash") parsed.expectedComposeHash = argv[++index] || "";
    else if (arg === "--expected-cvm-id") parsed.expectedCvmId = argv[++index] || "";
    else if (arg === "--health-url") parsed.healthUrl = argv[++index] || "";
    else if (arg === "--sdk") parsed.sdk = argv[++index] || "";
    else if (arg === "--web-env") parsed.webEnv = argv[++index] || "";
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else usage(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(error = "") {
  if (error) console.error(error);
  console.error([
    "Usage:",
    "  node scripts/patch-existing-phala-carry-policy.mjs --cvm <existing-cvm> --web-env <production.env>",
    "  node scripts/patch-existing-phala-carry-policy.mjs --cvm <existing-cvm> --web-env <production.env> --expected-cvm-id <cvm_id> --expected-compose-hash <sha256> --apply",
    "",
    "Default mode is read-only. --apply updates only the named existing CVM compose.",
    "It never builds or changes an image, commits with update_env_vars=false, verifies /health, and rolls back on failure.",
  ].join("\n"));
  process.exit(error ? 1 : 0);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}
