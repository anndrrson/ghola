import bs58 from "bs58";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { fetchPrivateAgentRuntimeStatus } from "./hyperliquid-vault-seal";

export type PrivateExecutionVenueId = "hyperliquid" | "coinbase_advanced" | "phoenix";
export type PrivateExecutionOperationClass =
  | "limit_order"
  | "perp_limit_order"
  | "spot_limit_order"
  | "spot_market_order"
  | "preview_order"
  | "cancel"
  | "reconcile";

export interface PrivateExecutionOrderDraft {
  venue_id: PrivateExecutionVenueId;
  operation_class: PrivateExecutionOperationClass;
  market: string;
  side: "buy" | "sell";
  base_size: string;
  limit_price: string;
  quote_size?: string;
  max_slippage_bps?: string;
  live_order_mode?: "tiny_fill";
  tif?: "Gtc" | "Ioc" | "Alo" | "gtc" | "ioc" | "fok";
}

export interface PrivateExecutionInstructionBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface BuildPrivateExecutionInstructionBundleOptions {
  ownerWalletAddress: string;
  previewCommitment: string;
  workOrderCommitment?: string | null;
  order: PrivateExecutionOrderDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
  ttlMs?: number;
}

export interface BuildPrivateExecutionInstructionBundleResult {
  encrypted_execution_instruction_bundle: PrivateExecutionInstructionBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
}

const MARKET_RE = /^[A-Za-z0-9/_:-]{2,32}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

export function validatePrivateExecutionOrderDraft(draft: PrivateExecutionOrderDraft): string[] {
  const errors: string[] = [];
  if (
    draft.venue_id !== "hyperliquid" &&
    draft.venue_id !== "coinbase_advanced" &&
    draft.venue_id !== "phoenix"
  ) {
    errors.push("Select a supported venue.");
  }
  if (!MARKET_RE.test(draft.market.trim())) {
    errors.push("Enter a market such as BTC, ETH, BTC-USD, or ETH-USD.");
  }
  if (draft.side !== "buy" && draft.side !== "sell") {
    errors.push("Select buy or sell.");
  }
  const tinyFill =
    (draft.venue_id === "hyperliquid" || draft.venue_id === "phoenix") &&
    draft.live_order_mode === "tiny_fill";
  if (tinyFill) {
    const quoteSize = draft.quote_size?.trim() || "";
    const slippageBps = draft.max_slippage_bps?.trim() || "50";
    if (!DECIMAL_RE.test(quoteSize) || Number(quoteSize) <= 0) {
      errors.push("Enter a live order amount greater than $0.");
    } else if (Number(quoteSize) > 25) {
      errors.push("Live orders are capped at $25.");
    }
    if (draft.venue_id === "hyperliquid" && (!/^\d+$/.test(slippageBps) || Number(slippageBps) < 1 || Number(slippageBps) > 100)) {
      errors.push("Set slippage between 1 and 100 bps.");
    }
    if (
      draft.venue_id === "phoenix" &&
      (!DECIMAL_RE.test(draft.limit_price.trim()) || Number(draft.limit_price) <= 0)
    ) {
      errors.push("Enter a Phoenix price limit greater than 0.");
    }
  } else {
    if (!DECIMAL_RE.test(draft.base_size.trim()) || Number(draft.base_size) <= 0) {
      errors.push("Enter a base size greater than 0.");
    }
    if (
      draft.operation_class !== "spot_market_order" &&
      (!DECIMAL_RE.test(draft.limit_price.trim()) || Number(draft.limit_price) <= 0)
    ) {
      errors.push("Enter a limit price greater than 0.");
    }
  }
  return errors;
}

export async function buildPrivateExecutionInstructionBundle(
  options: BuildPrivateExecutionInstructionBundleOptions,
): Promise<BuildPrivateExecutionInstructionBundleResult> {
  const errors = validatePrivateExecutionOrderDraft(options.order);
  if (errors.length > 0) throw new Error(errors[0]);
  if (!options.previewCommitment.trim() && !options.workOrderCommitment?.trim()) {
    throw new Error("A preview or work-order commitment is required.");
  }
  const runtime = options.runtimeStatus ??
    await (options.fetchRuntimeStatus ?? fetchPrivateAgentRuntimeStatus)();
  const provider = selectedReadyProvider(runtime);
  const recipient = provider?.sealed_recipient;
  if (!recipient) throw new Error("Attested private-agent recipient is unavailable.");
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) throw new Error("Attested private-agent recipient key is invalid.");
  const ownerDid = solanaAddressToDid(options.ownerWalletAddress);
  if (!ownerDid) throw new Error("Turnkey wallet identity is unavailable.");

  const associatedData = privateExecutionInstructionAssociatedData({
    previewCommitment: options.previewCommitment,
    workOrderCommitment: options.workOrderCommitment || null,
    venueId: options.order.venue_id,
    recipientId: recipient.recipient_id,
  });
  const expiresAt = new Date((options.now ?? new Date()).getTime() + (options.ttlMs ?? 5 * 60 * 1000));
  const order = {
    market: normalizeMarket(options.order.market, options.order.venue_id),
    side: options.order.side,
    ...(options.order.live_order_mode === "tiny_fill"
      ? {
          quote_size: options.order.quote_size?.trim(),
          ...(options.order.venue_id === "hyperliquid"
            ? { max_slippage_bps: options.order.max_slippage_bps?.trim() || "50" }
            : {}),
          ...(options.order.venue_id === "phoenix"
            ? { limit_price: options.order.limit_price.trim() }
            : {}),
          live_order_mode: "tiny_fill" as const,
          tif: "Ioc",
        }
      : {
          base_size: options.order.base_size.trim(),
          limit_price: options.order.limit_price.trim(),
          tif: options.order.tif || (options.order.venue_id === "coinbase_advanced" ? "gtc" : "Gtc"),
        }),
  };
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: options.order.venue_id,
    operation_class: options.order.operation_class,
    expires_at: expiresAt.toISOString(),
    order,
  };

  const sealedBytes = await seal({
    senderDid: ownerDid,
    recipientId: recipient.recipient_id,
    recipientX25519,
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(associatedData),
    plaintext: new TextEncoder().encode(JSON.stringify(sealedPlaintext)),
    signBody: options.signBytes,
  });

  return {
    recipient,
    associated_data: associatedData,
    encrypted_execution_instruction_bundle: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(sealedBytes),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
  };
}

export function privateExecutionInstructionAssociatedData(input: {
  previewCommitment?: string | null;
  workOrderCommitment?: string | null;
  venueId: PrivateExecutionVenueId;
  recipientId: string;
}) {
  return [
    "ghola/private-execution-instruction-v1",
    input.workOrderCommitment?.trim()
      ? `work_order:${input.workOrderCommitment.trim()}`
      : `preview:${input.previewCommitment?.trim() || "pending"}`,
    `venue:${input.venueId}`,
    `recipient:${input.recipientId}`,
  ].join("|");
}

function normalizeMarket(market: string, venueId: PrivateExecutionVenueId) {
  const normalized = market.trim().toUpperCase();
  if (venueId === "coinbase_advanced" && !normalized.includes("-")) return `${normalized}-USD`;
  if (venueId === "hyperliquid" && normalized.includes("-")) return normalized.split("-")[0];
  if (venueId === "phoenix" && normalized.includes("-")) return normalized.split("-")[0];
  return normalized;
}

function selectedReadyProvider(
  runtime: PrivateAgentRuntimeStatus,
): ConfidentialComputeProviderStatus | null {
  const selected = runtime.selected_provider
    ? runtime.providers.find((provider) =>
        provider.id === runtime.selected_provider && providerReadyForPrivateAgents(provider)
      ) ?? null
    : null;
  return selected ?? chooseConfidentialComputeProvider(runtime.providers, runtime.preferred_provider);
}

function solanaAddressToDid(address: string): string | null {
  try {
    const pub = bs58.decode(address);
    if (pub.length !== 32) return null;
    return didKeyFromVerifying(pub);
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
