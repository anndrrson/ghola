import { createHash, createPrivateKey, sign } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ShieldedVerifyRequest {
  provider?: string;
  network?: string;
  asset?: string;
  destination?: string;
  required_amount?: number;
  proof?: {
    tx_signature?: string | null;
    shielded_receipt_id?: string | null;
    proof_b64?: string | null;
    nullifier_hex?: string | null;
  };
}

type AleoRecordPlaintext = {
  owner?: () => { toString: () => string };
  toJsObject?: () => unknown;
  toString?: () => string;
};

type AleoTransitionJson = {
  id?: string;
  program?: string;
  function?: string;
  outputs?: Array<{
    type?: string;
    id?: string;
    value?: string;
  }>;
};

function badRequest(error: string) {
  return NextResponse.json({ settled: false, error }, { status: 400 });
}

function unavailable(body: ShieldedVerifyRequest, error: string) {
  return NextResponse.json(
    {
      settled: false,
      provider: "aleo",
      network: body.network,
      asset: body.asset,
      destination: body.destination,
      indexer_configured: Boolean(process.env.ALEO_INDEXER_URL?.trim()),
      program_configured: Boolean(process.env.ALEO_PAYMENT_PROGRAM?.trim()),
      recipient_key_configured: Boolean(process.env.ALEO_RECIPIENT_PRIVATE_KEY?.trim()),
      signing_key_configured: Boolean(
        process.env.SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY?.trim(),
      ),
      error,
    },
    { status: 503 },
  );
}

function canonicalProofDigest(proof: NonNullable<ShieldedVerifyRequest["proof"]>) {
  const canonical = {
    tx_signature: proof.tx_signature ?? null,
    shielded_receipt_id: proof.shielded_receipt_id ?? null,
    proof_b64: proof.proof_b64 ?? null,
    nullifier_hex: proof.nullifier_hex ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function receiptRef(proof: NonNullable<ShieldedVerifyRequest["proof"]>) {
  return (
    proof.nullifier_hex?.trim() ||
    proof.shielded_receipt_id?.trim() ||
    proof.tx_signature?.trim() ||
    ""
  );
}

function aleoTransactionId(proof: NonNullable<ShieldedVerifyRequest["proof"]>) {
  const candidates = [
    proof.shielded_receipt_id?.trim(),
    proof.tx_signature?.trim(),
    proof.nullifier_hex?.trim(),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => /^at1[0-9a-z]+$/i.test(candidate));
}

function normalizeAleoIndexerUrl(url: string) {
  return url.trim().replace(/\/+(mainnet|testnet)\/?$/i, "");
}

function parseAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value !== "string") return null;

  const match = value.trim().match(/^(\d+)(?:u(?:8|16|32|64|128))?(?:\.(?:private|public))?$/);
  return match ? BigInt(match[1]) : null;
}

function recordAmount(record: AleoRecordPlaintext): bigint | null {
  const obj = record.toJsObject?.();
  if (obj && typeof obj === "object") {
    const fields = obj as Record<string, unknown>;
    for (const key of ["amount", "microcredits", "balance", "value"]) {
      const amount = parseAmount(fields[key]);
      if (amount !== null) return amount;
    }
  }

  const text = record.toString?.() || "";
  const match = text.match(/\b(?:amount|microcredits|balance|value):\s*(\d+)u(?:8|16|32|64|128)\.(?:private|public)\b/);
  return match ? BigInt(match[1]) : null;
}

function recordOwner(record: AleoRecordPlaintext) {
  try {
    const owner = record.owner?.().toString();
    if (owner) return owner;
  } catch {
    // Fall back to the JS-object/string forms below.
  }

  const obj = record.toJsObject?.();
  if (obj && typeof obj === "object") {
    const owner = (obj as Record<string, unknown>).owner;
    if (typeof owner === "string") return owner;
  }

  const text = record.toString?.() || "";
  return text.match(/\bowner:\s*(aleo1[0-9a-z]+)\.(?:private|public)\b/i)?.[1] || null;
}

function signedReceiptPayload(input: {
  provider: string;
  network: string;
  asset: string;
  destination: string;
  requiredAmount: number;
  paidAmount: bigint;
  receiptRef: string;
  proofDigest: string;
  observedAtUnix: number;
  expiresAtUnix: number;
  confirmations: number;
}) {
  return [
    "ghola-shielded-stablecoin-v1",
    `provider:${input.provider}`,
    `network:${input.network}`,
    `asset:${input.asset}`,
    `destination:${input.destination}`,
    `required_amount:${input.requiredAmount}`,
    `paid_amount:${input.paidAmount.toString()}`,
    `receipt_ref:${input.receiptRef}`,
    `proof_digest:${input.proofDigest}`,
    `observed_at_unix:${input.observedAtUnix}`,
    `expires_at_unix:${input.expiresAtUnix}`,
    `confirmations:${input.confirmations}`,
    "settled:true",
  ].join("\n");
}

function signReceipt(payload: string) {
  const signingKey = process.env.SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY?.trim();
  if (!signingKey) throw new Error("missing adapter signing key");

  const keyObject = createPrivateKey({
    key: Buffer.from(signingKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(payload, "utf8"), keyObject).toString("base64");
}

function bigintToSafeNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("verified amount exceeds safe integer range");
  }
  return Number(value);
}

async function findTransactionBlockHeight(input: {
  client: {
    getBlockByHash: (blockHash: string) => Promise<{
      header?: { metadata?: { height?: bigint | number | string } };
    }>;
  };
  indexerUrl: string;
  txId: string;
}) {
  const response = await fetch(
    `${input.indexerUrl}/mainnet/find/blockHash/${input.txId}`,
    { cache: "no-store" },
  );
  if (!response.ok) return null;

  const blockHash = String(await response.json()).replace(/^"|"$/g, "");
  if (!blockHash.startsWith("ab1")) return null;

  const block = await input.client.getBlockByHash(blockHash);
  const height = block.header?.metadata?.height;
  const parsed = Number(height);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  if (body.asset !== "USDCx") {
    return badRequest("unsupported shielded asset; Aleo private settlement requires USDCx");
  }
  if (!body.destination) {
    return badRequest("missing shielded recipient");
  }
  if (!Number.isFinite(body.required_amount) || Number(body.required_amount) <= 0) {
    return badRequest("missing required shielded amount");
  }
  if (!body.proof?.nullifier_hex && !body.proof?.shielded_receipt_id && !body.proof?.tx_signature) {
    return badRequest("missing shielded receipt/nullifier");
  }

  const indexerUrl = process.env.ALEO_INDEXER_URL?.trim();
  const program = process.env.ALEO_PAYMENT_PROGRAM?.trim();
  const recipientPrivateKey = process.env.ALEO_RECIPIENT_PRIVATE_KEY?.trim();
  if (!indexerUrl || !program || !recipientPrivateKey) {
    return unavailable(
      body,
      "Aleo verifier adapter is deployed fail-closed; ALEO_INDEXER_URL, ALEO_PAYMENT_PROGRAM, and ALEO_RECIPIENT_PRIVATE_KEY are not fully configured.",
    );
  }
  if (!process.env.SHIELDED_STABLECOIN_ADAPTER_SIGNING_KEY?.trim()) {
    return unavailable(body, "Aleo verifier adapter signing key is not configured.");
  }

  const txId = aleoTransactionId(body.proof);
  if (!txId) {
    return badRequest("shielded receipt must include an Aleo transaction id");
  }

  const requiredAmount = BigInt(Math.trunc(Number(body.required_amount)));
  const minConfirmations = Math.max(
    1,
    Number.parseInt(process.env.ALEO_MIN_CONFIRMATIONS || "1", 10) || 1,
  );

  try {
    const { Account, AleoNetworkClient } = await import("@provablehq/sdk/mainnet.js");
    const account = new Account({ privateKey: recipientPrivateKey });
    const recipient = account.address().toString();
    if (recipient !== body.destination) {
      account.destroy?.();
      return badRequest("shielded recipient does not match adapter key");
    }

    const normalizedIndexerUrl = normalizeAleoIndexerUrl(indexerUrl);
    const client = new AleoNetworkClient(normalizedIndexerUrl);
    const confirmed = await client.getConfirmedTransaction(txId);
    if (!["accepted", "confirmed"].includes(confirmed.status)) {
      account.destroy?.();
      return NextResponse.json(
        {
          settled: false,
          provider: "aleo",
          network: body.network,
          asset: body.asset,
          destination: body.destination,
          error: "Aleo transaction is not accepted",
        },
        { status: 200 },
      );
    }

    const transitions = (confirmed.transaction.execution?.transitions || []) as AleoTransitionJson[];
    const matchingTransitions = transitions.filter((transition) => transition.program === program);
    if (matchingTransitions.length === 0) {
      account.destroy?.();
      return NextResponse.json(
        {
          settled: false,
          provider: "aleo",
          network: body.network,
          asset: body.asset,
          destination: body.destination,
          receipt_id: txId,
          error: "Aleo transaction did not execute the configured USDCx program",
        },
        { status: 200 },
      );
    }

    let paidAmount = BigInt(0);
    let matchedOutputId: string | null = null;
    for (const transition of matchingTransitions) {
      for (const output of transition.outputs || []) {
        if (output.type !== "record" || !output.value) continue;
        let record: AleoRecordPlaintext;
        try {
          record = account.decryptRecord(output.value) as AleoRecordPlaintext;
        } catch {
          continue;
        }

        if (recordOwner(record) !== body.destination) continue;
        const amount = recordAmount(record);
        if (amount === null || amount <= BigInt(0)) continue;
        paidAmount += amount;
        matchedOutputId = output.id || transition.id || txId;
      }
    }

    let confirmations = minConfirmations;
    try {
      const latestHeight = await client.getLatestHeight();
      const txHeight = await findTransactionBlockHeight({
        client,
        indexerUrl: normalizedIndexerUrl,
        txId,
      });
      if (txHeight) confirmations = Math.max(0, latestHeight - txHeight + 1);
    } catch {
      confirmations = minConfirmations;
    }

    if (paidAmount < requiredAmount || confirmations < minConfirmations) {
      account.destroy?.();
      return NextResponse.json(
        {
          settled: false,
          provider: "aleo",
          network: body.network,
          asset: body.asset,
          destination: body.destination,
          receipt_id: txId,
          amount: bigintToSafeNumber(paidAmount),
          confirmations,
          error:
            confirmations < minConfirmations
              ? "Aleo transaction needs more confirmations"
              : "Aleo transaction did not pay enough USDCx to the shielded recipient",
        },
        { status: 200 },
      );
    }

    const observedAtUnix = Math.floor(Date.now() / 1000);
    const expiresAtUnix = observedAtUnix + 10 * 60;
    const proofDigest = canonicalProofDigest(body.proof);
    const canonicalReceiptRef = receiptRef(body.proof) || matchedOutputId || txId;
    const receiptPayload = signedReceiptPayload({
      provider: "aleo",
      network: body.network,
      asset: body.asset,
      destination: body.destination,
      requiredAmount: Math.trunc(Number(body.required_amount)),
      paidAmount,
      receiptRef: canonicalReceiptRef,
      proofDigest,
      observedAtUnix,
      expiresAtUnix,
      confirmations,
    });
    const adapterSignature = signReceipt(receiptPayload);
    account.destroy?.();

    return NextResponse.json({
      settled: true,
      receipt_id: txId,
      nullifier_hex: body.proof.nullifier_hex || null,
      payer_address: "shielded",
      amount: bigintToSafeNumber(paidAmount),
      currency: "USDCx",
      provider: "aleo",
      network: body.network,
      asset: body.asset,
      destination: body.destination,
      proof_digest: proofDigest,
      observed_at_unix: observedAtUnix,
      expires_at_unix: expiresAtUnix,
      confirmations,
      adapter_signature_b64: adapterSignature,
      adapter_key_id: "ghola-aleo-shielded-adapter-v1",
    });
  } catch (error) {
    return NextResponse.json(
      {
        settled: false,
        provider: "aleo",
        network: body.network,
        asset: body.asset,
        destination: body.destination,
        receipt_id: txId,
        error: error instanceof Error ? error.message : "Aleo verifier failed",
      },
      { status: 502 },
    );
  }
}
