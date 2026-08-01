import {
  json,
  privateAccountAgentBillingGate,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";
import { autopilotReadinessForOwner } from "@/lib/private-account-autopilot";
import { deriveAutopilotExecutionDisplay } from "@/lib/private-account-trading-ui";
import { getActivePrivateMobileWalletBinding } from "@/lib/private-account-store";
import {
  mobileWalletCommitment,
  normalizeMobileWalletPubkey,
} from "@/lib/private-account-wallet-binding";

export const dynamic = "force-dynamic";

function positiveIntegerFromEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id") || "BTC-USD";
  const wallet = normalizeMobileWalletPubkey(url.searchParams.get("wallet_pubkey"));
  const walletBindingStatus = wallet
    ? await getActivePrivateMobileWalletBinding({
        owner_commitment: owner.owner_commitment,
        wallet_commitment: mobileWalletCommitment(wallet),
      })
      ? "active" as const
      : "missing" as const
    : "unknown" as const;
  const billing = await privateAccountAgentBillingGate(req);
  const readiness = autopilotReadinessForOwner(productId, process.env, walletBindingStatus);
  const economics = {
    version: 1,
    model: "fee_on_executed_value",
    platform_fee_bps: positiveIntegerFromEnv([
      "PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS",
      "GHOLA_JUPITER_PLATFORM_FEE_BPS",
      "PRIVATE_AGENT_AUTOPILOT_JUPITER_FEE_BPS",
      "GHOLA_AUTOPILOT_JUPITER_FEE_BPS",
    ], 10),
    compute_gate: "paid_private_agent_allowance",
  };
  if (!billing.ok) {
    const blockedReadiness = {
      ...readiness,
      can_arm: false,
      can_live_submit: false,
      blockers: [
        ...billing.blocking_reasons.map((reason) => `billing:${reason}`),
        ...readiness.blockers,
      ].slice(0, 20),
    };
    return json({
      ...blockedReadiness,
      execution_display: deriveAutopilotExecutionDisplay({
        ...blockedReadiness,
        billing: {
          ok: false,
          blocking_reasons: billing.blocking_reasons,
        },
      }),
      billing: {
        ok: false,
        tier: billing.tier,
        required_seconds: billing.required_seconds,
        private_agent_compute: billing.private_agent_compute,
        blocking_reasons: billing.blocking_reasons,
      },
      economics,
    });
  }
  return json({
    ...readiness,
    execution_display: deriveAutopilotExecutionDisplay(readiness),
    billing: {
      ok: true,
      tier: billing.tier,
      required_seconds: billing.required_seconds,
      private_agent_compute: billing.private_agent_compute,
    },
    economics,
  });
}
