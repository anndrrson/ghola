const POLICY_TTL_MS = 60_000;

const DEPOSIT_TARGETS = Object.freeze({
  hyperliquid: Object.freeze({
    collateral_asset: "USDC",
    destination: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
  }),
  lighter: Object.freeze({
    collateral_asset: "USDC",
    destination: "lighter_arbitrum_cctp_intent",
  }),
  aster: Object.freeze({
    collateral_asset: "USDT",
    destination: "0x9e36cb86a159d479ced94fa05036f235ac40e1d5",
  }),
});

export function createReadOnlyCarryRuntimePolicies() {
  return Object.freeze({
    deposit_policy_provider: ({ venue_id: venueId, checked_at_ms: checkedAtMs }) => {
      const target = DEPOSIT_TARGETS[venueId];
      if (!target) return null;
      return guardrail({
        venue_id: venueId,
        ...target,
        observed_at_ms: checkedAtMs,
        expires_at_ms: checkedAtMs + POLICY_TTL_MS,
        minimum_transfer_micro_usdc: 0,
        maximum_transfer_micro_usdc: 250_000_000,
        fee_ceiling_micro_usdc: 5_000_000,
        gas_units_ceiling: 250_000,
        gas_price_buffer_bps: 5_000,
        latency_ceiling_ms: 30 * 60_000,
      });
    },
    withdrawal_policy_provider: ({ venue_id: venueId, collateral_asset: collateralAsset, checked_at_ms: checkedAtMs }) => {
      if (!((venueId === "hyperliquid" && collateralAsset === "USDC")
        || (venueId === "aster" && collateralAsset === "USDT"))) return null;
      return guardrail({
        venue_id: venueId,
        collateral_asset: collateralAsset,
        observed_at_ms: checkedAtMs,
        expires_at_ms: checkedAtMs + POLICY_TTL_MS,
        fee_ceiling_micro_usdc: 5_000_000,
        latency_ceiling_ms: 30 * 60_000,
      });
    },
    conversion_policy_provider: ({ checked_at_ms: checkedAtMs }) => guardrail({
      venue_id: "aster",
      market: "USDCUSDT",
      observed_at_ms: checkedAtMs,
      expires_at_ms: checkedAtMs + POLICY_TTL_MS,
      minimum_transfer_micro_usdc: 0,
      maximum_transfer_micro_usdc: 250_000_000,
      fee_ceiling_bps: 25,
      max_slippage_bps: 20,
      latency_ceiling_ms: 30_000,
    }),
  });
}

function guardrail(value) {
  return Object.freeze({
    version: 1,
    verified: true,
    read_only: true,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    ...value,
  });
}
