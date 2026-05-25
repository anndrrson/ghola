# SAID Pay SDK

Agent payment helpers for Ghola/SAID.

## Railgun x402

`createRailgunX402Payment` builds the `x402-payment` header for
`x-ghola-payment-rail: railgun_evm_shielded`.

The SDK does not custody Railgun spending keys. Pass in initialized Railgun SDK
objects from the user's wallet, browser app, or agent runtime.

```ts
import {
  createRailgunX402Payment,
  fetchWithRailgunX402,
  type RailgunSdkFacade,
} from "@said-pay/sdk";

await fetchWithRailgunX402("https://ghola.xyz/v1/chat/completions", {
  method: "POST",
  provider: {
    async createPayment(option) {
      const { paymentHeader } = await createRailgunX402Payment({
        sdk: railgunSdk as RailgunSdkFacade,
        broadcasterClient,
        broadcasterTransaction,
        chain,
        network: "arbitrum",
        railgunWalletId,
        encryptionKey,
        tokenAddress: usdcAddress,
        amount: 1_000n,
        asset: "USDC",
        destinationRailgunAddress: "0zk...",
        feeTokenDetails: {
          tokenAddress: usdcAddress,
          decimals: 6,
        },
        originalGasDetails,
        proofOfInnocenceId: "poi-...",
        requestHash: option.extra?.request_hash,
        relayOnly: true,
      });
      return { paymentHeader };
    },
  },
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "agent:research-bot",
    messages: [],
    enclave_key_id: selectedEnclave.enclave_key_id,
    sealed_request_b64: sealedRequestB64,
    sealed_job_id: jobId,
    max_tokens: 2048,
  }),
});
```

`fetchWithRailgunX402` sends the first request with
`x-ghola-payment-rail: railgun_evm_shielded`, parses the 402 challenge, refuses
Railgun options that do not include `request_hash`, asks your provider to create
the Railgun proof, then retries with both `x402-payment` and
`payment-signature`.

`agent:*` requests are ciphertext-only. Build `sealed_request_b64` by sealing
the prompt/model payload to an attested enclave from `/providers/attested`;
Ghola rejects plaintext `messages` on these routes and defaults settlement to a
shielded rail.

The returned proof has this shape:

```json
{
  "x402Version": "2",
  "scheme": "railgun_evm_shielded",
  "network": "arbitrum",
  "payload": {
    "shielded_receipt_id": "0x...",
    "nullifier_hex": "0x...",
    "request_hash": "4f...",
    "extensions": {
      "ghola": {
        "request_hash": "4f..."
      },
      "railgun": {
        "tx_hash": "0x...",
        "amount": 1000,
        "destination": "0zk...",
        "network": "arbitrum",
        "asset": "USDC",
        "broadcaster": "0zk...",
        "relay_only": true,
        "public_wallet_broadcast": false,
        "proof_of_innocence_id": "poi-...",
        "proof_of_innocence_passed": true
      }
    }
  }
}
```

Ghola rejects the request unless the Railgun adapter, broadcaster, and
proof-of-innocence policy are ready. For private x402 inference, Ghola also
requires the proof `request_hash` to match the hash returned in the 402 payment
option. The helper defaults to relay-only broadcaster submission and marks
`public_wallet_broadcast` as false; Ghola rejects Railgun evidence that does not
carry those flags.
