import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  toHex,
  type Hex,
} from "viem";
import { json, privateAccountLiveGuard } from "../../../../_lib";
import {
  LIGHTER_MAINNET_API_URL,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  lighterOwnerAddress,
} from "@/lib/lighter-agent-association";
import {
  LIGHTER_EIP1967_IMPLEMENTATION_SLOT,
  LIGHTER_OWNER_RECOVERY_ABI,
  LIGHTER_RECOVERY_IMPLEMENTATION_ADDRESS,
  LIGHTER_RECOVERY_MAX_FEE_PER_GAS,
  LIGHTER_RECOVERY_MAX_GAS,
  LIGHTER_RECOVERY_MAX_PRIORITY_FEE_PER_GAS,
  LIGHTER_RECOVERY_PROBE_BASE_AMOUNT,
  LIGHTER_RECOVERY_USDC_ADDRESS,
  LIGHTER_RECOVERY_USDC_ASSET_INDEX,
  assertLighterOwnerRecoveryIntent,
  assertLighterRecoveryUsdcAsset,
  buildLighterOwnerRecoveryIntent,
  lighterOwnerRecoveryPlanCommitment,
  selectLighterRecoveryMasterAccount,
} from "@/lib/lighter-owner-recovery";
import {
  issueLighterOwnerRecoveryReadiness,
  verifyLighterOwnerRecoveryReadinessSignature,
  verifyLighterOwnerRecoveryReadinessToken,
} from "@/lib/lighter-owner-recovery-readiness.server";
import { resolveLighterTurnkeyPerpsOwnerBinding } from "@/lib/lighter-turnkey-owner-binding.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  let ownerAddress: `0x${string}`;
  let requestedAccountIndex: number | null = null;
  let challengeToken = "";
  let ownerSignature = "";
  try {
    if (input.version !== 1 || !onlyKeys(input, [
      "version", "owner_address", "account_index", "challenge_token", "owner_signature",
    ])) throw recoveryError("lighter_recovery_request_invalid", 400);
    ownerAddress = lighterOwnerAddress(string(input.owner_address));
    if (input.account_index !== undefined) requestedAccountIndex = exactInteger(input.account_index);
    challengeToken = string(input.challenge_token);
    ownerSignature = string(input.owner_signature);
    if (Boolean(challengeToken) !== Boolean(ownerSignature)) {
      throw recoveryError("lighter_recovery_challenge_and_signature_required_together", 400);
    }
  } catch (error) {
    return failure(error, "lighter_recovery_request_invalid", 400);
  }

  try {
    await resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: guarded.owner.user.email,
      ownerAddress,
    });
  } catch (error) {
    return failure(error, "lighter_recovery_turnkey_owner_binding_failed", 403);
  }

  let preflight: Awaited<ReturnType<typeof prepareReadiness>>;
  try {
    preflight = await prepareReadiness({ ownerAddress, requestedAccountIndex, env: process.env });
  } catch (error) {
    return failure(error, "lighter_recovery_readiness_unavailable", 503);
  }

  const base = responseBase(preflight);
  if (!preflight.gas.ready) {
    return json({
      ...base,
      error: "lighter_recovery_owner_gas_insufficient",
      status: "blocked",
      headline: "Recovery needs owner gas",
      summary: "The owner-only recovery path is valid, but its exact Ethereum gas reserve is not ready.",
      next_step: "Add only the displayed Ethereum gas reserve to the exact Turnkey owner before funding Lighter.",
      ready: false,
      recovery_readiness_proven: false,
      post_account_recovery_ready: false,
      funding_precondition_satisfied: false,
      initial_funding_safety_proven: false,
      funding_authorized: false,
      blocking_reasons: ["owner_gas_insufficient"],
    }, 409);
  }

  const secret = process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET || "";
  try {
    if (!challengeToken) {
      const challenge = issueLighterOwnerRecoveryReadiness({
        ownerCommitment: guarded.owner.owner_commitment,
        ownerAddress,
        accountIndex: preflight.accountIndex,
        planCommitment: preflight.planCommitment,
        secret,
      });
      return json({
        ...base,
        status: "owner_signature_required",
        headline: "Confirm owner recovery readiness",
        summary: "All no-submit recovery checks passed. Confirm Turnkey owner signing access without creating a transaction.",
        next_step: "Sign the exact readiness message with the Ghola Turnkey owner.",
        ready: false,
        recovery_readiness_proven: false,
        post_account_recovery_ready: false,
        funding_precondition_satisfied: false,
        initial_funding_safety_proven: false,
        funding_authorized: false,
        blocking_reasons: ["turnkey_owner_signature_required"],
        challenge,
      });
    }
    const authorization = verifyLighterOwnerRecoveryReadinessToken({
      challengeToken,
      ownerCommitment: guarded.owner.owner_commitment,
      ownerAddress,
      accountIndex: preflight.accountIndex,
      planCommitment: preflight.planCommitment,
      secret,
    });
    await verifyLighterOwnerRecoveryReadinessSignature({ authorization, signature: ownerSignature });
    return json({
      ...base,
      status: "post_account_recovery_ready",
      headline: "Post-account recovery capability is ready",
      summary: "For this already-active Lighter account, Turnkey owner control, contract, USDC, calldata, gas, and zero redirect were verified without submitting anything.",
      next_step: "Treat this only as post-account recovery capability. It cannot approve or de-risk a brand-new account's initial UDA funding.",
      ready: true,
      recovery_readiness_proven: true,
      post_account_recovery_ready: true,
      funding_precondition_satisfied: false,
      initial_funding_safety_proven: false,
      funding_authorized: false,
      blocking_reasons: [],
      checks: { ...base.checks, owner_signer_verified: true },
      owner_signer: {
        method: "turnkey_eip191_owner_proof",
        owner_address: ownerAddress,
        verified: true,
        transaction_signed: false,
      },
    });
  } catch (error) {
    return failure(error, "lighter_recovery_owner_signature_failed", 403);
  }
}

async function prepareReadiness(input: {
  ownerAddress: `0x${string}`;
  requestedAccountIndex: number | null;
  env: Record<string, string | undefined>;
}) {
  const rpcUrl = input.env.GHOLA_LIGHTER_ETHEREUM_RPC_URL?.trim();
  if (!rpcUrl || !/^https:\/\//i.test(rpcUrl)) {
    throw recoveryError("lighter_recovery_rpc_unconfigured", 503);
  }
  const [accountsResponse, infoResponse, assetResponse, delayResponse] = await Promise.all([
    publicLighterFetch(`/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(input.ownerAddress)}`),
    publicLighterFetch("/info"),
    publicLighterFetch(`/api/v1/assetDetails?asset_id=${LIGHTER_RECOVERY_USDC_ASSET_INDEX}`),
    publicLighterFetch("/api/v1/withdrawalDelay"),
  ]);
  if (!accountsResponse || !infoResponse || !assetResponse || !delayResponse) {
    throw recoveryError("lighter_recovery_public_preflight_unavailable", 503);
  }
  const [accountsBody, infoBody, assetBody, delayBody] = await Promise.all([
    accountsResponse.json().catch(() => null),
    infoResponse.json().catch(() => null),
    assetResponse.json().catch(() => null),
    delayResponse.json().catch(() => null),
  ]);
  if (!accountsResponse.ok) {
    const body = record(accountsBody);
    if (accountsResponse.status === 400 && (Number(body.code) === 21100 || /account not found/i.test(string(body.message)))) {
      throw recoveryError("lighter_recovery_owner_account_not_found", 409);
    }
    throw recoveryError("lighter_recovery_account_lookup_unavailable", 503);
  }
  if (!infoResponse.ok || !assetResponse.ok || !delayResponse.ok) {
    throw recoveryError("lighter_recovery_public_preflight_unavailable", 503);
  }
  const info = record(infoBody);
  if (string(info.contract_address).toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase()) {
    throw recoveryError("lighter_recovery_contract_identity_mismatch", 409);
  }
  let accountIndex: number;
  try {
    accountIndex = selectLighterRecoveryMasterAccount({
      response: accountsBody,
      ownerAddress: input.ownerAddress,
      requestedAccountIndex: input.requestedAccountIndex,
    }).account_index;
    assertLighterRecoveryUsdcAsset(assetBody);
  } catch {
    throw recoveryError("lighter_recovery_owner_account_or_asset_invalid", 409);
  }
  const withdrawalDelaySeconds = exactBoundedInteger(record(delayBody).seconds, 0, 30 * 24 * 60 * 60);
  const intent = assertLighterOwnerRecoveryIntent(
    buildLighterOwnerRecoveryIntent({ ownerAddress: input.ownerAddress, accountIndex }),
    { ownerAddress: input.ownerAddress, accountIndex },
  );
  const mappingData = encodeFunctionData({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "addressToAccountIndex",
    args: [input.ownerAddress],
  });
  const assetConfigData = encodeFunctionData({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "assetConfigs",
    args: [LIGHTER_RECOVERY_USDC_ASSET_INDEX],
  });
  const pendingData = encodeFunctionData({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "getPendingBalance",
    args: [input.ownerAddress, LIGHTER_RECOVERY_USDC_ASSET_INDEX],
  });
  const transaction = { from: intent.from, to: intent.to, value: intent.value, data: intent.data };
  const [
    chainId, code, implementationStorage, mappingResult, assetConfigResult, pendingResult,
    simulationResult, gasEstimateResult, balanceResult, nonceResult, priorityResult, latestBlockResult,
  ] = await Promise.all([
    ethereumRpc(rpcUrl, "eth_chainId", []),
    ethereumRpc(rpcUrl, "eth_getCode", [LIGHTER_MAINNET_PROXY_ADDRESS, "latest"]),
    ethereumRpc(rpcUrl, "eth_getStorageAt", [
      LIGHTER_MAINNET_PROXY_ADDRESS, LIGHTER_EIP1967_IMPLEMENTATION_SLOT, "latest",
    ]),
    ethereumRpc(rpcUrl, "eth_call", [{ to: LIGHTER_MAINNET_PROXY_ADDRESS, data: mappingData }, "latest"]),
    ethereumRpc(rpcUrl, "eth_call", [{ to: LIGHTER_MAINNET_PROXY_ADDRESS, data: assetConfigData }, "latest"]),
    ethereumRpc(rpcUrl, "eth_call", [{ to: LIGHTER_MAINNET_PROXY_ADDRESS, data: pendingData }, "latest"]),
    ethereumRpc(rpcUrl, "eth_call", [transaction, "latest"]),
    ethereumRpc(rpcUrl, "eth_estimateGas", [transaction]),
    ethereumRpc(rpcUrl, "eth_getBalance", [intent.from, "latest"]),
    ethereumRpc(rpcUrl, "eth_getTransactionCount", [intent.from, "pending"]),
    ethereumRpc(rpcUrl, "eth_maxPriorityFeePerGas", []),
    ethereumRpc(rpcUrl, "eth_getBlockByNumber", ["latest", false]),
  ]);
  if (chainId !== "0x1") throw recoveryError("lighter_recovery_chain_identity_mismatch", 409);
  if (!contractCode(code) || implementationAddress(implementationStorage) !== LIGHTER_RECOVERY_IMPLEMENTATION_ADDRESS.toLowerCase()) {
    throw recoveryError("lighter_recovery_contract_identity_mismatch", 409);
  }
  const mappedAccount = Number(decodeFunctionResult({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "addressToAccountIndex",
    data: rpcData(mappingResult),
  }));
  if (mappedAccount !== accountIndex) throw recoveryError("lighter_recovery_owner_account_binding_mismatch", 409);
  const assetConfig = decodeFunctionResult({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "assetConfigs",
    data: rpcData(assetConfigResult),
  });
  if (
    assetConfig[0].toLowerCase() !== LIGHTER_RECOVERY_USDC_ADDRESS.toLowerCase() ||
    Number(assetConfig[1]) !== 1 || BigInt(assetConfig[2]) !== BigInt(1_000_000) ||
    BigInt(assetConfig[3]) !== BigInt(1) ||
    BigInt(assetConfig[4]) < BigInt(LIGHTER_RECOVERY_PROBE_BASE_AMOUNT) ||
    BigInt(assetConfig[5]) !== BigInt(LIGHTER_RECOVERY_PROBE_BASE_AMOUNT)
  ) throw recoveryError("lighter_recovery_asset_config_mismatch", 409);
  const pendingBaseAmount = BigInt(decodeFunctionResult({
    abi: LIGHTER_OWNER_RECOVERY_ABI,
    functionName: "getPendingBalance",
    data: rpcData(pendingResult),
  }));
  if (simulationResult !== "0x") throw recoveryError("lighter_recovery_exact_simulation_failed", 409);
  const estimate = quantity(gasEstimateResult);
  const ownerBalance = quantity(balanceResult, true);
  const nonce = quantity(nonceResult, true);
  const priority = quantity(priorityResult);
  const baseFee = quantity(record(latestBlockResult).baseFeePerGas);
  if (estimate == null || ownerBalance == null || nonce == null || priority == null || baseFee == null) {
    throw recoveryError("lighter_recovery_gas_preflight_invalid", 503);
  }
  const gas = estimate * BigInt(12) / BigInt(10);
  const maxFee = baseFee * BigInt(2) + priority;
  if (
    gas > LIGHTER_RECOVERY_MAX_GAS || priority > LIGHTER_RECOVERY_MAX_PRIORITY_FEE_PER_GAS ||
    maxFee > LIGHTER_RECOVERY_MAX_FEE_PER_GAS || priority > maxFee
  ) throw recoveryError("lighter_recovery_gas_bounds_invalid", 409);
  const requiredWei = gas * maxFee;
  return {
    ownerAddress: input.ownerAddress,
    accountIndex,
    intent,
    planCommitment: lighterOwnerRecoveryPlanCommitment(intent),
    withdrawalDelaySeconds,
    pendingBaseAmount: pendingBaseAmount.toString(),
    gas: {
      ready: ownerBalance >= requiredWei,
      nonce: toHex(nonce),
      gas: toHex(gas),
      max_fee_per_gas: toHex(maxFee),
      max_priority_fee_per_gas: toHex(priority),
      owner_balance_wei: ownerBalance.toString(),
      required_wei: requiredWei.toString(),
    },
  };
}

function responseBase(preflight: Awaited<ReturnType<typeof prepareReadiness>>) {
  return {
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    operation: "owner_recovery_readiness",
    proof_scope: "post_account_recovery_capability_not_initial_funding_or_withdrawal_availability",
    applicability: {
      stage: "post_lighter_account_activation",
      brand_new_account_supported: false,
      pre_uda_funding_gate: false,
      initial_funding_safety_proven: false,
    },
    recovery_plan: {
      ...preflight.intent,
      plan_commitment: preflight.planCommitment,
      simulation: {
        performed: true,
        succeeded: true,
        exact_sender_verified: true,
        exact_contract_verified: true,
        exact_calldata_verified: true,
        proves_contract_acceptance_only: true,
        proves_l2_balance: false,
        proves_withdrawal_execution: false,
      },
    },
    checks: {
      authenticated_session: true,
      owner_signer_verified: false,
      owner_account_binding_verified: true,
      contract_identity_verified: true,
      asset_identity_verified: true,
      exact_calldata_simulated: true,
      gas_ready: preflight.gas.ready,
      zero_redirect_verified: true,
      lighter_balance_verified: false,
      withdrawal_execution_verified: false,
    },
    owner_signer: {
      method: "turnkey_eip191_owner_proof",
      owner_address: preflight.ownerAddress,
      verified: false,
      transaction_signed: false,
    },
    gas: preflight.gas,
    withdrawal_delay_seconds: preflight.withdrawalDelaySeconds,
    pending_base_amount: preflight.pendingBaseAmount,
    safety: {
      no_submit: true,
      transaction_signed: false,
      transaction_broadcast: false,
      claim_available: false,
      withdrawal_authorized: false,
      withdrawal_execution_proven: false,
      funds_moved: false,
      redirect_possible: false,
    },
  };
}

async function publicLighterFetch(path: string) {
  return fetch(new URL(path, LIGHTER_MAINNET_API_URL), {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
}

async function ethereumRpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = record(await response.json().catch(() => null));
  return body.error ? null : body.result;
}

function contractCode(value: unknown) {
  return typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(value) && !/^0x0+$/i.test(value);
}

function implementationAddress(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return "";
  try {
    return getAddress(`0x${value.slice(-40)}`).toLowerCase();
  } catch {
    return "";
  }
}

function rpcData(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) {
    throw recoveryError("lighter_recovery_rpc_data_invalid", 503);
  }
  return value as Hex;
}

function quantity(value: unknown, allowZero = false) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > BigInt(0) || (allowZero && parsed === BigInt(0)) ? parsed : null;
}

function exactInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(value).trim() === "") {
    throw recoveryError("lighter_recovery_account_index_invalid", 400);
  }
  return parsed;
}

function exactBoundedInteger(value: unknown, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw recoveryError("lighter_recovery_withdrawal_delay_invalid", 503);
  }
  return parsed;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function recoveryError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}

function failure(error: unknown, fallback: string, fallbackStatus: number) {
  const value = record(error);
  const code = typeof value.code === "string" ? value.code : fallback;
  const status = Number.isInteger(value.status) ? Number(value.status) : fallbackStatus;
  return json({
    error: code,
    status: "blocked",
    ready: false,
    recovery_readiness_proven: false,
    post_account_recovery_ready: false,
    funding_precondition_satisfied: false,
    initial_funding_safety_proven: false,
    funding_authorized: false,
    applicability: {
      stage: "post_lighter_account_activation",
      brand_new_account_supported: false,
      pre_uda_funding_gate: false,
    },
    transaction_signed: false,
    transaction_broadcast: false,
    funds_moved: false,
  }, status);
}
