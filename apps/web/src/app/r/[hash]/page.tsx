"use client";

import { useEffect, useMemo, useState, use } from "react";
import Link from "next/link";
import {
  receiptHashHex,
  verifyReceipt,
  verifyProviderSignature,
  fetchAttestation,
  type ReceiptV1,
  type AttestationDoc,
} from "@/lib/receipt";

// Public receipt verifier — Tier 1D. Anyone with a receipt hash + body
// can paste it in and audit the full chain on their own device, with
// no account, no API call to ghola for the verification math. The hash
// in the URL is for sharing; the receipt body itself comes from the
// chat user (who exports it) or — once `GET /v1/receipts/{hash}` ships
// — from the anchor service.
//
// This page is the show-don't-tell artifact for the privacy claim. A
// journalist, a regulator, or an a16z partner can take any receipt
// and check the math themselves in 30 seconds.

interface ReceiptStatus {
  hashMatch: boolean | null;
  userSignature: { ok: boolean; reason?: string };
  providerSignature: { ok: boolean; reason?: string } | null;
  attestation: { fetched: boolean; doc: AttestationDoc | null; error?: string };
}

export default function ReceiptVerifierPage({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = use(params);
  const [pasted, setPasted] = useState("");
  const [receipt, setReceipt] = useState<ReceiptV1 | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [status, setStatus] = useState<ReceiptStatus | null>(null);

  // Accept `?body=` query param as a convenience for shared links —
  // some chat clients will round-trip the receipt JSON URL-safely.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const body = params.get("body");
    if (body && !pasted) {
      try {
        const decoded = atob(body);
        setPasted(decoded);
        tryParse(decoded);
      } catch {
        // ignore — user can still paste manually
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function tryParse(raw: string) {
    setParseError(null);
    setStatus(null);
    setReceipt(null);
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      setParseError(
        err instanceof Error
          ? `Couldn't parse JSON: ${err.message}`
          : "Couldn't parse JSON.",
      );
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("signature" in parsed) ||
      !("signer_did" in parsed)
    ) {
      setParseError("Not a receipt — missing `signature` or `signer_did`.");
      return;
    }
    setReceipt(parsed as ReceiptV1);
  }

  const computedHash = useMemo(
    () => (receipt ? receiptHashHex(receipt) : null),
    [receipt],
  );

  useEffect(() => {
    if (!receipt) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const userSig = verifyReceipt(receipt);
      let attestation: ReceiptStatus["attestation"] = {
        fetched: false,
        doc: null,
      };
      let providerSig: ReceiptStatus["providerSignature"] = null;
      if (receipt.attestation_hash && receipt.provider_signature) {
        try {
          const doc = await fetchAttestation(receipt.attestation_hash);
          attestation = { fetched: true, doc };
          if (doc?.enclave_ed25519_pub_hex) {
            providerSig = verifyProviderSignature(
              receipt,
              doc.enclave_ed25519_pub_hex,
            );
          }
        } catch (err) {
          attestation = {
            fetched: false,
            doc: null,
            error:
              err instanceof Error
                ? err.message
                : "couldn't fetch attestation",
          };
        }
      }
      if (cancelled) return;
      setStatus({
        hashMatch: computedHash ? computedHash === hash : null,
        userSignature: userSig,
        providerSignature: providerSig,
        attestation,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt, computedHash, hash]);

  return (
    <div className="min-h-screen bg-[#08090d] text-[#eef1f8]">
      <div className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8] hover:text-[#eef1f8]"
        >
          ← ghola
        </Link>
        <h1 className="mt-8 font-display text-4xl md:text-5xl leading-[1.0] font-medium">
          Verify a receipt
        </h1>
        <p className="mt-4 text-[#8b95a8] max-w-2xl leading-relaxed">
          Every reply ghola streams to a user comes with a signed receipt.
          Paste one below to check the signatures and attestation chain on
          your own device. No login, no server call to ghola for the
          verification math.
        </p>

        <div className="mt-10 rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f798c] mb-3">
            Receipt hash from URL
          </div>
          <div className="font-mono text-xs text-[#eef1f8] break-all">
            {hash || "—"}
          </div>
        </div>

        <div className="mt-6">
          <label className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8b95a8] block mb-2">
            Paste the receipt JSON
          </label>
          <textarea
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              tryParse(e.target.value);
            }}
            placeholder='{"version":1,"job_id":"…","mode":"private",…}'
            rows={10}
            className="w-full rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-4 font-mono text-xs text-[#eef1f8] placeholder:text-[#3a4558] focus:outline-none focus:border-[#3da8ff]"
          />
          {parseError && (
            <p className="mt-3 text-sm text-red-300">{parseError}</p>
          )}
        </div>

        {receipt && status && (
          <div className="mt-10 space-y-3">
            <h2 className="font-display text-2xl font-medium mb-4">
              Verification
            </h2>

            <CheckRow
              label="Receipt hash matches URL"
              ok={status.hashMatch === null ? null : status.hashMatch}
              detail={
                status.hashMatch === null
                  ? "no hash in URL to compare"
                  : status.hashMatch
                    ? computedHash ?? undefined
                    : `expected ${hash}, computed ${computedHash}`
              }
            />
            <CheckRow
              label="User signature (signer DID)"
              ok={status.userSignature.ok}
              detail={
                status.userSignature.ok
                  ? receipt.signer_did
                  : (status.userSignature.reason ?? "signature did not verify")
              }
            />
            {receipt.attestation_hash && (
              <CheckRow
                label="Attestation document fetched"
                ok={status.attestation.fetched}
                detail={
                  status.attestation.fetched
                    ? `measurement ${receipt.measurement?.slice(0, 32)}…`
                    : (status.attestation.error ?? "not fetched")
                }
              />
            )}
            {status.providerSignature && (
              <CheckRow
                label="Provider signature (enclave key)"
                ok={status.providerSignature.ok}
                detail={
                  status.providerSignature.ok
                    ? `enclave key ${receipt.enclave_key_id}`
                    : (status.providerSignature.reason ?? "signature did not verify")
                }
              />
            )}

            <div className="mt-8 rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-5 space-y-2 text-sm">
              <Field label="Mode" value={receipt.mode} />
              <Field label="Provider" value={receipt.provider_id} />
              <Field label="Model" value={receipt.model_id ?? "—"} />
              <Field
                label="Issued at"
                value={new Date(receipt.issued_at).toISOString()}
              />
              <Field
                label="Input hash"
                value={receipt.input_token_hash}
                mono
              />
              <Field
                label="Output hash"
                value={receipt.output_token_hash}
                mono
              />
              {receipt.measurement && (
                <Field label="Measurement" value={receipt.measurement} mono />
              )}
              {receipt.enclave_key_id && (
                <Field
                  label="Enclave key id"
                  value={receipt.enclave_key_id}
                  mono
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CheckRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail?: string;
}) {
  const color =
    ok === true
      ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-200"
      : ok === false
        ? "border-red-400/40 bg-red-400/5 text-red-200"
        : "border-[#1e2a3a] text-[#8b95a8]";
  const symbol = ok === true ? "✓" : ok === false ? "✗" : "•";
  return (
    <div
      className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${color}`}
    >
      <span className="font-mono text-sm leading-snug w-4">{symbol}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        {detail && (
          <div className="mt-1 font-mono text-[10px] break-all opacity-80">
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 items-start">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#6f798c] pt-1">
        {label}
      </div>
      <div
        className={`${mono ? "font-mono text-xs" : "text-sm"} text-[#eef1f8] break-all`}
      >
        {value}
      </div>
    </div>
  );
}
