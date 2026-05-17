import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const indexerConfigured = Boolean(process.env.ALEO_INDEXER_URL?.trim());
  const programConfigured = Boolean(process.env.ALEO_PAYMENT_PROGRAM?.trim());
  const recipientKeyConfigured = Boolean(
    process.env.ALEO_RECIPIENT_PRIVATE_KEY?.trim(),
  );
  const signingKeyConfigured = Boolean(
    process.env.SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY?.trim(),
  );
  const configured =
    indexerConfigured &&
    programConfigured &&
    recipientKeyConfigured &&
    signingKeyConfigured;

  return NextResponse.json({
    ok: true,
    rail: "shielded_stablecoin",
    provider: "aleo",
    verifier: "ghola-aleo-shielded-adapter",
    configured,
    indexer_configured: indexerConfigured,
    program_configured: programConfigured,
    recipient_key_configured: recipientKeyConfigured,
    signing_key_configured: signingKeyConfigured,
    fail_closed: true,
  });
}
