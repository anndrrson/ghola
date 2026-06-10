import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import type { TradingStrategyPolicyV1 } from "./trading-strategy";
import { hashTradingStrategyValue } from "./trading-strategy";
import {
  evaluateTradeProposal,
  type PrivacyGuardResult,
  type TradeProposalV1,
} from "./trading-privacy-guard";

export const PRIVATE_EXECUTION_VERSION = 1;
export const DEFAULT_PRIVATE_EXECUTION_FEE_BPS = 10;
export const DEFAULT_PRIVATE_EXECUTION_MIN_FEE_MICRO_USDC = 50_000;

export interface PrivateExecutionAgentConfig {
  agent_id: string;
  label: string;
  fee_bps?: number;
}

export interface PrivateExecutionFeeQuoteV1 {
  version: 1;
  fee_bps: number;
  min_fee_micro_usdc: number;
  amount_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
}

export interface PrivateExecutionSimulateRequestV1 {
  version: 1;
  policy: TradingStrategyPolicyV1;
  proposal: TradeProposalV1;
}

export interface PrivateExecutionSimulateResponseV1 {
  version: 1;
  ok: boolean;
  policy_hash: string;
  proposal_hash: string;
  guard: PrivacyGuardResult;
  fee_quote?: PrivateExecutionFeeQuoteV1;
  exposure_report: PrivateExecutionExposureReportV1;
}

export interface PrivateExecutionExposureReportV1 {
  public_fallback_allowed: false;
  expected_public_leakage:
    | "none_expected_shielded_execution"
    | "blocked_before_execution";
  blocked_reason?: string;
}

export interface PrivateExecutionEncryptedBundleV1 {
  alg: "sealed-provider-v1" | "hpke-x25519-aes256gcm";
  ciphertext: string;
  recipient: string;
  aad: string;
  encapsulated_key?: string;
}

export interface PrivateExecutionExecuteRequestV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  policy_hash: string;
  proposal_hash: string;
  amount_micro_usdc: number;
  rail: "railgun_private_swap";
  encrypted_intent_bundle: PrivateExecutionEncryptedBundleV1;
  provider_result?: PrivateExecutionProviderResultV1;
}

export interface PrivateExecutionProviderResultV1 {
  version: 1;
  provider_id: string;
  rail: "railgun_private_swap";
  tx_ref: string;
  policy_hash: string;
  proposal_hash: string;
  amount_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
  executed_at: string;
  signature: string;
}

export interface PrivateExecutionReceiptV1 {
  version: 1;
  receipt_id: string;
  intent_id: string;
  agent_id: string;
  policy_hash: string;
  proposal_hash: string;
  rail: "railgun_private_swap";
  amount_micro_usdc: number;
  fee_quote: PrivateExecutionFeeQuoteV1;
  provider_id: string;
  executed_at: string;
  tx_ref: string;
  public_fallback_used: false;
  signature: string;
}

export interface PrivateExecutionStatusV1 {
  version: 1;
  ready: boolean;
  supported_rails: Array<"railgun_private_swap">;
  fee_bps: number;
  min_fee_micro_usdc: number;
  fee_recipient_configured: boolean;
  shielded_rail_ready: boolean;
  sealed_provider_ready: boolean;
  provider_result_required: boolean;
  blocking_reasons: string[];
}

const PLAINTEXT_LEAK_KEYS = new Set([
  "account_number",
  "balance",
  "balances",
  "bank_account",
  "cash_balance",
  "counterparty_list",
  "financial_context",
  "invoice",
  "invoices",
  "messages",
  "payroll",
  "payroll_details",
  "plaintext",
  "portfolio",
  "prompt",
  "source",
  "strategy",
  "strategy_text",
  "system_prompt",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function containsPrivateExecutionPlaintextLeak(value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (PLAINTEXT_LEAK_KEYS.has(key)) return true;
    if (containsPrivateExecutionPlaintextLeak(child)) return true;
    if (Array.isArray(child) && child.some(containsPrivateExecutionPlaintextLeak)) {
      return true;
    }
  }
  return false;
}

export function privateExecutionFeeQuote(input: {
  amountMicroUsdc: number;
  feeRecipient: string;
  feeBps?: number;
  minFeeMicroUsdc?: number;
}): PrivateExecutionFeeQuoteV1 {
  const feeBps = input.feeBps ?? DEFAULT_PRIVATE_EXECUTION_FEE_BPS;
  const minFee = input.minFeeMicroUsdc ?? DEFAULT_PRIVATE_EXECUTION_MIN_FEE_MICRO_USDC;
  const proportional = Math.ceil((input.amountMicroUsdc * feeBps) / 10_000);
  return {
    version: 1,
    fee_bps: feeBps,
    min_fee_micro_usdc: minFee,
    amount_micro_usdc: input.amountMicroUsdc,
    fee_micro_usdc: Math.max(minFee, proportional),
    fee_recipient: input.feeRecipient,
  };
}

export function simulatePrivateExecution(input: {
  policy: TradingStrategyPolicyV1;
  proposal: TradeProposalV1;
  feeRecipient?: string;
  feeBps?: number;
  minFeeMicroUsdc?: number;
}): PrivateExecutionSimulateResponseV1 {
  const guard = evaluateTradeProposal(input.policy, input.proposal);
  const response: PrivateExecutionSimulateResponseV1 = {
    version: 1,
    ok: guard.ok,
    policy_hash: hashTradingStrategyValue(input.policy),
    proposal_hash: hashTradingStrategyValue(input.proposal),
    guard,
    exposure_report: {
      public_fallback_allowed: false,
      expected_public_leakage: guard.ok
        ? "none_expected_shielded_execution"
        : "blocked_before_execution",
      ...(!guard.ok ? { blocked_reason: guard.reason } : {}),
    },
  };
  if (guard.ok && input.feeRecipient) {
    response.fee_quote = privateExecutionFeeQuote({
      amountMicroUsdc: input.proposal.amount_micro_usdc,
      feeRecipient: input.feeRecipient,
      feeBps: input.feeBps,
      minFeeMicroUsdc: input.minFeeMicroUsdc,
    });
  }
  return response;
}

export function parsePrivateExecutionAgentKeys(raw: string | undefined): Map<string, PrivateExecutionAgentConfig> {
  if (!raw) return new Map();
  const parsed = JSON.parse(raw) as Record<string, PrivateExecutionAgentConfig>;
  return new Map(Object.entries(parsed));
}

export function privateExecutionReceiptSigningPayload(
  receipt: Omit<PrivateExecutionReceiptV1, "signature">,
): string {
  return stableJson(receipt);
}

export function signPrivateExecutionReceipt(
  receipt: Omit<PrivateExecutionReceiptV1, "signature">,
  secret: string,
): string {
  return bytesToHex(hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(privateExecutionReceiptSigningPayload(receipt))));
}

export function privateExecutionProviderResultSigningPayload(
  result: Omit<PrivateExecutionProviderResultV1, "signature">,
): string {
  return stableJson(result);
}

export function signPrivateExecutionProviderResult(
  result: Omit<PrivateExecutionProviderResultV1, "signature">,
  secret: string,
): string {
  return bytesToHex(
    hmac(
      sha256,
      new TextEncoder().encode(secret),
      new TextEncoder().encode(privateExecutionProviderResultSigningPayload(result)),
    ),
  );
}

export function verifyPrivateExecutionProviderResultSignature(
  result: PrivateExecutionProviderResultV1,
  secret: string,
): boolean {
  const { signature, ...unsigned } = result;
  return signature === signPrivateExecutionProviderResult(unsigned, secret);
}

export function verifyPrivateExecutionReceiptSignature(
  receipt: PrivateExecutionReceiptV1,
  secret: string,
): boolean {
  const { signature, ...unsigned } = receipt;
  return signature === signPrivateExecutionReceipt(unsigned, secret);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
