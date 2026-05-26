// @ts-nocheck
import { GholaPrivateExecutionClient } from "../src/private-execution";

const baseUrl = process.env.GHOLA_BASE_URL ?? "http://localhost:3000";
const apiKey = process.env.GHOLA_AGENT_API_KEY;

if (!apiKey) {
  throw new Error("Set GHOLA_AGENT_API_KEY before running this example.");
}

const ghola = new GholaPrivateExecutionClient({ baseUrl, apiKey });

const policy = {
  version: 1,
  strategy_id: "strategy_example",
  owner_did: "did:key:z6MkExample",
  source_hash: "source_hash_example",
  created_at: "2026-05-25T00:00:00.000Z",
  expires_at: "2026-06-24T00:00:00.000Z",
  mode: "prepare_only",
  trigger: {
    kind: "dca_schedule",
    asset: "ETH",
    cadence: "weekly",
    amount_micro_usdc: 25_000_000,
  },
  allowed_assets: ["ETH", "USDC"],
  quote_asset: "USDC",
  max_trade_micro_usdc: 25_000_000,
  daily_cap_micro_usdc: 25_000_000,
  max_actions_per_day: 1,
  max_slippage_bps: 50,
  allowed_venues: ["railgun_private_swap"],
  public_venue_policy: "deny",
  unshield_policy: "deny",
  amount_bucket_micro_usdc: [25_000_000, 50_000_000, 100_000_000],
  min_delay_seconds: 300,
  require_user_confirmation: true,
};

const proposal = {
  version: 1,
  proposal_id: "proposal_example",
  strategy_id: "strategy_example",
  created_at: "2026-05-25T00:10:00.000Z",
  trigger_seen_at: "2026-05-25T00:00:00.000Z",
  venue: "railgun_private_swap",
  public_amm: false,
  unshield: false,
  destination_address: null,
  destination_label: null,
  known_public_wallet: false,
  base_asset: "ETH",
  quote_asset: "USDC",
  side: "buy",
  amount_micro_usdc: 25_000_000,
  slippage_bps: 30,
  calldata_kind: "railgun_private_swap",
  execution_mode: "prepare_only",
  user_confirmed: true,
};

async function main() {
  const status = await ghola.getPrivateExecutionStatus();
  console.log("ready:", status.ready);
  console.log("blocking:", status.blocking_reasons.join(", ") || "none");
  if (!status.ready) return;

  const simulation = await ghola.simulatePrivateIntent({
    version: 1,
    policy,
    proposal,
  });
  console.log("simulation:", simulation.ok);
  console.log("exposure:", simulation.exposure_report.expected_public_leakage);
  console.log("fee:", simulation.fee_quote);
  if (!simulation.ok) return;

  const receipt = await ghola.executePrivateIntent({
    version: 1,
    intent_id: "intent_example",
    owner_did: "did:key:z6MkExample",
    policy_hash: simulation.policy_hash,
    proposal_hash: simulation.proposal_hash,
    amount_micro_usdc: proposal.amount_micro_usdc,
    rail: "railgun_private_swap",
    encrypted_intent_bundle: {
      alg: "sealed-provider-v1",
      // Replace with a real sealed bundle from the agent runtime. Do not send
      // plaintext strategy, portfolio, prompt, or financial context here.
      ciphertext: "example-sealed-ciphertext",
      recipient: "example-provider-recipient",
      aad: "ghola-private-intent-v1|intent:intent_example",
    },
    // V2 production execution requires provider_result. For this local example,
    // run the server with GHOLA_PRIVATE_EXECUTION_ALLOW_MOCK_RESULT=true or
    // replace this with a signed provider result from your execution adapter.
  });
  console.log("receipt:", receipt.receipt_id);
  console.log("tx_ref:", receipt.tx_ref);

  const verified = await ghola.verifyPrivateExecutionReceipt(receipt);
  console.log("verified:", verified.ok);

  const usage = await ghola.getPrivateExecutionUsage();
  console.log("executions:", usage.execution_count);
  console.log("fees:", usage.total_fee_micro_usdc);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
