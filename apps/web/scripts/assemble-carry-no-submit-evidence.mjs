#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CARRY_NO_SUBMIT_EVIDENCE_PATH,
  verifyCarryNoSubmitEvidence,
} from "./verify-carry-no-submit-evidence.mjs";

const REQUIRED_FLAGS = Object.freeze([
  "--request",
  "--response",
  "--preview-url",
  "--web-commit-sha",
  "--worker-image-digest",
]);

export function parseCarryNoSubmitAssemblyArgs(args) {
  const values = new Map();
  const allowed = new Set([...REQUIRED_FLAGS, "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag)) throw new Error(`carry_no_submit_assembly_argument_invalid:${flag || "missing"}`);
    if (!value || value.startsWith("--")) throw new Error(`carry_no_submit_assembly_value_missing:${flag}`);
    if (values.has(flag)) throw new Error(`carry_no_submit_assembly_argument_duplicate:${flag}`);
    values.set(flag, value);
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!values.has(flag)) throw new Error(`carry_no_submit_assembly_argument_missing:${flag}`);
  }
  return Object.freeze({
    requestPath: values.get("--request"),
    responsePath: values.get("--response"),
    previewUrl: values.get("--preview-url"),
    webCommitSha: values.get("--web-commit-sha"),
    workerImageDigest: values.get("--worker-image-digest"),
    outputPath: values.get("--output") || DEFAULT_CARRY_NO_SUBMIT_EVIDENCE_PATH,
  });
}

export async function assembleCarryNoSubmitEvidenceFile({
  requestPath,
  responsePath,
  previewUrl,
  webCommitSha,
  workerImageDigest,
  outputPath = DEFAULT_CARRY_NO_SUBMIT_EVIDENCE_PATH,
  signerPublicKeysB64 = signerPins(process.env),
  sharedSecret = workerSecret(process.env),
}, dependencies = {}) {
  const resolvedRequest = resolve(String(requestPath || ""));
  const resolvedResponse = resolve(String(responsePath || ""));
  const resolvedOutput = resolve(String(outputPath || ""));
  if (!requestPath || !responsePath) throw new Error("carry_no_submit_assembly_input_missing");
  if (resolvedRequest === resolvedResponse) throw new Error("carry_no_submit_assembly_input_duplicate");
  if ([resolvedRequest, resolvedResponse].includes(resolvedOutput)) {
    throw new Error("carry_no_submit_assembly_output_overlaps_input");
  }
  const read = dependencies.readFile || readFile;
  const verify = dependencies.verify || verifyCarryNoSubmitEvidence;
  const request = sanitizeRequest(await readJson(resolvedRequest, read, "request"));
  const response = await readJson(resolvedResponse, read, "response");
  const capturedAtMs = response?.private_prime_readiness?.checked_at_ms;
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs <= 0) {
    throw new Error("carry_no_submit_assembly_capture_time_missing");
  }
  const evidence = {
    version: 1,
    kind: "ghola_three_venue_no_submit_proof",
    network: "mainnet",
    captured_at_ms: capturedAtMs,
    source: {
      preview_url: previewUrl,
      web_commit_sha: webCommitSha,
      worker_image_digest: workerImageDigest,
    },
    request,
    response,
  };
  const verified = verify(evidence, {
    expected_preview_url: previewUrl,
    expected_web_commit_sha: webCommitSha,
    expected_worker_image_digest: workerImageDigest,
    expected_signer_public_keys_b64: signerPublicKeysB64,
    shared_secret: sharedSecret,
    now_ms: capturedAtMs,
  });
  if (verified?.ok !== true || verified.evidence_commitment !== response?.private_prime_readiness?.evidence_commitment) {
    throw new Error("carry_no_submit_assembly_verification_invalid");
  }
  await atomicWriteJson(resolvedOutput, evidence, dependencies);
  return Object.freeze({ output_path: resolvedOutput, evidence, verified });
}

function sanitizeRequest(value) {
  const venueAccess = record(value?.venue_access);
  const sanitizedAccess = {};
  for (const venueId of ["hyperliquid", "lighter", "aster"]) {
    const access = record(venueAccess[venueId]);
    const sanitized = {
      account_commitment: string(access.account_commitment),
      vault_commitment: string(access.vault_commitment),
      policy_commitment: string(access.policy_commitment),
    };
    if (Object.values(sanitized).some((item) => item.length === 0)) {
      throw new Error(`carry_no_submit_assembly_access_missing:${venueId}`);
    }
    sanitizedAccess[venueId] = sanitized;
  }
  const request = {
    version: value?.version,
    owner_commitment: string(value?.owner_commitment),
    operation_class: string(value?.operation_class),
    work_order_commitment: string(value?.work_order_commitment),
    asset: string(value?.asset),
    notional_usd: value?.notional_usd,
    horizon_days: value?.horizon_days,
    venue_access: sanitizedAccess,
  };
  if (request.version !== 1
    || request.operation_class !== "matrix_no_submit"
    || !request.owner_commitment
    || !request.work_order_commitment
    || !request.asset) {
    throw new Error("carry_no_submit_assembly_request_invalid");
  }
  return request;
}

async function readJson(path, read, label) {
  let serialized;
  try {
    serialized = await read(path, "utf8");
  } catch {
    throw new Error(`carry_no_submit_assembly_${label}_unreadable:${path}`);
  }
  try {
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`carry_no_submit_assembly_${label}_json_invalid:${path}`);
  }
}

async function atomicWriteJson(outputPath, value, dependencies) {
  const makeDirectory = dependencies.mkdir || mkdir;
  const write = dependencies.writeFile || writeFile;
  const move = dependencies.rename || rename;
  const remove = dependencies.unlink || unlink;
  await makeDirectory(dirname(outputPath), { recursive: true });
  const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await write(temporaryPath, `${JSON.stringify(canonicalValue(value), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await move(temporaryPath, outputPath);
  } catch (error) {
    await remove(temporaryPath).catch(() => {});
    throw error;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]));
}

function signerPins(env) {
  return String(env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function workerSecret(env) {
  const primary = String(env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET || "").trim();
  const legacy = String(env.GHOLA_WORKER_CAPABILITY_SECRET || "").trim();
  if (primary && legacy && primary !== legacy) throw new Error("worker_capability_secret_alias_mismatch");
  return primary || legacy;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" ? value : "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assembleCarryNoSubmitEvidenceFile(parseCarryNoSubmitAssemblyArgs(process.argv.slice(2)))
    .then((result) => console.log(`[carry-no-submit-evidence] assembled ${result.verified.evidence_commitment} -> ${result.output_path}`))
    .catch((error) => {
      console.error(`[carry-no-submit-evidence] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
