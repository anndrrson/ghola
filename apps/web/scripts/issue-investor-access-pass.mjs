#!/usr/bin/env node
import { open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
const ACCESS_CODE = /^[A-Za-z0-9_-]{32,128}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:-]{16,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIERS = new Set(["starter", "private_agent"]);

export async function issueInvestorAccessPass(input) {
  const email = normalizeEmail(input.email);
  const tier = TIERS.has(input.tier) ? input.tier : null;
  const grantDays = boundedInteger(input.grantDays, 1, 90);
  const redeemDays = boundedInteger(input.redeemDays, 1, 30);
  const apiBase = secureOrigin(input.apiBase);
  const expectedWebOrigin = secureOrigin(input.expectedWebOrigin) === "https://ghola.xyz"
    ? "https://ghola.xyz"
    : null;
  const bearer = safeCredential(input.operatorBearer);
  const adminSecret = safeCredential(input.adminSecret, 32);
  const idempotencyKey = typeof input.idempotencyKey === "string" &&
    IDEMPOTENCY_KEY.test(input.idempotencyKey) ? input.idempotencyKey : null;
  const outPath = await safeNewOutputPath(input.outPath);
  if (!email || !tier || !grantDays || !redeemDays || !apiBase || !expectedWebOrigin ||
      !bearer || !adminSecret || !idempotencyKey || !outPath) {
    throw new Error("issuance_configuration_invalid");
  }

  const file = await open(outPath, "wx", 0o600);
  let saved = false;
  try {
    await file.chmod(0o600);
    const response = await input.fetchImpl(new URL("/api/billing/access-passes", apiBase), {
      method: "POST",
      headers: {
        authorization: "Bearer " + bearer,
        "content-type": "application/json",
        "x-ghola-admin-secret": adminSecret,
      },
      body: JSON.stringify({
        email,
        tier,
        grant_days: grantDays,
        redeem_days: redeemDays,
        idempotency_key: idempotencyKey,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) throw new Error("issuance_request_failed");
    const body = await response.json().catch(() => null);
    const invite = inspectInviteResponse(body, expectedWebOrigin);
    if (!invite || invite.tier !== tier || invite.grant_days !== grantDays) {
      throw new Error("issuance_response_invalid");
    }
    const artifact = {
      version: 2,
      pass_id: invite.pass_id,
      idempotency_key: idempotencyKey,
      email,
      tier: invite.tier,
      invite_url: invite.url,
      redeem_expires_at: invite.redeem_expires_at,
      grant_days: invite.grant_days,
      created_at: new Date().toISOString(),
    };
    await file.writeFile(JSON.stringify(artifact, null, 2) + "\n", { encoding: "utf8" });
    await file.sync();
    await file.chmod(0o600);
    saved = true;
    return {
      ok: true,
      out_path: outPath,
      pass_id: invite.pass_id,
      tier: invite.tier,
      redeem_expires_at: invite.redeem_expires_at,
      artifact_commitment_ready: true,
    };
  } finally {
    await file.close().catch(() => undefined);
    if (!saved) await unlink(outPath).catch(() => undefined);
  }
}

export function inspectInviteResponse(value, expectedWebOrigin) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !TIERS.has(value.tier) || !Number.isInteger(value.grant_days) ||
      value.grant_days < 1 || value.grant_days > 90 ||
      !canonicalIso(value.redeem_expires_at) || !UUID.test(value.pass_id) ||
      typeof value.invite_url !== "string") {
    return null;
  }
  let url;
  try {
    url = new URL(value.invite_url);
  } catch {
    return null;
  }
  const expectedOrigin = secureOrigin(expectedWebOrigin);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const codes = fragment.getAll("access");
  if (url.protocol !== "https:" || url.pathname !== "/account" || url.search ||
      !expectedOrigin || url.origin !== expectedOrigin ||
      codes.length !== 1 || !ACCESS_CODE.test(codes[0]) ||
      [...fragment.keys()].some((key) => key !== "access")) {
    return null;
  }
  return {
    url: url.href,
    pass_id: value.pass_id,
    tier: value.tier,
    redeem_expires_at: value.redeem_expires_at,
    grant_days: value.grant_days,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    process.stderr.write("Investor pass issuance: FAIL (invalid_arguments)\n");
    return 2;
  }
  if (options.help) {
    process.stdout.write([
      "Usage:",
      "  npm run issue:investor:pass -- --email <bound-email> --idempotency-key <stable-key> --out <new-file>",
      "    [--tier starter|private_agent] [--grant-days 1-90] [--redeem-days 1-30]",
      "",
      "Required environment:",
      "  GHOLA_THUMPER_API_BASE",
      "  GHOLA_OPERATOR_SESSION_TOKEN",
      "  GHOLA_INVESTOR_PASS_ADMIN_SECRET",
      "  GHOLA_INVESTOR_WEB_ORIGIN",
      "",
      "The invitation URL is written only to a newly created mode-0600 file.",
      "",
    ].join("\n"));
    return 0;
  }
  try {
    await issueInvestorAccessPass({
      ...options,
      apiBase: env.GHOLA_THUMPER_API_BASE || env.NEXT_PUBLIC_THUMPER_API_URL,
      operatorBearer: env.GHOLA_OPERATOR_SESSION_TOKEN,
      adminSecret: env.GHOLA_INVESTOR_PASS_ADMIN_SECRET,
      expectedWebOrigin: env.GHOLA_INVESTOR_WEB_ORIGIN,
      fetchImpl,
    });
    process.stdout.write("Investor pass issued and saved to a new mode-0600 file.\n");
    return 0;
  } catch {
    process.stderr.write("Investor pass issuance: FAIL (request_or_secure_write_failed)\n");
    return 1;
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null || value.startsWith("--") || values.has(key)) {
      throw new Error("invalid_arguments");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--email", "--idempotency-key", "--out", "--tier", "--grant-days", "--redeem-days",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key)) ||
      !values.has("--email") || !values.has("--idempotency-key") || !values.has("--out")) {
    throw new Error("invalid_arguments");
  }
  return {
    help: false,
    email: values.get("--email"),
    idempotencyKey: values.get("--idempotency-key"),
    outPath: values.get("--out"),
    tier: values.get("--tier") || "private_agent",
    grantDays: Number(values.get("--grant-days") || 14),
    redeemDays: Number(values.get("--redeem-days") || 7),
  };
}

async function safeNewOutputPath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
  const target = resolve(value);
  const parent = await realpath(dirname(target)).catch(() => null);
  return parent ? resolve(parent, basename(target)) : null;
}

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

function secureBaseUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function secureOrigin(value) {
  const url = secureBaseUrl(value);
  return url && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
}

function safeCredential(value, minimum = 16) {
  return typeof value === "string" && value.trim().length >= minimum &&
    !/[\r\n]/u.test(value) ? value.trim() : null;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function canonicalIso(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
