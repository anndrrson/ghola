"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Laptop, Link2, Lock, ShieldCheck, ShieldOff, X } from "lucide-react";
import type { ReceiptV1 } from "@/lib/receipt";
import {
  fetchAttestation,
  receiptHashHex,
  verifyProviderSignature,
  verifyReceiptAgainstMessage,
} from "@/lib/receipt";

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
  auto: {
    label: "Secured",
    cls: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    icon: ShieldCheck,
  },
  private: {
    label: "Secured",
    cls: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    icon: Lock,
  },
  local: {
    label: "On-device",
    cls: "text-[#cfd4dd] border-[#3a4a60] bg-white/[0.03]",
    icon: Laptop,
  },
  open: {
    label: "Open",
    cls: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    icon: ShieldOff,
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
}: ReceiptBadgeProps) {
  const [open, setOpen] = useState(false);
  const [verifyState, setVerifyState] = useState<VerifyState>({ kind: "idle" });
  const [anchorState, setAnchorState] = useState<AnchorState>({ kind: "idle" });
  const mode = MODE_STYLE[receipt.mode];
  const Icon = mode.icon;
  const hasAttestation = !!receipt.attestation_hash;

  function handleBadgeClick() {
    setOpen(true);
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
        title={`${mode.label} message — details available`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${mode.cls}`}
      >
        <Icon className="h-3 w-3" />
        {mode.label}
      </button>
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
                  Message security
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

            <p className="mb-4 text-xs leading-5 text-[#8b95a8]">
              This message has a private proof saved in the background. You can
              verify it or open the technical details when you need them.
            </p>

            <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-[11px] mb-5">
              <dt className="text-[#6f798c] uppercase tracking-[0.18em] col-span-1">
                Status
              </dt>
              <dd className="text-[#cfd4dd] col-span-2">{mode.label}</dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Mode
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2">
                {receipt.mode}
              </dd>
              <dt className="text-[#6f798c] uppercase tracking-[0.18em]">
                Issued
              </dt>
              <dd className="text-[#cfd4dd] font-mono col-span-2 truncate">
                {new Date(receipt.issued_at).toISOString()}
              </dd>
            </dl>

            <details className="mb-5 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-3">
              <summary className="cursor-pointer text-xs font-medium text-[#cfd4dd]">
                Technical details
              </summary>
              <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 text-[11px]">
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
            </details>

            {!hasAttestation && (
              <p className="text-[11px] text-[#6f798c] leading-relaxed mb-4">
                Signed by the user&apos;s identity key. No
                attestation chain — this proves what the client observed,
                not what the cloud ran.
              </p>
            )}
            {hasAttestation && (
              <p className="text-[11px] text-[#6f798c] leading-relaxed mb-4">
                Provider-signed inside the enclave and bound to an attestation
                quote. Verification checks signatures and message hashes.
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
                Copy proof
              </button>
              <button
                type="button"
                onClick={handleOpenInVerifier}
                title="Opens the public verifier in a new tab — shareable URL, math runs in the recipient's browser"
                className="inline-flex items-center gap-1.5 rounded-full border border-[#1e2a3a] px-3 py-1.5 text-xs font-medium text-[#cfd4dd] hover:border-[#3a4a60] cursor-pointer"
              >
                <ExternalLink className="h-3 w-3" />
                Open verifier
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
