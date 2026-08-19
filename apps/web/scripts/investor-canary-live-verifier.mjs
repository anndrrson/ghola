#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";
import {
  HYPERLIQUID_MAINNET_INFO_URL,
  PRODUCTION_THUMPER_ORIGIN,
  PRODUCTION_WEB_ORIGIN,
  WORKER_IMAGE_REPOSITORY,
  WORKER_PROVENANCE_REPOSITORY,
  WORKER_PROVENANCE_WORKFLOW,
  verifyLiveInvestorCanary,
} from "./investor-canary-live-verifier-lib.mjs";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const SANITIZED_REPORT_KEYS = new Set([
  "version", "status", "checked_at", "machine_evidence", "authoritative_sources_only", "release",
  "contract_version", "web_git_sha", "worker_git_sha", "worker_image_digest", "config_fingerprint",
  "release_commitment", "investors", "label", "subject_commitment", "account_commitment",
  "vault_commitment", "graduation_completed_at", "terminal_filled_entries",
  "reduce_only_filled_closes", "latest_venue_fill_at", "evidence_commitment", "checks", "id", "ok",
  "failure", "human_attestation", "scope", "investor_count", "latest_observed_at", "statement",
  "protection_orders_canceled", "operational_attestation", "rollback_artifact_commitment",
  "prior_release_artifact_commitment", "incident_owner_commitment", "kill_control_commitment",
  "reduce_only_recovery_commitment", "operator_email_commitment_count", "prepared_at",
  "restart_receipt_commitment", "restart_replay_observed_at",
  "registry_build_provenance_verified", "build_provenance_commitment",
]);

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && ["-h", "--help"].includes(argv[0])) {
    process.stdout.write(usage());
    return 0;
  }
  if (argv.length !== 0) {
    process.stderr.write("Investor canary acceptance: NO-GO (arguments_not_allowed)\n");
    return 2;
  }
  try {
    const config = configFromEnv(env);
    const source = runtimeSource(config);
    const report = await verifyLiveInvestorCanary({ source, config });
    if (!sanitizedReport(report)) throw new Error("unsafe acceptance report");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`Investor canary acceptance: ${report.status}\n`);
    return report.status === "GO" ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      version: 1,
      status: "NO-GO",
      machine_evidence: {
        authoritative_sources_only: true,
        release: null,
        investors: [],
        checks: [{ id: "runtime.configuration", ok: false, failure: "runtime_configuration_or_source_invalid" }],
      },
      human_attestation: null,
      operational_attestation: null,
    }, null, 2)}\n`);
    process.stderr.write("Investor canary acceptance: NO-GO\n");
    return 1;
  }
}

export function configFromEnv(env) {
  const startedAt = required(env, "GHOLA_INVESTOR_ACCEPTANCE_STARTED_AT");
  const humanPath = resolve(required(env, "GHOLA_INVESTOR_ACCEPTANCE_HUMAN_FILE"));
  const operationsPath = resolve(required(env, "GHOLA_INVESTOR_ACCEPTANCE_OPERATIONS_FILE"));
  const githubToken = required(env, "GHOLA_INVESTOR_ACCEPTANCE_GITHUB_TOKEN");
  const mainDatabaseUrl = productionDatabaseUrl(required(env, "GHOLA_INVESTOR_ACCEPTANCE_MAIN_DATABASE_URL"));
  const workerDatabaseUrl = productionDatabaseUrl(required(env, "GHOLA_INVESTOR_ACCEPTANCE_WORKER_DATABASE_URL"));
  const investors = ["A", "B"].map((label) => ({
    label,
    token: required(env, `GHOLA_INVESTOR_${label}_SESSION_TOKEN`),
    accountAddress: evmAddress(required(env, `GHOLA_INVESTOR_${label}_HYPERLIQUID_ACCOUNT`)),
  }));
  return { startedAt, humanPath, operationsPath, githubToken, mainDatabaseUrl, workerDatabaseUrl, investors };
}

export function runtimeSource(config, fetchImpl = globalThis.fetch) {
  const mainSql = neon(config.mainDatabaseUrl);
  const workerSql = neon(config.workerDatabaseUrl);
  return {
    async getPublicStatus() {
      return fetchJson(fetchImpl, `${PRODUCTION_WEB_ORIGIN}/v1/private-account/live-trading/status`);
    },
    async getOperationalReadiness() {
      return fetchReadinessJson(fetchImpl, `${PRODUCTION_WEB_ORIGIN}/api/health/ready`);
    },
    async getWorkerBuildProvenance({ release }) {
      const artifact = `oci://${WORKER_IMAGE_REPOSITORY}@${release.worker_image_digest}`;
      const { stdout } = await execFileAsync("gh", [
        "attestation", "verify", artifact,
        "--repo", WORKER_PROVENANCE_REPOSITORY,
        "--signer-workflow", WORKER_PROVENANCE_WORKFLOW,
        "--source-digest", release.worker_git_sha,
        "--deny-self-hosted-runners",
        "--format", "json",
      ], {
        env: provenanceEnvironment(config.githubToken),
        timeout: 30_000,
        maxBuffer: MAX_JSON_BYTES,
      });
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("worker provenance response invalid");
      return parsed;
    },
    async getProfile(token) {
      return fetchJson(fetchImpl, `${PRODUCTION_THUMPER_ORIGIN}/api/user/profile`, token);
    },
    async getBilling(token) {
      return fetchJson(fetchImpl, `${PRODUCTION_WEB_ORIGIN}/api/billing/status`, token);
    },
    async getTerminalAccess(token) {
      return fetchJson(fetchImpl, `${PRODUCTION_WEB_ORIGIN}/v1/private-account/live-trading/terminal-access`, token);
    },
    async getMainReleaseEvidence() {
      const [rows, clock] = await Promise.all([
        mainSql`SELECT control FROM live_trading_launch_control WHERE control_id = 'global' LIMIT 1`,
        mainSql`SELECT clock_timestamp() AS database_clock`,
      ]);
      return {
        control: dbJson(rows[0]?.control),
        database_clock: iso(clock[0]?.database_clock),
      };
    },
    async getMainInvestorEvidence({ ownerCommitment, startedAt }) {
      const accounts = await mainSql`
        SELECT owner_commitment, account_commitment, vault_ready, account, created_at, updated_at
        FROM private_account_accounts
        WHERE owner_commitment = ${ownerCommitment}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const accountCommitment = accounts[0]?.account_commitment;
      if (!accountCommitment) return { accounts: [], vaults: [], graduations: [], reconciliations: [], reservations: [] };
      const [vaultRows, graduationRows, reconciliationRows, reservationRows] = await Promise.all([
        mainSql`
          SELECT owner_commitment, account_commitment, vault_commitment,
            encrypted_vault_commitment, recipient_commitment, policy_commitment,
            status, vault, created_at, updated_at
          FROM private_account_hyperliquid_vaults
          WHERE owner_commitment = ${ownerCommitment} AND account_commitment = ${accountCommitment}
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        mainSql`
          SELECT graduation
          FROM live_trading_account_graduations
          WHERE owner_commitment = ${ownerCommitment} AND account_commitment = ${accountCommitment}
            AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        mainSql`
          SELECT record
          FROM live_trading_work_order_reconciliations
          WHERE owner_commitment = ${ownerCommitment} AND account_commitment = ${accountCommitment}
            AND updated_at >= ${startedAt}
          ORDER BY updated_at ASC
        `,
        mainSql`
          SELECT reservation
          FROM live_trading_notional_reservations
          WHERE owner_commitment = ${ownerCommitment} AND account_commitment = ${accountCommitment}
            AND updated_at >= ${startedAt}
          ORDER BY updated_at ASC
        `,
      ]);
      return {
        accounts: accounts.map(dbRow),
        vaults: vaultRows.map(dbRow),
        graduations: graduationRows.map((row) => dbJson(row.graduation)),
        reconciliations: reconciliationRows.map((row) => dbJson(row.record)),
        reservations: reservationRows.map((row) => dbJson(row.reservation)),
      };
    },
    async getWorkerInvestorEvidence({ ownerCommitment, accountCommitment }) {
      const [claims, attempts, idempotency, clock] = await Promise.all([
        workerSql`
          SELECT work_order_commitment, status, claim_json, attempt_json, receipt_json, created_at, updated_at
          FROM worker_execution_claims
          WHERE claim_json #>> '{context,owner_commitment}' = ${ownerCommitment}
            AND claim_json #>> '{context,account_commitment}' = ${accountCommitment}
          ORDER BY created_at ASC
        `,
        workerSql`
          SELECT attempt.work_order_commitment, attempt.attempt_json, attempt.status, attempt.updated_at
          FROM worker_execution_attempts AS attempt
          JOIN worker_execution_claims AS claim USING (work_order_commitment)
          WHERE claim.claim_json #>> '{context,owner_commitment}' = ${ownerCommitment}
            AND claim.claim_json #>> '{context,account_commitment}' = ${accountCommitment}
        `,
        workerSql`
          SELECT cached.work_order_commitment, cached.receipt_json, cached.updated_at
          FROM worker_idempotency AS cached
          JOIN worker_execution_claims AS claim USING (work_order_commitment)
          WHERE claim.claim_json #>> '{context,owner_commitment}' = ${ownerCommitment}
            AND claim.claim_json #>> '{context,account_commitment}' = ${accountCommitment}
        `,
        workerSql`SELECT clock_timestamp() AS database_clock`,
      ]);
      return {
        claims: claims.map(dbRow),
        attempts: attempts.map(dbRow),
        idempotency: idempotency.map(dbRow),
        database_clock: iso(clock[0]?.database_clock),
      };
    },
    async getVenueEvidence({ accountAddress, refs }) {
      const post = (body) => fetchJson(fetchImpl, HYPERLIQUID_MAINNET_INFO_URL, null, body);
      const [role, clearinghouse, spot, openOrders, frontendOpenOrders, extraAgents, fills, historicalOrders, orderStatuses] =
        await Promise.all([
          post({ type: "userRole", user: accountAddress }),
          post({ type: "clearinghouseState", user: accountAddress }),
          post({ type: "spotClearinghouseState", user: accountAddress }),
          post({ type: "openOrders", user: accountAddress }),
          post({ type: "frontendOpenOrders", user: accountAddress }),
          post({ type: "extraAgents", user: accountAddress }),
          post({ type: "userFills", user: accountAddress, aggregateByTime: false }),
          post({ type: "historicalOrders", user: accountAddress }),
          Promise.all(refs.map((ref) => post({
            type: "orderStatus",
            user: accountAddress,
            oid: ref.oid || ref.cloid,
          }))),
        ]);
      return {
        role, clearinghouse, spot, openOrders, frontendOpenOrders, extraAgents,
        fills, historicalOrders, orderStatuses,
      };
    },
    async getHumanAttestation() {
      return readProtectedJson(config.humanPath, 16_384);
    },
    async getOperationsEvidence() {
      return readProtectedJson(config.operationsPath, 16_384);
    },
  };
}

async function fetchJson(fetchImpl, url, token = null, body = null) {
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    redirect: "error",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("authoritative source rejected request");
  const text = await response.text();
  if (!text || text.length > MAX_JSON_BYTES) throw new Error("authoritative source response invalid");
  const parsed = JSON.parse(text);
  if (parsed == null) throw new Error("authoritative source response invalid");
  return parsed;
}

async function fetchReadinessJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (![200, 503].includes(response.status)) throw new Error("readiness source rejected request");
  const text = await response.text();
  if (!text || text.length > MAX_JSON_BYTES) throw new Error("readiness source response invalid");
  const parsed = JSON.parse(text);
  if (parsed == null) throw new Error("readiness source response invalid");
  return parsed;
}

async function readProtectedJson(path, maxBytes) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600 ||
        metadata.size < 40 || metadata.size > maxBytes) throw new Error("invalid protected evidence file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function dbRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    key.endsWith("_json") || key === "account" || key === "vault" ? dbJson(value) : value instanceof Date ? value.toISOString() : value]));
}

function dbJson(value) {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : String(value || "");
}

function required(env, name) {
  const value = env[name]?.trim() || "";
  if (!value) throw new Error("required environment unavailable");
  return value;
}

function productionDatabaseUrl(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    throw new Error("production database URL invalid");
  }
  return value;
}

function evmAddress(value) {
  const address = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(address)) throw new Error("Hyperliquid account invalid");
  return address;
}

function provenanceEnvironment(githubToken) {
  const inherited = Object.fromEntries([
    "PATH", "HOME", "XDG_CONFIG_HOME", "DOCKER_CONFIG", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  return { ...inherited, GH_TOKEN: githubToken };
}

export function sanitizedReport(value) {
  const forbiddenKey = /^(?:email|token|session_token|account_address|wallet_address|agent_address|oid|cloid|order_id|transaction_hash|ciphertext|signature|database_url)$/iu;
  const visit = (item) => {
    if (Array.isArray(item)) return item.every(visit);
    if (item && typeof item === "object") {
      return Object.entries(item).every(([key, child]) =>
        SANITIZED_REPORT_KEYS.has(key) && !forbiddenKey.test(key) && visit(child));
    }
    if (typeof item !== "string") return true;
    return !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(item) &&
      !/\b0x[0-9a-f]{40}(?:[0-9a-f]{24})?\b/iu.test(item) &&
      !/authorization:\s*bearer/iu.test(item);
  };
  return visit(value);
}

function usage() {
  return [
    "Usage: npm run verify:investor:canary:live",
    "",
    "No arguments or evidence dossiers are accepted. Required environment:",
    "  GHOLA_INVESTOR_ACCEPTANCE_STARTED_AT",
    "  GHOLA_INVESTOR_ACCEPTANCE_MAIN_DATABASE_URL",
    "  GHOLA_INVESTOR_ACCEPTANCE_WORKER_DATABASE_URL",
    "  GHOLA_INVESTOR_ACCEPTANCE_HUMAN_FILE (owned mode-0600 human observations only)",
    "  GHOLA_INVESTOR_ACCEPTANCE_OPERATIONS_FILE (owned mode-0600 release operations attestation)",
    "  GHOLA_INVESTOR_ACCEPTANCE_GITHUB_TOKEN (read-only repo/package attestation access)",
    "  GHOLA_INVESTOR_A_SESSION_TOKEN / GHOLA_INVESTOR_B_SESSION_TOKEN",
    "  GHOLA_INVESTOR_A_HYPERLIQUID_ACCOUNT / GHOLA_INVESTOR_B_HYPERLIQUID_ACCOUNT",
    "",
    `Pinned sources: ${PRODUCTION_WEB_ORIGIN}, ${PRODUCTION_THUMPER_ORIGIN}, Hyperliquid mainnet`,
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
