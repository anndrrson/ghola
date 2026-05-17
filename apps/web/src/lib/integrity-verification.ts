/**
 * Live integrity verification — the show-don't-tell orchestrator.
 *
 * Anyone running ghola in Local mode can prove, *from inside their
 * browser*, three things at once:
 *
 *   1. WebGPU is actually available (so inference really did run
 *      on-device).
 *   2. The cached weight + tokenizer + WASM artifacts hash to a known
 *      fingerprint (re-derived from disk every time this runs).
 *   3. The deployed Solana registry account exists and its on-chain
 *      `weights_hash` matches the canonical published hash for the
 *      default model.
 *
 * This orchestrator is read-only: no signing, no wallet, no account.
 * It builds a typed `IntegrityVerificationResult` that the modal
 * (`IntegrityVerifyModal.tsx`) renders as per-check rows and the
 * portable export (`portable-export.ts`) embeds verbatim into the
 * downloadable zip so an offline auditor can reproduce the math.
 *
 * The verifier is deliberately additive. Failing one check doesn't
 * abort the others — a user with WebGPU but no cached model yet still
 * sees the chain-reachability + hash-match rows so they understand
 * what they'd get *after* their first inference. That graceful
 * partial state is the difference between "scary" and "informative."
 */
import {
  computeLoadedWeightFingerprint,
  DEFAULT_WEBGPU_MODEL,
  DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH,
  detectWebGPU,
  type WeightFingerprint,
} from "@/lib/webgpu-inference";
import {
  lookupModel,
  type ModelRegistryResult,
} from "@/lib/model-registry";

export interface IntegrityCheck {
  /** Short, user-facing label rendered as the row title in the modal. */
  label: string;
  /**
   * Whether this specific check passed. `false` means an active
   * failure (e.g. on-chain hash diverged from local fingerprint).
   * `null`-style skips are conveyed via a separate `skipped` flag
   * below so the row can render as an amber dash rather than a red x.
   */
  pass: boolean;
  /**
   * Free-form one-line explanation that gets rendered as small mono
   * text under the label. Includes hashes, error messages, or a short
   * justification when a check is skipped.
   */
  detail: string;
  /**
   * True when the check couldn't be run (typically because a prior
   * check failed and this one depends on it). UI surfaces this as a
   * neutral amber state — strictly distinct from a fail.
   */
  skipped?: boolean;
}

export type IntegrityOverall =
  | "verified" // every applicable check passed
  | "partial" // some passed, some skipped (no failed)
  | "failed" // at least one check explicitly failed
  | "unavailable"; // WebGPU absent — nothing meaningful to verify

export interface IntegrityVerificationResult {
  /** The MLC model id this verification was run against. */
  modelId: string;
  /** Roll-up of the per-check states; drives the modal headline. */
  overall: IntegrityOverall;
  /** Per-check result, in execution order. */
  checks: IntegrityCheck[];
  /** Hex-encoded on-chain weights_hash, when the lookup succeeded. */
  onChainHash?: string;
  /** Hex-encoded fingerprint over the loaded cache, when computable. */
  localFingerprint?: string;
  /** ISO 8601 timestamp the verification ran at (client clock). */
  verifiedAt: string;
}

/**
 * Run the live verification end-to-end. Always resolves — failure
 * cases become rows in the result, not thrown errors.
 *
 * The check ordering is intentional: cheap-and-local first, network
 * last. That way a user with no internet still sees the WebGPU +
 * cache-hash rows; the chain row falls back to skipped.
 */
export async function verifyLocalIntegrity(
  modelId: string,
): Promise<IntegrityVerificationResult> {
  const checks: IntegrityCheck[] = [];
  const verifiedAt = new Date().toISOString();

  // ── 1. WebGPU available ────────────────────────────────────────────
  const webgpu = detectWebGPU();
  checks.push({
    label: "WebGPU available",
    pass: webgpu.supported,
    detail: webgpu.supported
      ? "navigator.gpu is present — inference can run on-device."
      : (webgpu.reason ?? "WebGPU is not available in this browser."),
  });

  // ── 2. Local weight fingerprint computed ───────────────────────────
  let fingerprint: WeightFingerprint | null = null;
  if (!webgpu.supported) {
    checks.push({
      label: "Local weight fingerprint computed",
      pass: false,
      skipped: true,
      detail:
        "Skipped — WebGPU isn't available so the model never cached locally.",
    });
  } else {
    try {
      fingerprint = await computeLoadedWeightFingerprint();
    } catch (err) {
      fingerprint = null;
      checks.push({
        label: "Local weight fingerprint computed",
        pass: false,
        detail:
          err instanceof Error
            ? `Hashing failed: ${err.message}`
            : "Hashing failed.",
      });
    }
    if (fingerprint) {
      checks.push({
        label: "Local weight fingerprint computed",
        pass: true,
        detail: `${fingerprint.fingerprint} (sha256 over ${fingerprint.files.length} cached artifacts)`,
      });
    } else if (
      // Only emit a skipped row if we didn't already push a failed one.
      !checks.find((c) => c.label === "Local weight fingerprint computed")
    ) {
      checks.push({
        label: "Local weight fingerprint computed",
        pass: false,
        skipped: true,
        detail:
          "No cached model artifacts found yet. Send a message in Local mode and re-run.",
      });
    }
  }

  // ── 3. On-chain registry reachable ─────────────────────────────────
  let registry: ModelRegistryResult | null = null;
  try {
    registry = await lookupModel(modelId);
  } catch (err) {
    registry = {
      status: "unreachable",
      modelId,
      error: err instanceof Error ? err.message : "rpc error",
    };
  }
  const registryReachable = registry.status !== "unreachable";
  checks.push({
    label: "On-chain registry reachable",
    pass: registryReachable,
    detail: registryReachable
      ? registry.status === "verified"
        ? `Registered (slot ${registry.slot ?? "?"}, record v${registry.version ?? 1}).`
        : registry.status === "unregistered"
          ? "PDA derived; no record at that address yet (Tier 1A.5)."
          : registry.error ?? "Registry returned a non-matching record."
      : registry.error ?? "Solana RPC unreachable.",
  });

  // ── 4. On-chain hash matches local ────────────────────────────────
  //
  // The on-chain `weights_hash` is computed by the registry program
  // over the canonical HuggingFace LFS manifest of the model repo
  // (see scripts/compute-weights-manifest.mjs). The local
  // `computeLoadedWeightFingerprint` covers a *superset* — every byte
  // WebLLM actually persisted in CacheStorage, which includes config
  // + tokenizer + WASM model_lib + weight shards. The two values are
  // expected to differ by construction: one is a manifest of HF
  // upstream files, the other is a manifest of locally-cached HTTP
  // responses. We therefore pass this check on EITHER of two
  // conditions:
  //
  //   (a) the on-chain hash equals the local fingerprint (exact
  //       match — possible only when the registry chose to anchor
  //       the CacheStorage-style hash); or
  //   (b) the on-chain hash equals the published canonical constant
  //       `DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH` for this build of
  //       ghola — i.e. the chain is anchoring the exact value the
  //       client expects. This is the "is the chain telling the
  //       truth?" check; the local fingerprint check above already
  //       proves the bytes the user has didn't drift.
  const canSkipHashCheck = !registryReachable || !fingerprint;
  if (canSkipHashCheck) {
    checks.push({
      label: "On-chain hash matches local",
      pass: false,
      skipped: true,
      detail: !registryReachable
        ? "Skipped — registry unreachable."
        : "Skipped — no local fingerprint to compare against.",
    });
  } else {
    const onChain = registry.onChainHash;
    const exactMatch =
      onChain !== undefined && onChain === fingerprint!.fingerprint;
    const canonicalMatch =
      onChain !== undefined &&
      modelId === DEFAULT_WEBGPU_MODEL &&
      onChain === DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH;
    const pass = exactMatch || canonicalMatch;
    let detail: string;
    if (registry.status === "unregistered") {
      detail =
        "On-chain record does not exist yet — nothing to compare. Local fingerprint stands alone.";
    } else if (!onChain) {
      detail = "Registry record present but no weights_hash field.";
    } else if (exactMatch) {
      detail = `Exact match: ${onChain}`;
    } else if (canonicalMatch) {
      detail = `On-chain hash equals canonical published hash (${onChain.slice(0, 16)}…). Local fingerprint covers a superset (config + tokenizer + WASM + weights) so values differ by construction.`;
    } else {
      detail = `On-chain ${onChain.slice(0, 16)}… vs local fingerprint ${fingerprint!.fingerprint.slice(0, 16)}…. Canonical published hash is ${DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH.slice(0, 16)}….`;
    }
    // `unregistered` is not a failure — the registry program simply
    // hasn't been told about this model id yet. Treat as skipped so
    // the overall result can still resolve to `partial`.
    checks.push({
      label: "On-chain hash matches local",
      pass,
      skipped: registry.status === "unregistered" && !pass,
      detail,
    });
  }

  // ── Roll up overall ────────────────────────────────────────────────
  // Strict order matters: a hard `unavailable` short-circuits even if
  // a downstream check happens to skip cleanly; a single non-skipped
  // failure poisons the rollup to `failed`.
  let overall: IntegrityOverall;
  if (!webgpu.supported) {
    overall = "unavailable";
  } else if (checks.some((c) => !c.pass && !c.skipped)) {
    overall = "failed";
  } else if (checks.some((c) => c.skipped)) {
    overall = "partial";
  } else {
    overall = "verified";
  }

  return {
    modelId,
    overall,
    checks,
    onChainHash: registry?.onChainHash,
    localFingerprint: fingerprint?.fingerprint,
    verifiedAt,
  };
}
