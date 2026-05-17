import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface ShieldedVerifyRequest {
  provider?: string;
  network?: string;
  asset?: string;
  destination?: string;
  required_amount?: number;
  proof?: {
    shielded_receipt_id?: string | null;
    proof_b64?: string | null;
    nullifier_hex?: string | null;
  };
}

function badRequest(error: string) {
  return NextResponse.json({ settled: false, error }, { status: 400 });
}

export async function POST(request: NextRequest) {
  let body: ShieldedVerifyRequest;
  try {
    body = (await request.json()) as ShieldedVerifyRequest;
  } catch {
    return badRequest("invalid JSON body");
  }

  if (body.provider !== "aleo") {
    return badRequest("unsupported shielded provider");
  }
  if (!body.network?.startsWith("aleo:")) {
    return badRequest("unsupported shielded network");
  }
  if (!body.asset) {
    return badRequest("missing shielded asset");
  }
  if (!body.destination) {
    return badRequest("missing shielded recipient");
  }
  if (!Number.isFinite(body.required_amount) || Number(body.required_amount) <= 0) {
    return badRequest("missing required shielded amount");
  }
  if (!body.proof?.nullifier_hex && !body.proof?.shielded_receipt_id) {
    return badRequest("missing shielded receipt/nullifier");
  }

  const indexerConfigured = Boolean(process.env.ALEO_INDEXER_URL?.trim());
  const programConfigured = Boolean(process.env.ALEO_PAYMENT_PROGRAM?.trim());
  const signingKeyConfigured = Boolean(
    process.env.SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY?.trim(),
  );

  if (!indexerConfigured || !programConfigured || !signingKeyConfigured) {
    return NextResponse.json(
      {
        settled: false,
        provider: "aleo",
        network: body.network,
        asset: body.asset,
        destination: body.destination,
        error:
          "Aleo verifier adapter is deployed fail-closed; ALEO_INDEXER_URL, ALEO_PAYMENT_PROGRAM, and SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY are not fully configured.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      settled: false,
      provider: "aleo",
      network: body.network,
      asset: body.asset,
      destination: body.destination,
      error:
        "Aleo on-chain verification is not implemented in this adapter build.",
    },
    { status: 501 },
  );
}
