"use client";

import { useState } from "react";
import { Check, Copy, Laptop, Lock, ShieldOff, X } from "lucide-react";
import type { ReceiptV1 } from "@/lib/receipt";
import { verifyReceiptAgainstMessage } from "@/lib/receipt";

interface ReceiptBadgeProps {
  receipt: ReceiptV1;
  // The current message text — passed in so "Verify" can re-derive
  // the input/output hashes against what the user actually sees,
  // catching either a tamper or a stale stored receipt.
  prompt: string;
  response: string;
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

export function ReceiptBadge({ receipt, prompt, response }: ReceiptBadgeProps) {
  const [open, setOpen] = useState(false);
  const [verifyState, setVerifyState] = useState<
    "idle" | "ok" | "fail"
  >("idle");
  const [verifyReason, setVerifyReason] = useState<string | undefined>();
  const mode = MODE_STYLE[receipt.mode];
  const Icon = mode.icon;

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${mode.label} receipt — click to inspect`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${mode.cls}`}
      >
        <Icon className="h-3 w-3" />
        {mode.label}
      </button>

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
