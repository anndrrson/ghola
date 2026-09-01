import { venueAdapterCapability } from "@ghola/execution-core";

const ARBITRUM_RPC_URL = "https://arb1.arbitrum.io/rpc";
const HYPERLIQUID_BRIDGE = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
const LIGHTER_NETWORKS_URL = "https://mainnet.zklighter.elliot.ai/api/v1/deposit/networks";
const ASTER_DEPOSIT_ASSETS_URL = "https://www.asterdex.com/bapi/futures/v1/public/future/aster/deposit/assets?chainIds=42161&networks=EVM&accountType=perp";
const ASTER_ETH_PRICE_URL = "https://fapi.asterdex.com/fapi/v3/ticker/price?symbol=ETHUSDT";
const ASTER_ARBITRUM_VAULT = "0x9e36cb86a159d479ced94fa05036f235ac40e1d5";
const ACTIVE_COLLATERAL_ROUTE_STATUSES = new Set(["proven", "implemented_unproven"]);
const CARRY_DEPOSIT_QUOTE_ADAPTERS = Object.freeze({
  hyperliquid_arbitrum_usdc_v1: depositQuoteAdapter("hyperliquid", hyperliquidSupport),
  lighter_arbitrum_usdc_v1: depositQuoteAdapter("lighter", lighterSupport),
  aster_arbitrum_usdt_v1: depositQuoteAdapter("aster", asterSupport),
});

export function registeredCarryDepositQuoteAdapterId(venueId) {
  const declared = venueAdapterCapability(venueId, "collateral_route_observer");
  if (!declared || !ACTIVE_COLLATERAL_ROUTE_STATUSES.has(declared.status)) return null;
  const registered = CARRY_DEPOSIT_QUOTE_ADAPTERS[declared.adapter_id];
  if (!registered || registered.venue_id !== venueId) fail("carry_deposit_adapter_registry_binding_invalid");
  return declared.adapter_id;
}

export function createCarryDepositQuoteReader({
  deposit_policies: depositPolicies,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  return async function readCarryDepositQuote(request) {
    const venueId = String(request?.venue_id || "");
    const checkedAtMs = positiveInteger(request?.checked_at_ms, "carry_deposit_checked_at_invalid");
    const observedAtMs = positiveInteger(now(), "carry_deposit_now_invalid");
    if (Math.abs(observedAtMs - checkedAtMs) > 5_000) fail("carry_deposit_checked_at_stale");
    const policy = depositPolicy(resolvePolicy(depositPolicies, {
      venue_id: venueId,
      checked_at_ms: checkedAtMs,
    }), venueId, checkedAtMs);
    const adapterId = registeredCarryDepositQuoteAdapterId(venueId);
    const adapter = adapterId ? CARRY_DEPOSIT_QUOTE_ADAPTERS[adapterId] : null;
    if (!adapter) fail("carry_deposit_venue_unsupported");
    const supportRead = adapter.read({ request, fetchImpl, checkedAtMs });
    const [support, liveGasFee] = await Promise.all([
      supportRead,
      arbitrumGasFeeUpperBound({ fetchImpl, checkedAtMs, policy }),
    ]);
    if (policy.collateral_asset !== support.collateral_asset
      || policy.destination !== support.destination) {
      fail("carry_deposit_policy_binding_invalid");
    }
    const minimum = Math.max(policy.minimum_transfer_micro_usdc, support.minimum_transfer_micro_usdc);
    if (policy.maximum_transfer_micro_usdc < minimum) fail("carry_deposit_capacity_unavailable");
    if (liveGasFee > policy.fee_ceiling_micro_usdc) fail("carry_deposit_fee_above_policy");
    return Object.freeze({
      kind: "deposit",
      status: "available",
      valuation_asset: "USD",
      venue_id: venueId,
      collateral_asset: support.collateral_asset,
      account_state_commitment: request.destination_account_state_commitment,
      network: "arbitrum",
      chain_id: 42_161,
      destination: support.destination,
      asset_contract_address: support.asset_contract_address,
      verified: true,
      capacity_bound_verified: true,
      fee_upper_bound_verified: true,
      latency_upper_bound_verified: true,
      read_only: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      minimum_transfer_micro_usdc: minimum,
      maximum_transfer_micro_usdc: policy.maximum_transfer_micro_usdc,
      fee_upper_bound_micro_usdc: liveGasFee,
      latency_upper_bound_ms: policy.latency_ceiling_ms,
      as_of_ms: support.as_of_ms,
    });
  };
}

function depositQuoteAdapter(venueId, read) {
  return Object.freeze({ venue_id: venueId, read });
}

async function arbitrumGasFeeUpperBound({ fetchImpl, checkedAtMs, policy }) {
  const [gasResponse, priceResponse] = await Promise.all([
    fetchImpl(ARBITRUM_RPC_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(5_000),
    }),
    fetchImpl(ASTER_ETH_PRICE_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }),
  ]);
  if (!gasResponse?.ok || !priceResponse?.ok) fail("carry_deposit_gas_quote_unavailable");
  const [gasBody, priceBody] = await Promise.all([gasResponse.json(), priceResponse.json()]);
  const gasPriceText = String(gasBody?.result || "");
  if (!/^0x[0-9a-f]+$/i.test(gasPriceText)) fail("carry_deposit_gas_price_invalid");
  const gasPriceWei = BigInt(gasPriceText);
  const ethPriceE8 = decimalToScaled(priceBody?.price, 8, "carry_deposit_eth_price_invalid");
  const priceTimeMs = positiveInteger(priceBody?.time, "carry_deposit_eth_price_time_invalid");
  if (priceTimeMs > checkedAtMs + 5_000 || checkedAtMs - priceTimeMs > 5_000) {
    fail("carry_deposit_eth_price_stale");
  }
  const numerator = BigInt(policy.gas_units_ceiling)
    * gasPriceWei
    * ethPriceE8
    * 1_000_000n
    * BigInt(10_000 + policy.gas_price_buffer_bps);
  const denominator = 1_000_000_000_000_000_000n * 100_000_000n * 10_000n;
  const fee = (numerator + denominator - 1n) / denominator;
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) fail("carry_deposit_gas_fee_invalid");
  return Number(fee);
}

async function hyperliquidSupport({ request, fetchImpl, checkedAtMs }) {
  if (request?.destination_collateral_asset !== "USDC") fail("carry_deposit_asset_unsupported");
  const response = await fetchImpl(ARBITRUM_RPC_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [HYPERLIQUID_BRIDGE, "latest"],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response?.ok) fail("carry_deposit_hyperliquid_bridge_unavailable");
  const body = await response.json();
  if (!/^0x[0-9a-f]+$/i.test(String(body?.result || "")) || body.result === "0x") {
    fail("carry_deposit_hyperliquid_bridge_unavailable");
  }
  return Object.freeze({
    collateral_asset: "USDC",
    destination: HYPERLIQUID_BRIDGE,
    asset_contract_address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    minimum_transfer_micro_usdc: 5_000_000,
    as_of_ms: checkedAtMs,
  });
}

async function lighterSupport({ request, fetchImpl, checkedAtMs }) {
  if (request?.destination_collateral_asset !== "USDC") fail("carry_deposit_asset_unsupported");
  const response = await fetchImpl(LIGHTER_NETWORKS_URL, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response?.ok) fail("carry_deposit_lighter_network_unavailable");
  const body = await response.json();
  const arbitrum = Array.isArray(body?.networks)
    && body.networks.find((network) => String(network?.chain_id) === "42161");
  if (!arbitrum || String(arbitrum.name || "").toLowerCase() !== "arbitrum one") {
    fail("carry_deposit_lighter_network_unavailable");
  }
  return Object.freeze({
    collateral_asset: "USDC",
    destination: "lighter_arbitrum_cctp_intent",
    asset_contract_address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    minimum_transfer_micro_usdc: 5_000_000,
    as_of_ms: checkedAtMs,
  });
}

async function asterSupport({ request, fetchImpl, checkedAtMs }) {
  const asset = String(request?.destination_collateral_asset || "");
  if (!new Set(["USDC", "USDT"]).has(asset)) fail("carry_deposit_asset_unsupported");
  const response = await fetchImpl(ASTER_DEPOSIT_ASSETS_URL, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response?.ok) fail("carry_deposit_aster_assets_unavailable");
  const body = await response.json();
  const row = body?.code === "000000" && body?.success === true && Array.isArray(body?.data)
    ? body.data.find((item) => item?.name === asset && Number(item?.chainId) === 42_161
      && item?.network === "EVM" && item?.depositType === "normal")
    : null;
  const contract = String(row?.contractAddress || "").toLowerCase();
  if (!row || !/^0x[0-9a-f]{40}$/.test(contract) || Number(row?.decimals) !== 6) {
    fail("carry_deposit_aster_assets_unavailable");
  }
  return Object.freeze({
    collateral_asset: asset,
    destination: ASTER_ARBITRUM_VAULT,
    asset_contract_address: contract,
    minimum_transfer_micro_usdc: decimalToMicroCeiling(row.minDeposit ?? 0),
    as_of_ms: checkedAtMs,
  });
}

function resolvePolicy(policies, context) {
  return typeof policies === "function" ? policies(Object.freeze(context)) : policies?.[context.venue_id];
}

function depositPolicy(value, venueId, checkedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || value.venue_id !== venueId
    || !new Set(["USDC", "USDT"]).has(value.collateral_asset)
    || typeof value.destination !== "string"
    || value.verified !== true
    || value.read_only !== true
    || value.owner_approval_required !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false) {
    fail("carry_deposit_policy_invalid");
  }
  const observedAtMs = positiveInteger(value.observed_at_ms, "carry_deposit_policy_time_invalid");
  const expiresAtMs = positiveInteger(value.expires_at_ms, "carry_deposit_policy_expiry_invalid");
  if (observedAtMs > checkedAtMs + 5_000 || expiresAtMs <= checkedAtMs
    || expiresAtMs - observedAtMs > 86_400_000) {
    fail("carry_deposit_policy_stale");
  }
  const minimum = nonnegativeInteger(value.minimum_transfer_micro_usdc, "carry_deposit_policy_minimum_invalid");
  const maximum = positiveInteger(value.maximum_transfer_micro_usdc, "carry_deposit_policy_maximum_invalid");
  if (maximum < minimum) fail("carry_deposit_policy_capacity_invalid");
  return Object.freeze({
    collateral_asset: value.collateral_asset,
    destination: value.destination.toLowerCase(),
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    fee_ceiling_micro_usdc: nonnegativeInteger(value.fee_ceiling_micro_usdc, "carry_deposit_policy_fee_invalid"),
    gas_units_ceiling: boundedInteger(value.gas_units_ceiling, 21_000, 1_000_000, "carry_deposit_policy_gas_units_invalid"),
    gas_price_buffer_bps: boundedInteger(value.gas_price_buffer_bps, 0, 10_000, "carry_deposit_policy_gas_buffer_invalid"),
    latency_ceiling_ms: boundedInteger(value.latency_ceiling_ms, 0, 7 * 86_400_000, "carry_deposit_policy_latency_invalid"),
  });
}

function decimalToScaled(value, decimals, code) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail(code);
  const [whole, fraction = ""] = text.split(".");
  const scale = 10n ** BigInt(decimals);
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(whole) * scale + BigInt(padded || "0");
}

function decimalToMicroCeiling(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) fail("carry_deposit_minimum_invalid");
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}000000`;
  const base = BigInt(whole) * 1_000_000n + BigInt(padded.slice(0, 6));
  const rounded = fraction.length > 6 && /[1-9]/.test(fraction.slice(6)) ? base + 1n : base;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail("carry_deposit_minimum_invalid");
  return Number(rounded);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  const normalized = nonnegativeInteger(value, code);
  if (normalized < minimum || normalized > maximum) fail(code);
  return normalized;
}

function fail(code) {
  throw new Error(code);
}
