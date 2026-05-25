import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage, verify as verifySignature } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  amountAttestationPayload,
  canonicalProofDigest,
  signedRailgunReceiptPayload
} from "../src/crypto.js";
import { verifyRailgunPayment } from "../src/verify.js";
import { readiness } from "../src/config.js";

const thumperCloudRequestFixture = new URL(
  "../fixtures/thumper-cloud-verify-request.json",
  import.meta.url
);

function rpcServer() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result =
      body.method === "eth_blockNumber"
        ? "0x10"
        : {
            status: "0x1",
            blockNumber: "0x10",
            to: "0xrailgun",
            logs: [{ address: "0xrailgun" }]
          };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("Railgun adapter verification", () => {
  let rpc;
  let signingKey;
  let verifyingKey;
  let amountAttestorKey; // public key passed to the adapter config
  let amountAttestorPriv; // private key used by tests to mint attestations

  before(async () => {
    rpc = await rpcServer();
    const keyPair = generateKeyPairSync("ed25519");
    signingKey = keyPair.privateKey;
    verifyingKey = keyPair.publicKey;
    const attestor = generateKeyPairSync("ed25519");
    amountAttestorKey = attestor.publicKey;
    amountAttestorPriv = attestor.privateKey;
  });

  // Mint a signed amount attestation bound to a specific shielded transfer,
  // matching the fields the adapter binds in verify.js.
  function mintAmountAttestation({ network, asset, destination, amount, receiptRef }) {
    const payload = amountAttestationPayload({
      provider: "railgun",
      network,
      asset,
      destination,
      amount,
      receiptRef
    });
    const signature_b64 = signMessage(null, Buffer.from(payload), amountAttestorPriv).toString(
      "base64"
    );
    return { amount, signature_b64 };
  }

  after(async () => {
    await new Promise((resolve) => rpc.server.close(resolve));
  });

  it("verifies a policy-approved Railgun receipt and signs Ghola response", async () => {
    const config = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      contractAddress: "0xrailgun",
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600,
      amountAttestorKey
    };

    const result = await verifyRailgunPayment(config, {
      provider: "railgun",
      network: "arbitrum",
      asset: "USDC",
      destination: "0zkrecipient000000000000000000000",
      required_amount: 1000,
      proof: {
        tx_signature: null,
        shielded_receipt_id: "receipt-1",
        proof_b64: "cHJvb2Y=",
        nullifier_hex: "nullifier-1",
        amount_attestation: mintAmountAttestation({
          network: "arbitrum",
          asset: "USDC",
          destination: "0zkrecipient000000000000000000000",
          amount: 1200,
          receiptRef: "nullifier-1"
        }),
        extensions: {
          railgun: {
            tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            amount: 1200,
            destination: "0zkrecipient000000000000000000000",
            network: "arbitrum",
            asset: "USDC",
            broadcaster: "0x1111111111111111111111111111111111111111",
            relay_only: true,
            public_wallet_broadcast: false,
            proof_of_innocence_id: "poi-01",
            proof_of_innocence_passed: true
          }
        }
      }
    });

    assert.equal(result.settled, true);
    assert.equal(result.provider, "railgun");
    assert.equal(result.amount, 1200);
    assert.match(result.adapter_signature_b64, /^[A-Za-z0-9+/]+=*$/);
  });

  it("rejects settlement when the amount attestation is missing or forged", async () => {
    const config = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      contractAddress: "0xrailgun",
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600,
      amountAttestorKey
    };
    const baseProof = {
      tx_signature: null,
      shielded_receipt_id: "receipt-1",
      proof_b64: "cHJvb2Y=",
      nullifier_hex: "nullifier-1",
      extensions: {
        railgun: {
          tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          amount: 9999,
          destination: "0zkrecipient000000000000000000000",
          network: "arbitrum",
          asset: "USDC",
          broadcaster: "0x1111111111111111111111111111111111111111",
          relay_only: true,
          public_wallet_broadcast: false,
          proof_of_innocence_id: "poi-01",
          proof_of_innocence_passed: true
        }
      }
    };
    const baseRequest = {
      provider: "railgun",
      network: "arbitrum",
      asset: "USDC",
      destination: "0zkrecipient000000000000000000000",
      required_amount: 1000
    };

    // Missing attestation entirely → 422.
    await assert.rejects(
      verifyRailgunPayment(config, { ...baseRequest, proof: { ...baseProof } }),
      (error) => error.status === 422 && /amount_attestation/.test(error.message)
    );

    // Attestation for a DIFFERENT receipt (replay) → signature invalid.
    await assert.rejects(
      verifyRailgunPayment(config, {
        ...baseRequest,
        proof: {
          ...baseProof,
          amount_attestation: mintAmountAttestation({
            network: "arbitrum",
            asset: "USDC",
            destination: "0zkrecipient000000000000000000000",
            amount: 9999,
            receiptRef: "some-other-receipt"
          })
        }
      }),
      (error) => error.status === 422 && /signature is invalid/.test(error.message)
    );
  });

  it("fails closed when no amount attestor and no unsafe opt-in are configured", async () => {
    // With neither an amount attestor key nor the explicit unsafe opt-in, the
    // adapter is NOT ready (readiness reports `amount_attestor_key` missing),
    // so it refuses to settle before doing any verification. This is the
    // primary fail-closed gate for the unverifiable-amount trust problem.
    const config = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      contractAddress: "0xrailgun",
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600
      // no amountAttestorKey, no trustClientAmountUnsafe
    };
    assert.deepEqual(readiness(config).missing, ["amount_attestor_key"]);
    await assert.rejects(
      verifyRailgunPayment(config, {
        provider: "railgun",
        network: "arbitrum",
        asset: "USDC",
        destination: "0zkrecipient000000000000000000000",
        required_amount: 1000,
        proof: {
          nullifier_hex: "nullifier-1",
          extensions: {
            railgun: {
              tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              amount: 1200,
              destination: "0zkrecipient000000000000000000000",
              network: "arbitrum",
              asset: "USDC",
              broadcaster: "0x1111111111111111111111111111111111111111",
              relay_only: true,
              public_wallet_broadcast: false,
              proof_of_innocence_id: "poi-01",
              proof_of_innocence_passed: true
            }
          }
        }
      }),
      (error) => error.status === 503 && /amount_attestor_key/.test(error.message)
    );
  });

  it("accepts thumper-cloud request JSON and returns a signed receipt response contract", async () => {
    const request = JSON.parse(await readFile(thumperCloudRequestFixture, "utf8"));
    assert.deepEqual(Object.keys(request), [
      "provider",
      "network",
      "asset",
      "destination",
      "required_amount",
      "purpose",
      "intent_id",
      "agent_id",
      "provider_id",
      "model_id",
      "request_hash",
      "proof"
    ]);
    assert.deepEqual(Object.keys(request.proof.extensions.railgun), [
      "tx_hash",
      "amount",
      "destination",
      "network",
      "asset",
      "broadcaster",
      "relay_only",
      "public_wallet_broadcast",
      "proof_of_innocence_id",
      "proof_of_innocence_passed"
    ]);

    const config = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      contractAddress: "0xrailgun",
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600,
      amountAttestorKey
    };

    // Attach a signed amount attestation bound to the fixture's transfer.
    request.proof.amount_attestation = mintAmountAttestation({
      network: "arbitrum",
      asset: "USDC",
      destination: "0zkrecipient000000000000000000000",
      amount: 1200,
      receiptRef: "nullifier-1"
    });

    const result = await verifyRailgunPayment(config, request);
    assert.deepEqual(Object.keys(result), [
      "settled",
      "receipt_id",
      "nullifier_hex",
      "payer_address",
      "amount",
      "currency",
      "provider",
      "network",
      "asset",
      "destination",
      "proof_digest",
      "request_hash",
      "relay_only",
      "observed_at_unix",
      "expires_at_unix",
      "confirmations",
      "adapter_signature_b64",
      "adapter_key_id"
    ]);
    assert.equal(result.settled, true);
    assert.equal(result.receipt_id, "receipt-1");
    assert.equal(result.nullifier_hex, "nullifier-1");
    assert.equal(result.payer_address, "railgun_0zk");
    assert.equal(result.amount, 1200);
    assert.equal(result.currency, "USDC");
    assert.equal(result.provider, "railgun");
    assert.equal(result.network, "arbitrum");
    assert.equal(result.asset, "USDC");
    assert.equal(result.destination, "0zkrecipient000000000000000000000");
    assert.equal(result.proof_digest, canonicalProofDigest(request.proof));
    assert.equal(result.request_hash, request.request_hash);
    assert.equal(result.relay_only, true);
    assert.equal(result.confirmations, 1);
    assert.equal(result.adapter_key_id, "railgun-adapter-ed25519-v1");
    assert.equal(result.expires_at_unix - result.observed_at_unix, 600);

    const signedPayload = signedRailgunReceiptPayload({
      provider: "railgun",
      network: "arbitrum",
      asset: "USDC",
      destination: result.destination,
      requiredAmount: request.required_amount,
      paidAmount: result.amount,
      receiptRef: result.nullifier_hex,
      proofDigest: result.proof_digest,
      requestHash: result.request_hash,
      relayOnly: result.relay_only,
      observedAtUnix: result.observed_at_unix,
      expiresAtUnix: result.expires_at_unix,
      confirmations: result.confirmations,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true
    });
    assert.equal(
      verifySignature(
        null,
        Buffer.from(signedPayload),
        verifyingKey,
        Buffer.from(result.adapter_signature_b64, "base64")
      ),
      true
    );
  });

  it("fails closed when proof-of-innocence is required but missing", async () => {
    await assert.rejects(
      verifyRailgunPayment(
        {
          authToken: "secret",
          signingKey,
          network: "arbitrum",
          asset: "USDC",
          recipient: "0zkrecipient000000000000000000000",
          rpcUrl: rpc.url,
          minConfirmations: 1,
          broadcasterReady: true,
          proofOfInnocenceRequired: true,
          proofOfInnocenceConfigured: true,
          receiptTtlSeconds: 600,
          amountAttestorKey
        },
        {
          provider: "railgun",
          network: "arbitrum",
          asset: "USDC",
          destination: "0zkrecipient000000000000000000000",
          required_amount: 1000,
          proof: {
            nullifier_hex: "nullifier-1",
            extensions: {
              railgun: {
                tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                amount: 1200,
                destination: "0zkrecipient000000000000000000000",
                network: "arbitrum",
                asset: "USDC",
                broadcaster: "0x1111111111111111111111111111111111111111",
                relay_only: true,
                public_wallet_broadcast: false,
                proof_of_innocence_passed: false
              }
            }
          }
        }
      ),
      /proof_of_innocence|proof-of-innocence/
    );
  });

  it("fails closed when broadcaster or proof policy readiness is missing", async () => {
    const request = JSON.parse(await readFile(thumperCloudRequestFixture, "utf8"));
    const readyConfig = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      contractAddress: "0xrailgun",
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600,
      amountAttestorKey
    };

    await assert.rejects(
      verifyRailgunPayment(
        {
          ...readyConfig,
          broadcasterReady: false
        },
        request
      ),
      (error) => error.status === 503 && /broadcaster/.test(error.message)
    );

    await assert.rejects(
      verifyRailgunPayment(
        {
          ...readyConfig,
          proofOfInnocenceConfigured: false
        },
        request
      ),
      (error) => error.status === 503 && /proof_of_innocence_policy/.test(error.message)
    );
  });

  it("rejects malformed Railgun evidence before RPC verification", async () => {
    const request = JSON.parse(await readFile(thumperCloudRequestFixture, "utf8"));
    const readyConfig = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600,
      amountAttestorKey
    };

    await assert.rejects(
      verifyRailgunPayment(
        readyConfig,
        {
          ...request,
          proof: {
            ...request.proof,
            extensions: {
              railgun: {
                ...request.proof.extensions.railgun,
                tx_hash: "0xabc"
              }
            }
          }
        }
      ),
      /tx_hash/
    );

    await assert.rejects(
      verifyRailgunPayment(
        { ...readyConfig, asset: "DAI" },
        { ...request, asset: "DAI" }
      ),
      /asset is unsupported/
    );
  });

  it("rejects request hash mismatches before settlement", async () => {
    const request = JSON.parse(await readFile(thumperCloudRequestFixture, "utf8"));
    await assert.rejects(
      verifyRailgunPayment(
        {
          authToken: "secret",
          signingKey,
          network: "arbitrum",
          asset: "USDC",
          recipient: "0zkrecipient000000000000000000000",
          rpcUrl: rpc.url,
          minConfirmations: 1,
          broadcasterReady: true,
          proofOfInnocenceRequired: true,
          proofOfInnocenceConfigured: true,
          receiptTtlSeconds: 600,
          amountAttestorKey
        },
        {
          ...request,
          proof: {
            ...request.proof,
            request_hash: "2222222222222222222222222222222222222222222222222222222222222222"
          }
        }
      ),
      /request_hash mismatch/
    );
  });

  it("rejects non-relayed Railgun evidence", async () => {
    const request = JSON.parse(await readFile(thumperCloudRequestFixture, "utf8"));
    const readyConfig = {
      authToken: "secret",
      signingKey,
      network: "arbitrum",
      asset: "USDC",
      recipient: "0zkrecipient000000000000000000000",
      rpcUrl: rpc.url,
      minConfirmations: 1,
      broadcasterReady: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      receiptTtlSeconds: 600,
      amountAttestorKey
    };

    await assert.rejects(
      verifyRailgunPayment(readyConfig, {
        ...request,
        proof: {
          ...request.proof,
          extensions: {
            railgun: {
              ...request.proof.extensions.railgun,
              relay_only: false
            }
          }
        }
      }),
      /relay_only/
    );

    await assert.rejects(
      verifyRailgunPayment(readyConfig, {
        ...request,
        proof: {
          ...request.proof,
          extensions: {
            railgun: {
              ...request.proof.extensions.railgun,
              public_wallet_broadcast: true
            }
          }
        }
      }),
      /public_wallet_broadcast/
    );
  });

  it("does not expose browser/user secrets in adapter request metadata", async () => {
    const request = JSON.parse(await readFile(thumperCloudRequestFixture, "utf8"));
    const serialized = JSON.stringify(request).toLowerCase();
    for (const forbidden of [
      "user_id",
      "wallet_seed",
      "seed_phrase",
      "private_key",
      "viewing_key",
      "mnemonic",
      "prompt",
      "message_content"
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});
