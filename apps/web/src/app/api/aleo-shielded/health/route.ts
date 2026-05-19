import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function recipientAddress() {
  const privateKey = process.env.ALEO_RECIPIENT_PRIVATE_KEY?.trim();
  if (!privateKey) return null;

  try {
    const { Account } = await import("@provablehq/sdk/mainnet.js");
    const account = new Account({ privateKey });
    const address = account.address().toString();
    account.destroy?.();
    return address;
  } catch {
    return null;
  }
}

function recipientPreview(address: string | null) {
  if (!address) return null;
  if (address.length <= 18) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function verifierAuthRequired() {
  const raw = process.env.ALEO_VERIFY_REQUIRE_AUTH?.trim().toLowerCase();
  return (
    Boolean(process.env.SHIELDED_STABLECOIN_ADAPTER_AUTH_TOKEN?.trim()) ||
    raw === "1" ||
    raw === "true" ||
    raw === "yes" ||
    (raw === undefined && process.env.NODE_ENV === "production")
  );
}

function envFlag(...names: string[]) {
  for (const name of names) {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) continue;
    return raw === "1" || raw === "true" || raw === "yes";
  }
  return false;
}

function recipientReceiptsEnabled() {
  return envFlag(
    "ALEO_RECIPIENT_RECEIPTS_ENABLED",
    "SHIELDED_STABLECOIN_ARBITRARY_RECIPIENTS_ENABLED",
  );
}

export async function GET() {
  const indexerConfigured = Boolean(process.env.ALEO_INDEXER_URL?.trim());
  const programConfigured = Boolean(process.env.ALEO_PAYMENT_PROGRAM?.trim());
  const recipientKeyConfigured = Boolean(
    process.env.ALEO_RECIPIENT_PRIVATE_KEY?.trim(),
  );
  const signingKeyConfigured = Boolean(
    process.env.SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY?.trim(),
  );
  const adapterAuthConfigured = Boolean(
    process.env.SHIELDED_STABLECOIN_ADAPTER_AUTH_TOKEN?.trim(),
  );
  const recipientReceiptVerificationEnabled = recipientReceiptsEnabled();
  const configured =
    indexerConfigured &&
    programConfigured &&
    signingKeyConfigured &&
    (recipientKeyConfigured || recipientReceiptVerificationEnabled);
  const recipient = await recipientAddress();

  return NextResponse.json({
    ok: true,
    rail: "shielded_stablecoin",
    canonical_rail: "aleo_usdcx_shielded",
    provider: "aleo",
    asset: "USDCx",
    verifier: "ghola-aleo-shielded-adapter",
    configured,
    indexer_configured: indexerConfigured,
    program_configured: programConfigured,
    recipient_key_configured: recipientKeyConfigured,
    recipient_configured: Boolean(recipient),
    recipient_preview: recipientPreview(recipient),
    recipient_receipts_enabled: recipientReceiptVerificationEnabled,
    arbitrary_recipient_proofs_enabled: recipientReceiptVerificationEnabled,
    signing_key_configured: signingKeyConfigured,
    adapter_auth_configured: adapterAuthConfigured,
    auth_required: verifierAuthRequired(),
    fail_closed: true,
  });
}
