import {
  canonicalProofDigest,
  signedRailgunReceiptPayload,
  signReceipt,
  verifyAmountAttestation
} from "./crypto.js";
import { verifiedReceipt } from "./evm.js";
import { readiness } from "./config.js";

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`${name} is required`);
  }
  return value.trim();
}

function requirePattern(value, name, pattern, description) {
  const text = requireString(value, name);
  if (!pattern.test(text)) throw fail(`${name} must be ${description}`);
  return text;
}

function parseAmount(value, name) {
  const amount = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(amount) || amount < 0) throw fail(`${name} must be a non-negative integer`);
  return amount;
}

export async function verifyRailgunPayment(config, request) {
  const state = readiness(config);
  if (!state.ready) throw fail(`adapter is not ready: ${state.missing.join(", ")}`, 503);

  if (request.provider !== "railgun") throw fail("provider must be railgun");
  if (request.network !== config.network) throw fail(`network mismatch: expected ${config.network}`);
  if (request.asset !== config.asset) throw fail(`asset mismatch: expected ${config.asset}`);

  const proof = request.proof;
  if (!proof || typeof proof !== "object") throw fail("proof is required");
  const railgun = proof.extensions?.railgun;
  if (!railgun || typeof railgun !== "object") throw fail("proof.extensions.railgun is required");
  const requestHash = request.request_hash ? requirePattern(request.request_hash, "request_hash", /^[a-f0-9]{64}$/, "a SHA-256 hex digest") : "";
  if (requestHash) {
    const proofRequestHash = proof.request_hash || proof.extensions?.ghola?.request_hash;
    if (proofRequestHash !== requestHash) throw fail("proof request_hash mismatch");
  }

  const destination = requirePattern(
    railgun.destination ?? request.destination,
    "destination",
    /^0zk[a-zA-Z0-9]{16,}$/,
    "a Railgun 0zk address"
  );
  if (destination !== request.destination || destination !== config.recipient) {
    throw fail("destination mismatch");
  }

  const requiredAmount = parseAmount(request.required_amount, "required_amount");

  if (!["ethereum", "polygon", "arbitrum", "bsc"].includes(config.network)) {
    throw fail("configured Railgun network is unsupported", 503);
  }
  if (!["USDC", "USDT"].includes(config.asset)) {
    throw fail("configured Railgun asset is unsupported", 503);
  }
  if (railgun.network !== config.network) throw fail("railgun receipt network mismatch");
  if (railgun.asset !== config.asset) throw fail("railgun receipt asset mismatch");
  requirePattern(railgun.broadcaster, "broadcaster", /^0x[a-fA-F0-9]{40}$|^0zk[a-zA-Z0-9]{16,}$/, "an EVM or Railgun address");
  if (railgun.relay_only !== true) throw fail("railgun relay_only must be true");
  if (railgun.public_wallet_broadcast !== false) throw fail("railgun public_wallet_broadcast must be false");
  if (config.proofOfInnocenceRequired) {
    requirePattern(railgun.proof_of_innocence_id, "proof_of_innocence_id", /^[a-zA-Z0-9_.:-]{6,128}$/, "a bounded proof policy id");
    if (railgun.proof_of_innocence_passed !== true) {
      throw fail("proof-of-innocence policy did not pass");
    }
  }

  const txHash = requirePattern(railgun.tx_hash, "tx_hash", /^0x[a-fA-F0-9]{64}$/, "a 32-byte EVM tx hash");
  const { confirmations } = await verifiedReceipt({
    rpcUrl: config.rpcUrl,
    txHash,
    minConfirmations: config.minConfirmations,
    contractAddress: config.contractAddress
  });

  const proofDigest = canonicalProofDigest(proof);
  const receiptRef = proof.nullifier_hex || proof.shielded_receipt_id || txHash;

  // --- Trusted amount determination (SECURITY: see config.js) --------------
  //
  // Railgun shields the transferred amount on-chain, so the adapter cannot
  // derive `amount` from transaction logs — `verifiedReceipt` only proves the
  // tx exists, succeeded, has enough confirmations, and touched the Railgun
  // contract. Trusting a bare client-supplied `railgun.amount` would let any
  // caller present a real (even unrelated) Railgun tx and claim an arbitrary
  // paid amount, settling paid services for free.
  //
  // Therefore the amount MUST arrive inside a signed `proof.amount_attestation`
  // bound to this exact (provider, network, asset, destination, receipt_ref).
  // If no attestor key is configured, we fail closed unless the operator has
  // explicitly opted into the unsafe client-amount mode.
  let amount;
  if (config.amountAttestorKey) {
    const attestation = proof.amount_attestation;
    if (!attestation || typeof attestation !== "object") {
      throw fail("proof.amount_attestation is required (signed amount binding)", 422);
    }
    const attestedAmount = parseAmount(attestation.amount, "amount_attestation.amount");
    const ok = verifyAmountAttestation(
      config.amountAttestorKey,
      {
        provider: "railgun",
        network: config.network,
        asset: config.asset,
        destination,
        amount: attestedAmount,
        receiptRef
      },
      attestation.signature_b64
    );
    if (!ok) {
      throw fail("amount_attestation signature is invalid for this transfer", 422);
    }
    amount = attestedAmount;
  } else if (config.trustClientAmountUnsafe) {
    // Explicit, logged opt-in. The amount is NOT verified — only use where an
    // upstream component is known to verify it out-of-band.
    console.warn(
      "RAILGUN_TRUST_CLIENT_AMOUNT_UNSAFE is enabled: trusting unverified client amount"
    );
    amount = parseAmount(railgun.amount, "railgun amount");
  } else {
    // Fail closed: no way to trust the amount.
    throw fail(
      "amount attestation unavailable: configure RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_PEM " +
        "(or set RAILGUN_TRUST_CLIENT_AMOUNT_UNSAFE=true only if an upstream component " +
        "verifies the amount)",
      503
    );
  }
  if (amount < requiredAmount) throw fail(`insufficient amount: ${amount} < ${requiredAmount}`);
  const now = Math.floor(Date.now() / 1000);
  const expiresAtUnix = now + config.receiptTtlSeconds;
  const payload = signedRailgunReceiptPayload({
    provider: "railgun",
    network: config.network,
    asset: config.asset,
    destination,
    requiredAmount,
    paidAmount: amount,
    receiptRef,
    proofDigest,
    requestHash,
    relayOnly: true,
    observedAtUnix: now,
    expiresAtUnix,
    confirmations,
    proofOfInnocenceRequired: config.proofOfInnocenceRequired,
    proofOfInnocenceConfigured: config.proofOfInnocenceConfigured
  });

  return {
    settled: true,
    receipt_id: proof.shielded_receipt_id || txHash,
    nullifier_hex: proof.nullifier_hex || txHash,
    payer_address: "railgun_0zk",
    amount,
    currency: config.asset,
    provider: "railgun",
    network: config.network,
    asset: config.asset,
    destination,
    proof_digest: proofDigest,
    request_hash: requestHash || undefined,
    relay_only: true,
    observed_at_unix: now,
    expires_at_unix: expiresAtUnix,
    confirmations,
    adapter_signature_b64: signReceipt(config.signingKey, payload),
    adapter_key_id: "railgun-adapter-ed25519-v1"
  };
}
