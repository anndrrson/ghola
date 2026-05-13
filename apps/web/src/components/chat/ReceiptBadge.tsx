"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Laptop, Lock, ShieldOff, X } from "lucide-react";
import type { ReceiptV1 } from "@/lib/receipt";
import { verifyReceiptAgainstMessage } from "@/lib/receipt";

// First-run callout: the badge is the whole point of the product, and
// a VC who only sends one message could easily miss it. We surface a
// one-time hint next to the latest receipt — and only ever the latest
// one, so historical chat scrollback doesn't show a forest of hints.
// Once dismissed (either explicitly or by opening the modal) the key
// below is set in localStorage and the hint never returns.
const HINT_STORAGE_KEY = "ghola:receipt-hint-seen";
const HINT_DELAY_MS = 800;

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
};

export function ReceiptBadge({
  receipt,
  prompt,
  response,
  isHintAnchor,
}: ReceiptBadgeProps) {
  const [open, setOpen] = useState(false);
  const [verifyState, setVerifyState] = useState<
    "idle" | "ok" | "fail"
  >("idle");
  const [verifyReason, setVerifyReason] = useState<string | undefined>();
  const [hintVisible, setHintVisible] = useState(false);
  const mode = MODE_STYLE[receipt.mode];
  const Icon = mode.icon;

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

  function handleVerify() {
    const res = verifyReceiptAgainstMessage(receipt, prompt, response);
    setVerifyState(res.ok ? "ok" : "fail");
    setVerifyReason(res.reason);
  }

  function handleCopy() {
    void navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
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
            </dl>

            {receipt.attestation_hash === null && (
              <p className="text-[11px] text-[#6f798c] leading-relaxed mb-4">
                v1 receipt: signed by the user&apos;s identity key. Provider
                attestation and on-chain anchor land in v2 — until then,
                this proves what the client observed, not what the cloud
                ran.
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleVerify}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] cursor-pointer"
              >
                <Check className="h-3 w-3" />
                Verify
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-xs font-medium text-[#cfd4dd] hover:border-[#3a4a60] cursor-pointer"
              >
                <Copy className="h-3 w-3" />
                Copy JSON
              </button>
              {verifyState === "ok" && (
                <span className="text-xs text-emerald-400">Signature OK</span>
              )}
              {verifyState === "fail" && (
                <span className="text-xs text-red-400">
                  Verify failed{verifyReason ? `: ${verifyReason}` : ""}
                </span>
              )}
            </div>
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
