import {
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
} from "@/lib/live-trading-contract";
import {
  HyperliquidAgentAuthorizationError,
  assertHyperliquidAgentVaultBinding,
  preflightHyperliquidMasterAccount,
  verifyAndSubmitHyperliquidAgentAuthorization,
} from "@/lib/hyperliquid-agent-wallet.server";
import {
  verifyHyperliquidAgentVaultWithWorker,
  verifyLegacyHyperliquidAgentRevokedWithWorker,
} from "@/lib/hyperliquid-agent-wallet-worker.server";
import { hyperliquidVaultIdentityCommitments } from "@/lib/hyperliquid-vault-seal";
import { paidLiveTradingEntitlement } from "@/lib/live-trading-opening-access.server";
import { getLiveTradingLaunchControl } from "@/lib/live-trading-store";
import {
  consumeConsumerRateLimit,
} from "@/lib/consumer-production-store";
import {
  getHyperliquidExecutionVaultByAccount,
  getLatestVenueEligibilityByAccount,
} from "@/lib/private-account-store";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountOwnerFromRequest,
  privateAccountSessionTokenFromRequest,
  readJson,
  revokeHyperliquidVaultForOwner,
  sealHyperliquidVaultFromBody,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request) {
  const context = await onboardingContext(request);
  if (context instanceof Response) return context;
  const body = await readJson(request);
  const accountAddress = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).account_address
    : null;
  try {
    const preflight = await preflightHyperliquidMasterAccount(
      typeof accountAddress === "string" ? accountAddress : "",
    );
    return json({
      version: 1,
      ready: true,
      role: preflight.role,
      funded: preflight.available_value_usd >= 12,
      flat: preflight.flat,
      open_order_count: preflight.open_order_count,
      frontend_open_order_count: preflight.frontend_open_order_count,
    });
  } catch (error) {
    return authorizationError(error);
  }
}

export async function POST(request: Request) {
  const context = await onboardingContext(request, { signedRequestPending: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  try {
    const verified = await verifyAndSubmitHyperliquidAgentAuthorization({
      body,
      accountCommitment: context.account.account_commitment,
      requireEncryptedVault: true,
    });
    const scope = assertHyperliquidAgentVaultBinding({
      aad: verified.request.encrypted_execution_vault.aad,
      recipient: verified.request.encrypted_execution_vault.recipient,
      accountCommitment: context.account.account_commitment,
      masterAddress: verified.authorization.account_address,
      agentAddress: verified.authorization.agent_address,
    });
    const workerVerification = await verifyHyperliquidAgentVaultWithWorker({
      request: verified.request,
      accountCommitment: context.account.account_commitment,
      authorization: verified.authorization,
    });
    const sealed = await sealHyperliquidVaultFromBody({
      encrypted_execution_vault: verified.request.encrypted_execution_vault,
    }, context.owner, {
      authorization: {
        version: 1,
        source: "phantom_approve_agent_v1",
        network: "mainnet",
        agent_name: "ghola-mainnet",
        venue_account_commitment: scope.venue_account_commitment!,
        agent_wallet_commitment: scope.agent_wallet_commitment!,
        valid_until: new Date(verified.authorization.valid_until_ms).toISOString(),
        approve_nonce: verified.authorization.approve_nonce,
        verified_at: new Date().toISOString(),
        worker_verification_commitment: workerVerification.verification_commitment,
        worker_verified_at: workerVerification.checked_at,
        worker_contract_version: workerVerification.worker_contract_version,
        worker_git_sha: workerVerification.worker_git_sha,
        worker_image_digest: workerVerification.worker_image_digest,
        worker_config_fingerprint: workerVerification.config_fingerprint,
      },
    });
    if ("error" in sealed) {
      throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_vault_storage_state_unknown", 503);
    }
    return json({
      ...sealed,
      venue_authorization: {
        status: "verified_worker_bound",
        worker_verification_commitment: workerVerification.verification_commitment,
        valid_until: new Date(verified.authorization.valid_until_ms).toISOString(),
        recovered_existing_authorization: verified.authorization.recovered_existing_authorization,
      },
    }, 201);
  } catch (error) {
    return authorizationError(error);
  }
}

export async function DELETE(request: Request) {
  const context = await onboardingContext(request, {
    riskReduction: true,
    signedRequestPending: true,
  });
  if (context instanceof Response) return context;
  const current = await getHyperliquidExecutionVaultByAccount(context.account.account_commitment);
  if (!current || current.status !== "sealed" ||
      current.owner_commitment !== context.owner.owner_commitment ||
      current.account_commitment !== context.account.account_commitment) {
    return json({ error: "hyperliquid_execution_vault_not_found" }, 404);
  }
  if (current.vault.authorization?.source !== "phantom_approve_agent_v1") {
    const encrypted = current.vault.encrypted_execution_vault;
    try {
      const proof = await verifyLegacyHyperliquidAgentRevokedWithWorker({
        accountCommitment: context.account.account_commitment,
        encryptedExecutionVault: {
          alg: encrypted.alg,
          ciphertext: encrypted.ciphertext,
          recipient: encrypted.recipient,
          aad: encrypted.aad,
        },
      });
      const revoked = await revokeHyperliquidVaultForOwner(context.owner, {
        expectedVaultCommitment: current.vault_commitment,
      });
      if ("error" in revoked) {
        return json({ error: revoked.error },
          revoked.error === "hyperliquid_execution_vault_state_changed" ? 409 : 404);
      }
      return json({
        ...revoked,
        venue_authorization: {
          status: "verified_absent",
          verification_commitment: proof.verification_commitment,
          checked_at: proof.checked_at,
        },
      });
    } catch (error) {
      return authorizationError(error);
    }
  }
  const body = await readJson(request);
  try {
    const verified = await verifyAndSubmitHyperliquidAgentAuthorization({
      body,
      accountCommitment: context.account.account_commitment,
      requireEncryptedVault: false,
      minimumAccountValueUsd: 0,
    });
    const replacement = hyperliquidVaultIdentityCommitments({
      venueAccountAddress: verified.authorization.account_address,
      agentWalletAddress: verified.authorization.agent_address,
    });
    if (
      replacement.venue_account_commitment !== current.vault.authorization.venue_account_commitment ||
      replacement.agent_wallet_commitment === current.vault.authorization.agent_wallet_commitment
    ) {
      throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_revocation_binding_mismatch", 403);
    }
    const revoked = await revokeHyperliquidVaultForOwner(context.owner, {
      expectedVaultCommitment: current.vault_commitment,
    });
    if ("error" in revoked) {
      return json({ error: revoked.error },
        revoked.error === "hyperliquid_execution_vault_state_changed" ? 409 : 404);
    }
    return json({
      ...revoked,
      venue_authorization: {
        status: "replaced_with_discarded_key",
        valid_until: new Date(verified.authorization.valid_until_ms).toISOString(),
      },
    });
  } catch (error) {
    return authorizationError(error);
  }
}

async function onboardingContext(request: Request, options: {
  riskReduction?: boolean;
  signedRequestPending?: boolean;
} = {}) {
  if (!sameOriginJson(request)) return json({ error: "same_origin_json_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  if (owner.user.email_verified !== true) return json({ error: "verified_email_required" }, 403);
  const sessionToken = privateAccountSessionTokenFromRequest(request);
  if (!sessionToken) return unauthorized();
  if (!options.riskReduction) {
    const launch = await getLiveTradingLaunchControl();
    if (launch.state !== "canary" && launch.state !== "public") {
      return contextError("live_trading_gate_closed", 503, options);
    }
    const entitlement = await paidLiveTradingEntitlement(sessionToken, fetch, process.env, {
      requireComplimentaryPass: launch.state === "canary",
    });
    if (!entitlement.ok) {
      return contextError(entitlement.error, entitlement.status, options, {
        reason_codes: entitlement.reason_codes,
      });
    }
  }
  const quota = await consumeConsumerRateLimit({
    key: `hyperliquid_agent_wallet:${owner.owner_commitment}`,
    limit: 10,
    window_ms: 60_000,
  }).catch(() => null);
  if (!quota) return contextError("wallet_setup_quota_unavailable", 503, options);
  if (!quota.ok) {
    return contextError("wallet_setup_rate_limited", 429, options, {
      retry_after_seconds: quota.retry_after_seconds,
    });
  }
  const account = await createOrGetStoredPrivateAccount(owner);
  if (!options.riskReduction) {
    const eligibility = await getLatestVenueEligibilityByAccount({
      account_commitment: account.account_commitment,
      venue_id: "hyperliquid",
    });
    if (!currentEligibility(eligibility, owner.owner_commitment)) {
      return json({ error: "live_trading_eligibility_required" }, 451);
    }
  }
  return { owner, account };
}

function contextError(
  error: string,
  status: number,
  options: { signedRequestPending?: boolean },
  details: Record<string, unknown> = {},
) {
  const retrySafe = options.signedRequestPending === true && (status === 429 || status === 503);
  return json({ error, ...details, ...(retrySafe ? { retry_safe: true } : {}) }, status);
}

function currentEligibility(value: unknown, ownerCommitment: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const credential = row.credential;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return false;
  const proof = credential as Record<string, unknown>;
  return row.owner_commitment === ownerCommitment && row.status === "verified" &&
    typeof row.expires_at === "string" && Date.parse(row.expires_at) > Date.now() &&
    proof.credential_type === "self_attested_eligible_user" &&
    proof.eligibility_basis === "self_attested_non_us" && proof.eligible_non_us === true &&
    proof.terms_version === LIVE_TRADING_TERMS_VERSION &&
    proof.risk_disclosure_version === LIVE_TRADING_RISK_DISCLOSURE_VERSION &&
    typeof proof.accepted_at === "string" && Boolean(proof.accepted_at);
}

function authorizationError(error: unknown) {
  if (error instanceof HyperliquidAgentAuthorizationError) {
    const retrySafe = error.code === "hyperliquid_agent_vault_worker_verification_unknown" ||
      error.code === "hyperliquid_agent_vault_storage_state_unknown";
    return json({
      error: error.code,
      ...(retrySafe ? { retry_safe: true } : {}),
      ...(error.code === "legacy_hyperliquid_agent_still_authorized"
        ? { message: "Revoke the legacy API wallet in Hyperliquid, then verify removal again." }
        : {}),
    }, error.status);
  }
  return json({ error: "hyperliquid_agent_authorization_state_unknown" }, 503);
}

function sameOriginJson(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!origin || !host || contentType !== "application/json") return false;
  try {
    const url = new URL(origin);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.host === host && (url.protocol === "https:" || (local && url.protocol === "http:"));
  } catch {
    return false;
  }
}
