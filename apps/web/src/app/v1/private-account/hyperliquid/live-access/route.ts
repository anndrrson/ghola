import {
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
} from "@/lib/live-trading-contract";
import { getActiveLiveTradingAccountGraduation } from "@/lib/live-trading-store";
import { currentLiveTradingReleaseIdentity } from "@/lib/live-trading-release.server";
import { parseHyperliquidVaultAssociatedData } from "@/lib/hyperliquid-vault-seal";
import { isCurrentHyperliquidVaultAuthorization } from "@/lib/hyperliquid-vault-scope";
import {
  getHyperliquidExecutionVaultByAccount,
  getLatestVenueEligibilityByAccount,
  getPrivateAccountByOwner,
} from "@/lib/private-account-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const account = await getPrivateAccountByOwner(owner.owner_commitment);
  if (!account) return json({ version: 2, ready: false, reason_codes: ["private_account_required"] });
  const [vault, eligibility] = await Promise.all([
    getHyperliquidExecutionVaultByAccount(account.account_commitment),
    getLatestVenueEligibilityByAccount({ account_commitment: account.account_commitment, venue_id: "hyperliquid" }),
  ]);
  const credential = eligibility?.credential;
  const eligibilityReady = Boolean(
    eligibility?.owner_commitment === owner.owner_commitment && eligibility.status === "verified" &&
    Date.parse(eligibility.expires_at) > Date.now() && credential?.credential_type === "self_attested_eligible_user" &&
    credential.eligibility_basis === "self_attested_non_us" && credential.eligible_non_us === true &&
    credential.terms_version === LIVE_TRADING_TERMS_VERSION &&
    credential.risk_disclosure_version === LIVE_TRADING_RISK_DISCLOSURE_VERSION && credential.accepted_at,
  );
  const vaultScope = vault
    ? parseHyperliquidVaultAssociatedData(vault.vault.encrypted_execution_vault.aad)
    : null;
  const vaultReady = vault?.owner_commitment === owner.owner_commitment && vault.status === "sealed" &&
    vault.account_commitment === account.account_commitment &&
    vaultScope?.network === "mainnet" && vaultScope.account_commitment === account.account_commitment &&
    isCurrentHyperliquidVaultAuthorization(vault);
  const release = currentLiveTradingReleaseIdentity();
  const graduation = vaultReady ? await getActiveLiveTradingAccountGraduation({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    vault_commitment: vault.vault_commitment,
    release,
  }) : null;
  const reasonCodes = [
    ...(vaultReady ? [] : ["sealed_hyperliquid_vault_required"]),
    ...(eligibilityReady ? [] : ["live_trading_eligibility_required"]),
    ...(graduation ? [] : ["funded_account_proof_required"]),
  ];
  return json({
    version: 2,
    venue_id: "hyperliquid",
    network: "mainnet",
    ready: reasonCodes.length === 0,
    vault_ready: vaultReady,
    eligibility_ready: eligibilityReady,
    graduation_ready: Boolean(graduation),
    eligibility_expires_at: eligibilityReady ? eligibility?.expires_at ?? null : null,
    proof_completed_at: graduation?.completed_at ?? null,
    reason_codes: reasonCodes,
  });
}
