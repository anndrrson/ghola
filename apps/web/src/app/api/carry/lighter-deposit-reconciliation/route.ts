import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import {
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
  SESSION_COOKIE_NAME,
} from "@/app/api/auth/session/_lib";
import {
  assertLighterUdaCreateConfigured,
  LIGHTER_UDA_BASE_CHAIN_ID,
  LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS,
  LIGHTER_UDA_CHAIN_ID,
  LIGHTER_UDA_USDC_TOKEN_ADDRESS,
  readExactLighterUniversalDepositStatus,
  validatedLighterDepositExpectation,
} from "@/lib/lighter-universal-deposit-address.server";
import { gholaCommitment } from "@/lib/private-account";
import {
  getPrivateLighterDepositExpectation,
  recordObservedPrivateLighterDepositExpectation,
  requirePrivateLighterVerifiedDepositDestination,
} from "@/lib/private-account-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_KEYS = [
  "deposit_address",
  "expected_amount_microunits",
  "owner_address",
  "transaction_hash",
  "version",
];
const MAX_LEGACY_BOUND_TRANSACTION_AGE_MS = 15 * 60 * 1_000;
const MAX_FIRST_OBSERVATION_TRANSACTION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_TRANSACTION_SKEW_MS = 60 * 1_000;

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "lighter_uda_cross_site_rejected" }, 403);
  if (!isJson(req)) return json({ error: "lighter_uda_json_required" }, 415);
  const body = await readObject(req);
  if (!body || !exactKeys(body, BODY_KEYS) || body.version !== 1) {
    return json({ error: "lighter_uda_deposit_reconciliation_request_invalid" }, 400);
  }
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken) return json({ error: "lighter_uda_session_required" }, 401);
  const session = await verifiedSession(sessionToken);
  if (!session.ok) return json({ error: session.error }, session.status);

  let ownerAddress: `0x${string}`;
  let depositAddress: `0x${string}`;
  let transaction: ReturnType<typeof validatedLighterDepositExpectation>;
  try {
    ownerAddress = exactAddress(body.owner_address, "lighter_uda_owner_address_invalid");
    depositAddress = exactAddress(body.deposit_address, "lighter_uda_deposit_address_invalid");
    transaction = validatedLighterDepositExpectation({
      transactionHash: body.transaction_hash,
      expectedAmountBaseUnit: body.expected_amount_microunits,
    });
    assertLighterUdaCreateConfigured();
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_deposit_reconciliation_request_invalid");
  }

  const ownerCommitment = gholaCommitment("owner", session.userId);
  const walletCommitment = gholaCommitment("wallet", ownerAddress.toLowerCase());
  let existing: Awaited<ReturnType<typeof getPrivateLighterDepositExpectation>>;
  try {
    await requirePrivateLighterVerifiedDepositDestination({
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      destination_address: depositAddress,
    });
    existing = await getPrivateLighterDepositExpectation({
      owner_commitment: ownerCommitment,
      transaction_hash: transaction.transaction_hash,
    });
    if (
      existing &&
      existing.status !== "bound" &&
      (
        existing.wallet_commitment !== walletCommitment ||
        existing.owner_address.toLowerCase() !== ownerAddress.toLowerCase() ||
        existing.destination_address.toLowerCase() !== depositAddress.toLowerCase() ||
        existing.expected_amount_microunits !== transaction.expected_amount_base_unit
      )
    ) throw Object.assign(new Error("lighter_uda_deposit_expectation_conflict"), {
      code: "lighter_uda_deposit_expectation_conflict",
      status: 409,
    });
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_deposit_expectation_failed");
  }

  try {
    const provider = await readExactLighterUniversalDepositStatus({
      ownerAddress,
      depositAddress,
      transactionHash: transaction.transaction_hash,
      expectedAmountBaseUnit: transaction.expected_amount_base_unit,
    });
    if (!provider.observed || !provider.transaction) {
      if (existing && existing.status !== "bound") {
        throw Object.assign(new Error("lighter_uda_deposit_observation_regressed"), {
          code: "lighter_uda_deposit_observation_regressed",
          status: 502,
        });
      }
      return json({
        version: 1,
        expectation_id: gholaCommitment("lighter_deposit_expectation", {
          owner_commitment: ownerCommitment,
          transaction_hash: transaction.transaction_hash,
        }),
        observed: false,
        reconciliation_complete: false,
        poll_after_ms: 1_500,
        checked_at: new Date().toISOString(),
      }, 202);
    }
    const checkedAtMs = Date.now();
    const providerCreatedAtMs = provider.transaction.created_time_ms;
    const earliestAllowedAtMs = !existing
      ? checkedAtMs - MAX_FIRST_OBSERVATION_TRANSACTION_AGE_MS
      : existing.status === "bound"
        ? Date.parse(existing.created_at) - MAX_LEGACY_BOUND_TRANSACTION_AGE_MS
        : existing.provider_created_time_ms;
    if (
      earliestAllowedAtMs === null ||
      !Number.isFinite(earliestAllowedAtMs) ||
      providerCreatedAtMs < earliestAllowedAtMs ||
      providerCreatedAtMs > checkedAtMs + MAX_FUTURE_TRANSACTION_SKEW_MS ||
      (existing && existing.status !== "bound" &&
        providerCreatedAtMs !== existing.provider_created_time_ms)
    ) {
      throw Object.assign(new Error("lighter_uda_deposit_historic_transaction_rejected"), {
        code: "lighter_uda_deposit_historic_transaction_rejected",
        status: 409,
      });
    }
    const observed = await recordObservedPrivateLighterDepositExpectation({
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      transaction_hash: transaction.transaction_hash,
      destination_address: depositAddress,
      expected_amount_microunits: transaction.expected_amount_base_unit,
      provider_status: provider.transaction.status,
      provider_created_time_ms: providerCreatedAtMs,
      now: new Date(),
    });
    const status = observed.status === "completed" ? "COMPLETED" : "PROCESSING";
    return json({
      version: 1,
      expectation_id: observed.expectation_id,
      owner_address: observed.owner_address,
      deposit_address: observed.destination_address,
      transaction_hash: observed.transaction_hash,
      expected_amount_microunits: observed.expected_amount_microunits,
      source: {
        chain_id: Number(LIGHTER_UDA_BASE_CHAIN_ID),
        token_address: LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS,
      },
      destination: {
        to_chain_id: LIGHTER_UDA_CHAIN_ID,
        to_token_address: LIGHTER_UDA_USDC_TOKEN_ADDRESS,
      },
      observed: true,
      status,
      reconciliation_complete: status === "COMPLETED",
      provider_created_time_ms: observed.provider_created_time_ms,
      checked_at: new Date().toISOString(),
    }, 200);
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_deposit_reconciliation_failed");
  }
}

function exactAddress(value: unknown, code: string): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw Object.assign(new Error(code), { code, status: 400 });
  }
  return getAddress(value);
}

async function verifiedSession(token: string): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string; status: number }
> {
  try {
    const session = await fetchSessionUser(token);
    if (session.ok) return { ok: true, userId: session.user.id };
    return session.status === 401 || session.status === 403
      ? { ok: false, error: "lighter_uda_session_invalid", status: 401 }
      : { ok: false, error: "lighter_uda_session_unavailable", status: 503 };
  } catch {
    return { ok: false, error: "lighter_uda_session_unavailable", status: 503 };
  }
}

function isJson(req: Request) {
  return req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 16_384) return null;
  const value = await req.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(body: Record<string, unknown>, keys: string[]) {
  return Object.keys(body).sort().join("\n") === [...keys].sort().join("\n");
}

function knownFailure(caught: unknown, fallback: string) {
  const failure = caught as { code?: unknown; status?: unknown };
  const code = typeof failure.code === "string" && /^lighter_uda_[a-z0-9_]{3,100}$/.test(failure.code)
    ? failure.code
    : fallback;
  const status = typeof failure.status === "number" && failure.status >= 400 && failure.status <= 599
    ? failure.status
    : 500;
  return json({ error: code }, status);
}

function json(body: unknown, status: number) {
  return applyNoStore(NextResponse.json(body, { status }));
}
