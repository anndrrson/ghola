"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Laptop, Link2, Lock, ShieldOff, X } from "lucide-react";
import type { ReceiptV1 } from "@/lib/receipt";
import {
  fetchAttestation,
  receiptHashHex,
  verifyProviderSignature,
  verifyReceiptAgainstMessage,
} from "@/lib/receipt";

// First-run callout: the badge is the whole point of the product, and
// a VC who only sends one message could easily miss it. We surface a
// one-time hint next to the latest receipt — and only ever the latest
// one, so historical chat scrollback doesn't show a forest of hints.
// Once dismissed (either explicitly or by opening the modal) the key
// below is set in localStorage and the hint never returns.
const HINT_STORAGE_KEY = "ghola:receipt-hint-seen";
const HINT_DELAY_MS = 800;

// The receipts service hosts /v1/receipts/<hash>/proof. Separate from
// the relay because it's a different service with its own retention +
// access semantics — see crates/said-receipts-service.
function receiptsServiceBase(): string {
  if (typeof process !== "undefined" && process.env) {
    const url = process.env.NEXT_PUBLIC_RECEIPTS_SERVICE_URL;
    if (url) return url;
  }
  return "http://localhost:3001";
}

interface ReceiptsProofResponse {
  receipt_hash: string;
  merkle_root_hex: string;
  solana_signature: string;
  period_start_unix: number;
  period_end_unix: number;
  proof_path?: string[];
}

function markHintSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HINT_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable; the hint will reappear next session, no harm.
  }
}

function hintAlreadySeen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(HINT_STORAGE_KEY) !== null;
  } catch {
    return true;
  }
}

interface ReceiptBadgeProps {
  receipt: ReceiptV1;
  // The current message text — passed in so "Verify" can re-derive
  // the input/output hashes against what the user actually sees,
  // catching either a tamper or a stale stored receipt.
  prompt: string;
  response: string;
  // True for the single most-recent receipt in the chat. Only that
  // badge is eligible to show the first-run hint, so loading old
  // chats doesn't repopulate hints next to every historical message.
  isHintAnchor?: boolean;
}

const MODE_STYLE: Record<
  ReceiptV1["mode"],
  { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }
> = {
  private: {
    label: "Private",
    cls: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    icon: Lock,
  },
  local: {
    label: "Local",
    cls: "text-[#cfd4dd] border-[#3a4a60] bg-white/[0.03]",
    icon: Laptop,
  },
  open: {
    label: "Open",
    cls: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    icon: ShieldOff,
  },
  auto: {
    label: "Auto",
    cls: "text-sky-300 border-sky-500/30 bg-sky-500/10",
    icon: Link2,
  },
};

type VerifyState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "done";
      user: { ok: boolean; reason?: string };
      provider?: { ok: boolean; reason?: string };
    };

type AnchorState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "done";
      status: "anchored" | "pending" | "missing" | "error";
      detail: string;
    };

export function ReceiptBadge({
  receipt,
  prompt,
  response,
  isHintAnchor,
}: ReceiptBadgeProps) {
  const [open, setOpen] = useState(false);
  const [verifyState, setVerifyState] = useState<VerifyState>({ kind: "idle" });
  const [anchorState, setAnchorState] = useState<AnchorState>({ kind: "idle" });
  const [hintVisible, setHintVisible] = useState(false);
  const mode = MODE_STYLE[receipt.mode];
  const Icon = mode.icon;
  const hasAttestation = !!receipt.attestation_hash;

  // Show the hint exactly once, after a beat. The beat matters — if
  // the hint appears in the same paint as the badge it reads as
  // visual clutter, not a deliberate pointer.
  useEffect(() => {
    if (!isHintAnchor) return;
    if (hintAlreadySeen()) return;
    const timer = setTimeout(() => setHintVisible(true), HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isHintAnchor]);

  function dismissHint() {
    if (!hintVisible) return;
    setHintVisible(false);
    markHintSeen();
  }

  function handleBadgeClick() {
    setOpen(true);
    // Clicking the badge means the user got the point — drop the
    // hint so it doesn't reappear next session.
    dismissHint();
  }

  async function handleVerify() {
    setVerifyState({ kind: "running" });
    // (1) User signature + hash re-derivation. Sync, cheap, runs first
    // so a stale receipt fails fast before we burn a network round
    // trip on the attestation lookup.
    const user = verifyReceiptAgainstMessage(receipt, prompt, response);

    // (2) If the receipt carries an attestation_hash, fetch the
    // attestation doc from the relay and verify the provider sig
    // against the enclave Ed25519 pub. Failure here is interesting
    // but doesn't override the user-side result — surface both.
    let provider: { ok: boolean; reason?: string } | undefined;
    if (receipt.attestation_hash) {
      try {
        const att = await fetchAttestation(receipt.attestation_hash);
        if (!att) {
          provider = { ok: false, reason: "attestation not found on relay" };
        } else {
          provider = verifyProviderSignature(
            receipt,
            att.enclave_ed25519_pub_hex,
          );
        }
      } catch (err) {
        provider = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    setVerifyState({ kind: "done", user, provider });
  }

  async function handleCheckOnChain() {
    if (!receipt.attestation_hash) return;
    setAnchorState({ kind: "running" });
    try {
      const hash = receiptHashHex(receipt);
      const url = new URL(
        `/v1/receipts/${encodeURIComponent(hash)}/proof`,
        receiptsServiceBase(),
      );
      const res = await fetch(url.toString(), { method: "GET" });
      if (res.status === 200) {
        const body = (await res.json()) as ReceiptsProofResponse;
        const start = new Date(body.period_start_unix * 1000).toISOString();
        const end = new Date(body.period_end_unix * 1000).toISOString();
        setAnchorState({
          kind: "done",
          status: "anchored",
          detail: `Anchored at Solana tx ${body.solana_signature}, period ${start} — ${end}, root ${body.merkle_root_hex.slice(0, 16)}…`,
        });
      } else if (res.status === 202) {
        setAnchorState({
          kind: "done",
          status: "pending",
          detail: "Pending — anchored within the next hour.",
        });
      } else if (res.status === 404) {
        setAnchorState({
          kind: "done",
          status: "missing",
          detail:
            "Receipt not found in batcher — your message may not have been submitted yet.",
        });
      } else {
        setAnchorState({
          kind: "done",
          status: "error",
          detail: `Receipts service returned HTTP ${res.status}.`,
        });
      }
    } catch (err) {
      setAnchorState({
        kind: "done",
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
  }

  // Open the public verifier (/r/[hash]) in a new tab with the receipt
  // body packed into the URL. The verifier does all math client-side,
  // so this is the share-with-anyone path: paste the URL and the
  // recipient can audit the chain on their own device with no login.
  function handleOpenInVerifier() {
    const hash = receiptHashHex(receipt);
    // btoa needs a string-safe input. Receipts are JSON — ASCII-safe
    // after JSON.stringify (no raw multibyte chars in the fields we
    // use today). If that ever changes, swap to a UTF-8-safe encoder.
    const body = btoa(JSON.stringify(receipt));
    const url = `/r/${hash}?body=${encodeURIComponent(body)}`;
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
    }
  }

  return (
    <>
      <div className="inline-flex flex-col items-start gap-2 max-w-sm">
      <button
        type="button"
        onClick={handleBadgeClick}
        title={`${mode.label} receipt — click to inspect`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${mode.cls}`}
      >
        <Icon className="h-3 w-3" />
        {mode.label}
      </button>
      {hintVisible && <ReceiptHint onDismiss={dismissHint} />}
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${mode.cls.split(" ")[0]}`} />
                <h3 className="text-sm font-semibold text-[#eef1f8]">
                  {mode.label} receipt
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-[11px] mb-5">
              <dt className="text-[#6f798c] uppercase tracking-[0.18em] col-span-1">
                Job
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {receipt.job_id}
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Model
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {receipt.model_id ?? "—"}
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Provider
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {receipt.provider_id}
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Input
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {receipt.input_token_hash.slice(0, 16)}…
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Output
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {receipt.output_token_hash.slice(0, 16)}…
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Issued
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {new Date(receipt.issued_at).toISOString()}
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Signer
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {receipt.signer_did}
              </dd>
              {hasAttestation && (
                <>
                  <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                    Enclave
                  </dt>
                  <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                    {receipt.enclave_key_id?.slice(0, 16)}…
                  </dd>
                  <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                    Attest.
                  </dt>
                  <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                    {receipt.attestation_hash?.slice(0, 16)}…
                  </dd>
                  <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                    Measure
                  </dt>
                  <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                    {receipt.measurement?.slice(0, 16)}…
                  </dd>
                </>
              )}
            </dl>

            {!hasAttestation && (
              <p className="text-[11px] text-[#6f798c] leading-relaxed mb-4">
                v1 receipt: signed by the user&apos;s identity key. No
                attestation chain — this proves what the client observed,
                not what the cloud ran.
              </p>
            )}
            {hasAttestation && (
              <p className="text-[11px] text-[#6f798c] leading-relaxed mb-4">
                v2 receipt: provider-signed inside the enclave and bound
                to an attestation quote. Verify checks both signatures
                and re-derives the message hashes; Check on-chain
                queries the receipts service for a Merkle proof.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleVerify}
                disabled={verifyState.kind === "running"}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] cursor-pointer disabled:opacity-60"
              >
                <Check className="h-3 w-3" />
                {verifyState.kind === "running" ? "Verifying…" : "Verify"}
              </button>
              {hasAttestation && (
                <button
                  type="button"
                  onClick={handleCheckOnChain}
                  disabled={anchorState.kind === "running"}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-xs font-medium text-[#cfd4dd] hover:border-[#3a4a60] cursor-pointer disabled:opacity-60"
                >
                  <Link2 className="h-3 w-3" />
                  {anchorState.kind === "running"
                    ? "Checking…"
                    : "Check on-chain"}
                </button>
              )}
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-xs font-medium text-[#cfd4dd] hover:border-[#3a4a60] cursor-pointer"
              >
                <Copy className="h-3 w-3" />
                Copy JSON
              </button>
              <button
                type="button"
                onClick={handleOpenInVerifier}
                title="Opens the public verifier in a new tab — shareable URL, math runs in the recipient's browser"
                className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-xs font-medium text-[#cfd4dd] hover:border-[#3a4a60] cursor-pointer"
              >
                <ExternalLink className="h-3 w-3" />
                Open in verifier
              </button>
            </div>

            {verifyState.kind === "done" && (
              <div className="mt-4 space-y-1.5 text-[11px]">
                <div>
                  <span className="text-[#6f798c]">User signature: </span>
                  {verifyState.user.ok ? (
                    <span className="text-emerald-400">OK</span>
                  ) : (
                    <span className="text-red-400">
                      failed{verifyState.user.reason ? ` (${verifyState.user.reason})` : ""}
                    </span>
                  )}
                </div>
                {verifyState.provider && (
                  <div>
                    <span className="text-[#6f798c]">Provider signature: </span>
                    {verifyState.provider.ok ? (
                      <span className="text-emerald-400">OK</span>
                    ) : (
                      <span className="text-red-400">
                        failed
                        {verifyState.provider.reason
                          ? ` (${verifyState.provider.reason})`
                          : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {anchorState.kind === "done" && (
              <div className="mt-3 text-[11px] leading-relaxed">
                {anchorState.status === "anchored" && (
                  <span className="text-emerald-400">{anchorState.detail}</span>
                )}
                {anchorState.status === "pending" && (
                  <span className="text-amber-300">{anchorState.detail}</span>
                )}
                {anchorState.status === "missing" && (
                  <span className="text-[#cfd4dd]">{anchorState.detail}</span>
                )}
                {anchorState.status === "error" && (
                  <span className="text-red-400">{anchorState.detail}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// First-run hint. Anchored under the badge with a small upward
// chevron — visually obvious that the callout points to the pill
// above it, no big arrow needed. Restrained palette and typography:
// same colors and weights as /security so it reads as part of the
// product, not as an onboarding gimmick. No animation, no celebratory
// language. Dismisses on the "Got it" link or when the user clicks
// the badge (handled in the parent).
function ReceiptHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative w-full max-w-[320px]"
    >
      {/* Chevron pointing up at the badge. Square rotated 45° with
          the two visible borders matching the card's border — gives
          a single mitered point instead of a bare triangle. */}
      <span
        aria-hidden
        className="absolute -top-[5px] left-3 block h-2.5 w-2.5 rotate-45 border-l border-t border-[#1e2a3a] bg-[#0a0b10]"
      />
      <div className="relative rounded-lg border border-[#1e2a3a] bg-[#0a0b10] px-3 py-2.5">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#3da8ff] mb-0.5">
              Receipt
            </div>
            <p className="text-[11px] text-[#cfd4dd] leading-relaxed">
              Tap to verify where this message actually ran.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-[10px] text-[#6f798c] hover:text-[#cfd4dd] cursor-pointer shrink-0 pt-0.5"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
