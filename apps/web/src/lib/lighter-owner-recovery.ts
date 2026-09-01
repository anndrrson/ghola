import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import {
  LIGHTER_MAINNET_CHAIN_ID,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  lighterAccountIndex,
  lighterOwnerAddress,
} from "./lighter-agent-association";

export const LIGHTER_RECOVERY_IMPLEMENTATION_ADDRESS = getAddress(
  "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
);
export const LIGHTER_RECOVERY_USDC_ADDRESS = getAddress(
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
);
export const LIGHTER_RECOVERY_USDC_ASSET_INDEX = 3 as const;
export const LIGHTER_RECOVERY_PERPS_ROUTE_TYPE = 0 as const;
export const LIGHTER_RECOVERY_PROBE_BASE_AMOUNT = "1000000" as const;
export const LIGHTER_RECOVERY_MAX_GAS = BigInt(300_000);
export const LIGHTER_RECOVERY_MAX_FEE_PER_GAS = BigInt(500_000_000_000);
export const LIGHTER_RECOVERY_MAX_PRIORITY_FEE_PER_GAS = BigInt(50_000_000_000);
export const LIGHTER_EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export const LIGHTER_OWNER_RECOVERY_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accountIndex", type: "uint48" },
      { name: "assetIndex", type: "uint16" },
      { name: "routeType", type: "uint8" },
      { name: "baseAmount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addressToAccountIndex",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "accountIndex", type: "uint48" }],
  },
  {
    type: "function",
    name: "assetConfigs",
    stateMutability: "view",
    inputs: [{ name: "assetIndex", type: "uint16" }],
    outputs: [
      { name: "tokenAddress", type: "address" },
      { name: "withdrawalsEnabled", type: "uint8" },
      { name: "extensionMultiplier", type: "uint56" },
      { name: "tickSize", type: "uint128" },
      { name: "depositCapTicks", type: "uint64" },
      { name: "minDepositTicks", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getPendingBalance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "assetIndex", type: "uint16" },
    ],
    outputs: [{ name: "baseAmount", type: "uint128" }],
  },
] as const;

export interface LighterOwnerRecoveryIntent {
  version: 1;
  chain_id: typeof LIGHTER_MAINNET_CHAIN_ID;
  from: `0x${string}`;
  to: typeof LIGHTER_MAINNET_PROXY_ADDRESS;
  value: "0x0";
  data: Hex;
  function: "withdraw(uint48,uint16,uint8,uint64)";
  account_index: number;
  asset_index: typeof LIGHTER_RECOVERY_USDC_ASSET_INDEX;
  asset: "USDC";
  asset_address: typeof LIGHTER_RECOVERY_USDC_ADDRESS;
  route_type: typeof LIGHTER_RECOVERY_PERPS_ROUTE_TYPE;
  base_amount: typeof LIGHTER_RECOVERY_PROBE_BASE_AMOUNT;
  recipient_address: `0x${string}`;
  recipient_parameter_present: false;
  redirect_possible: false;
  destination_enforced_by: "lighter_contract_owner_mapping";
  transaction_signed: false;
  transaction_broadcast: false;
  submission_available: false;
}

export interface LighterOwnerRecoveryReadinessPayload {
  version: 1;
  audience: "ghola_lighter_owner_recovery_readiness";
  owner_commitment: string;
  owner_address: `0x${string}`;
  account_index: number;
  plan_commitment: Hex;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
}

export function buildLighterOwnerRecoveryIntent(input: {
  ownerAddress: string;
  accountIndex: number;
}): LighterOwnerRecoveryIntent {
  const owner = lighterOwnerAddress(input.ownerAddress);
  const accountIndex = lighterAccountIndex(input.accountIndex);
  return {
    version: 1,
    chain_id: LIGHTER_MAINNET_CHAIN_ID,
    from: owner,
    to: LIGHTER_MAINNET_PROXY_ADDRESS,
    value: "0x0",
    data: encodeFunctionData({
      abi: LIGHTER_OWNER_RECOVERY_ABI,
      functionName: "withdraw",
      args: [
        accountIndex,
        LIGHTER_RECOVERY_USDC_ASSET_INDEX,
        LIGHTER_RECOVERY_PERPS_ROUTE_TYPE,
        BigInt(LIGHTER_RECOVERY_PROBE_BASE_AMOUNT),
      ],
    }),
    function: "withdraw(uint48,uint16,uint8,uint64)",
    account_index: accountIndex,
    asset_index: LIGHTER_RECOVERY_USDC_ASSET_INDEX,
    asset: "USDC",
    asset_address: LIGHTER_RECOVERY_USDC_ADDRESS,
    route_type: LIGHTER_RECOVERY_PERPS_ROUTE_TYPE,
    base_amount: LIGHTER_RECOVERY_PROBE_BASE_AMOUNT,
    recipient_address: owner,
    recipient_parameter_present: false,
    redirect_possible: false,
    destination_enforced_by: "lighter_contract_owner_mapping",
    transaction_signed: false,
    transaction_broadcast: false,
    submission_available: false,
  };
}

export function assertLighterOwnerRecoveryIntent(
  value: unknown,
  expected: { ownerAddress: string; accountIndex: number },
): LighterOwnerRecoveryIntent {
  const plan = record(value);
  const exact = buildLighterOwnerRecoveryIntent(expected);
  if (
    plan.version !== exact.version ||
    plan.chain_id !== exact.chain_id ||
    string(plan.from).toLowerCase() !== exact.from ||
    string(plan.to).toLowerCase() !== exact.to.toLowerCase() ||
    plan.value !== exact.value ||
    string(plan.data).toLowerCase() !== exact.data.toLowerCase() ||
    plan.function !== exact.function ||
    plan.account_index !== exact.account_index ||
    plan.asset_index !== exact.asset_index ||
    plan.asset !== exact.asset ||
    string(plan.asset_address).toLowerCase() !== exact.asset_address.toLowerCase() ||
    plan.route_type !== exact.route_type ||
    plan.base_amount !== exact.base_amount ||
    string(plan.recipient_address).toLowerCase() !== exact.recipient_address ||
    plan.recipient_parameter_present !== false ||
    plan.redirect_possible !== false ||
    plan.destination_enforced_by !== exact.destination_enforced_by ||
    plan.transaction_signed !== false ||
    plan.transaction_broadcast !== false ||
    plan.submission_available !== false
  ) {
    throw new Error("Lighter owner recovery plan is not the fixed no-submit plan.");
  }
  const decoded = decodeFunctionData({ abi: LIGHTER_OWNER_RECOVERY_ABI, data: exact.data });
  if (
    decoded.functionName !== "withdraw" || !decoded.args ||
    Number(decoded.args[0]) !== exact.account_index ||
    Number(decoded.args[1]) !== exact.asset_index ||
    Number(decoded.args[2]) !== exact.route_type ||
    BigInt(decoded.args[3]) !== BigInt(exact.base_amount)
  ) {
    throw new Error("Lighter owner recovery calldata is invalid.");
  }
  return exact;
}

export function lighterOwnerRecoveryPlanCommitment(plan: LighterOwnerRecoveryIntent): Hex {
  const exact = assertLighterOwnerRecoveryIntent(plan, {
    ownerAddress: plan.from,
    accountIndex: plan.account_index,
  });
  return keccak256(stringToHex([
    "ghola/lighter-owner-recovery-plan-v1",
    String(exact.chain_id),
    exact.from,
    exact.to.toLowerCase(),
    exact.value,
    exact.data.toLowerCase(),
    exact.recipient_address,
    "redirect:false",
  ].join("\n")));
}

export function selectLighterRecoveryMasterAccount(input: {
  response: unknown;
  ownerAddress: string;
  requestedAccountIndex?: number | null;
}) {
  const body = record(input.response);
  const owner = lighterOwnerAddress(input.ownerAddress);
  const rows = Array.isArray(body.sub_accounts) ? body.sub_accounts.map(record) : [];
  if (Number(body.code) !== 200 || string(body.l1_address).toLowerCase() !== owner) {
    throw new Error("Lighter accounts could not be verified for this owner wallet.");
  }
  const masters = rows
    .filter((row) => string(row.l1_address).toLowerCase() === owner && Number(row.account_type) === 0)
    .map((row) => lighterAccountIndex(Number(row.index)))
    .sort((left, right) => left - right);
  if (masters.length !== 1) throw new Error("Exactly one Lighter master account is required.");
  if (input.requestedAccountIndex != null && lighterAccountIndex(input.requestedAccountIndex) !== masters[0]) {
    throw new Error("The selected Lighter account is not this wallet's master account.");
  }
  return { owner_address: owner, account_index: masters[0] } as const;
}

export function assertLighterRecoveryUsdcAsset(response: unknown) {
  const body = record(response);
  const rows = Array.isArray(body.asset_details) ? body.asset_details.map(record) : [];
  const row = rows.find((candidate) => Number(candidate.asset_id) === LIGHTER_RECOVERY_USDC_ASSET_INDEX);
  if (
    Number(body.code) !== 200 || !row || row.symbol !== "USDC" ||
    Number(row.l1_decimals) !== 6 || Number(row.decimals) !== 6 ||
    string(row.l1_address).toLowerCase() !== LIGHTER_RECOVERY_USDC_ADDRESS.toLowerCase() ||
    string(row.margin_mode) !== "enabled" ||
    decimalMicrounits(row.min_withdrawal_amount) !== BigInt(LIGHTER_RECOVERY_PROBE_BASE_AMOUNT)
  ) {
    throw new Error("Lighter USDC recovery asset identity could not be verified.");
  }
  return {
    asset_index: LIGHTER_RECOVERY_USDC_ASSET_INDEX,
    symbol: "USDC" as const,
    token_address: LIGHTER_RECOVERY_USDC_ADDRESS,
    decimals: 6 as const,
    minimum_withdrawal_base_amount: LIGHTER_RECOVERY_PROBE_BASE_AMOUNT,
  };
}

export function lighterOwnerRecoveryReadinessMessage(payload: LighterOwnerRecoveryReadinessPayload) {
  return [
    "Ghola Lighter owner recovery readiness",
    "Version: 1",
    "Action: verify_lighter_owner_recovery_readiness",
    `Ghola owner: ${payload.owner_commitment}`,
    `Owner wallet: ${payload.owner_address}`,
    `Lighter account: ${payload.account_index}`,
    `Recovery plan: ${payload.plan_commitment}`,
    `Nonce: ${payload.nonce}`,
    `Issued at: ${new Date(payload.issued_at_ms).toISOString()}`,
    `Expires at: ${new Date(payload.expires_at_ms).toISOString()}`,
    "This proves signing access only.",
    "It does not authorize funding, a withdrawal, a transaction, broadcast, claim, or trade.",
  ].join("\n");
}

function decimalMicrounits(value: unknown) {
  const text = string(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
