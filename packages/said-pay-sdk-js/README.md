# SAID Pay SDK

Agent payment helpers for Ghola/SAID.

## Private execution for financial agents

`GholaPrivateExecutionClient` lets AI financial agents simulate, execute, and
verify private trading intents through Ghola. Agents bring user-approved intent;
Ghola enforces the private rail boundary, refuses public fallback, charges an
execution fee only when the private action is accepted, and returns a signed
receipt.

```ts
import { GholaPrivateExecutionClient } from "@said-pay/sdk";

const ghola = new GholaPrivateExecutionClient({
  baseUrl: process.env.GHOLA_BASE_URL ?? "https://ghola.xyz",
  apiKey: process.env.GHOLA_AGENT_API_KEY,
});

const status = await ghola.getPrivateExecutionStatus();
if (!status.ready) {
  throw new Error(`Private execution unavailable: ${status.blocking_reasons.join(", ")}`);
}

const simulation = await ghola.simulatePrivateIntent({
  version: 1,
  policy,
  proposal,
});

if (!simulation.ok) {
  throw new Error(`Intent blocked: ${simulation.exposure_report.blocked_reason}`);
}

const receipt = await ghola.executePrivateIntent({
  version: 1,
  intent_id: "intent_...",
  owner_did: "did:key:...",
  policy_hash: simulation.policy_hash,
  proposal_hash: simulation.proposal_hash,
  amount_micro_usdc: proposal.amount_micro_usdc,
  rail: "railgun_private_swap",
  encrypted_intent_bundle: {
    alg: "sealed-provider-v1",
    ciphertext: sealedIntentBundle,
    recipient: selectedProviderRecipient,
    aad: "ghola-private-intent-v1|intent:intent_...",
  },
  provider_result: signedProviderResult,
});

const verification = await ghola.verifyPrivateExecutionReceipt(receipt);
if (!verification.ok) throw new Error("Receipt verification failed");

const usage = await ghola.getPrivateExecutionUsage();
console.log(usage.execution_count, usage.total_fee_micro_usdc);
```

The execution endpoint is ciphertext-only. The SDK and server reject payloads
that include plaintext `strategy`, `strategy_text`, `portfolio`,
`financial_context`, `prompt`, or `messages` keys. Seal user strategy and
financial context to the selected provider, then submit only the encrypted
bundle and the policy/proposal hashes.

V2 execution is provider-bound by default: `provider_result` must be signed by
the configured execution provider and must match the policy hash, proposal hash,
amount, fee amount, and fee recipient. For local demos only, operators can set
`GHOLA_PRIVATE_EXECUTION_ALLOW_MOCK_RESULT=true`.

Required operator environment:

```bash
GHOLA_AGENT_API_KEYS='{"sk_agent_dev":{"agent_id":"agent_dev","label":"Dev Agent"}}'
GHOLA_PRIVATE_EXECUTION_FEE_RECIPIENT="railgun:0zk..."
GHOLA_PRIVATE_EXECUTION_SHIELDED_RAIL_READY=true

# Optional
GHOLA_PRIVATE_EXECUTION_FEE_BPS=10
GHOLA_PRIVATE_EXECUTION_MIN_FEE_MICRO_USDC=50000
GHOLA_PRIVATE_EXECUTION_PROVIDER_ID=mock_attested
GHOLA_PRIVATE_EXECUTION_RECEIPT_SECRET="replace-me"
GHOLA_PRIVATE_EXECUTION_PROVIDER_RESULT_SECRET="provider-result-secret"
GHOLA_PRIVATE_EXECUTION_STORE=memory # or postgres
```

See `examples/private-execution.ts` for a runnable local example.

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
