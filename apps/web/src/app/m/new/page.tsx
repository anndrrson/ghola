"use client";

/**
 * /m/new — the 60-second merchant onboarding flow.
 *
 * One screen, three fields: origin URL, auth, price. On submit we call
 * `POST /v1/m/new` which:
 *   1. Mints a vault sub-org + Solana wallet
 *   2. Encrypts the upstream credential
 *   3. Inserts the service_listing
 *   4. Probes the origin live and returns a green-check result
 *
 * On success we redirect to `/m/{slug}/dash` where the merchant sees their
 * wallet, the "fire a test call" button, and a live log tail. Everything
 * else is additive — this screen is the entire adoption funnel.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createMerchant,
  type MerchantAuthMode,
  type NewMerchantResponse,
} from "@/lib/api";

const AUTH_MODES: { value: MerchantAuthMode; label: string; hint: string }[] = [
  { value: "bearer", label: "Bearer token", hint: "Authorization: Bearer <token>" },
  { value: "api_key_header", label: "Custom API key header", hint: "e.g. x-api-key: <key>" },
  { value: "api_key_query", label: "API key query param", hint: "?api_key=<key>" },
  { value: "basic", label: "Basic auth", hint: "user:password" },
  { value: "none", label: "Public (no auth)", hint: "Forward as-is" },
];

export default function NewMerchantPage() {
  const router = useRouter();

  const [originUrl, setOriginUrl] = useState("");
  const [authMode, setAuthMode] = useState<MerchantAuthMode>("bearer");
  const [headerName, setHeaderName] = useState("x-api-key");
  const [credential, setCredential] = useState("");
  const [priceUsd, setPriceUsd] = useState("0.001");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewMerchantResponse | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const micro = Math.round(parseFloat(priceUsd || "0") * 1_000_000);
      if (isNaN(micro) || micro < 0) {
        throw new Error("Price must be a number >= 0");
      }

      const body = {
        origin_url: originUrl.trim(),
        auth_mode: authMode,
        auth_header_name: authMode === "api_key_header" ? headerName : undefined,
        auth_credential: authMode === "none" ? undefined : credential,
        price_micro_usdc: micro,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      };

      const res = await createMerchant(body);
      setResult(res);
      // Redirect to dash after a short ritual beat so the user sees the wallet.
      setTimeout(() => router.push(`/m/${res.slug}/dash?fresh=1`), 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create merchant");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-[#eef1f8] font-[family-name:var(--font-geist-sans)]">
      <div className="mx-auto max-w-2xl px-6 pt-16 pb-24">
        {/* Crumb */}
        <nav className="mb-12 flex items-center gap-3 text-sm">
          <Link href="/" className="text-[#4a5568] hover:text-[#8b95a8]">
            ghola
          </Link>
          <span className="text-[#4a5568] font-mono">/</span>
          <span className="text-[#4a5568]">m</span>
          <span className="text-[#4a5568] font-mono">/</span>
          <span className="text-[#eef1f8] font-medium">new</span>
        </nav>

        {result ? (
          <SuccessCard result={result} />
        ) : (
          <>
            <div className="mb-2 text-[11px] tracking-[0.12em] text-[#8b95a8]">
              › MERCHANT ONBOARDING
            </div>
            <h1 className="mb-4 text-5xl font-medium tracking-[-0.03em] leading-[1.05]">
              Paste your API.
              <br />
              Get paid in 60 seconds.
            </h1>
            <p className="mb-12 max-w-lg text-[15px] leading-relaxed text-[#8b95a8]">
              Three fields. We mint a Solana wallet, encrypt your credential
              in a vault Ghola can&apos;t read, and stand up a proxy at{" "}
              <span className="font-mono text-[#3da8ff]">gateway.ghola.xyz/m/&#123;you&#125;</span>.
              Agents pay USDC per call. We never touch your origin&apos;s access token.
            </p>

            <form onSubmit={handleSubmit} className="space-y-10">
              {/* 1. Origin URL */}
              <Field
                eyebrow="› STEP 01 — YOUR API"
                label="Origin URL"
                hint="Where we forward every call. Example: https://api.example.com/v1"
              >
                <input
                  type="url"
                  required
                  placeholder="https://api.example.com/v1"
                  value={originUrl}
                  onChange={(e) => setOriginUrl(e.target.value)}
                  className="w-full bg-transparent border-0 border-b border-[#1e2a3a] px-0 py-3 text-xl font-mono text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors"
                />
              </Field>

              {/* 2. Auth */}
              <Field
                eyebrow="› STEP 02 — UPSTREAM AUTH"
                label="How should we authenticate with your origin?"
                hint="Encrypted once, decrypted only for a single outbound request at a time. Never logged, never returned in any response."
              >
                <select
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as MerchantAuthMode)}
                  className="mb-6 w-full bg-[#000] border-0 border-b border-[#1e2a3a] px-0 py-3 text-[17px] text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors"
                >
                  {AUTH_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </select>

                {authMode === "api_key_header" && (
                  <input
                    type="text"
                    placeholder="Header name (e.g. x-api-key)"
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                    className="mb-4 w-full bg-transparent border-0 border-b border-[#1e2a3a] px-0 py-2 text-[15px] font-mono text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
                  />
                )}

                {authMode !== "none" && (
                  <input
                    type="password"
                    required
                    autoComplete="off"
                    placeholder={
                      authMode === "basic"
                        ? "user:password"
                        : "paste your secret token"
                    }
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    className="w-full bg-transparent border-0 border-b border-[#1e2a3a] px-0 py-2 text-[15px] font-mono text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
                  />
                )}
              </Field>

              {/* 3. Price */}
              <Field
                eyebrow="› STEP 03 — PRICE PER CALL"
                label="What do you charge per request?"
                hint="USDC. We take a 3% platform fee. $0.001 is a good default."
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl text-[#4a5568]">$</span>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    required
                    value={priceUsd}
                    onChange={(e) => setPriceUsd(e.target.value)}
                    className="w-48 bg-transparent border-0 border-b border-[#1e2a3a] px-0 py-3 text-4xl font-medium tracking-[-0.02em] text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none"
                  />
                  <span className="text-sm font-mono text-[#4a5568]">USDC</span>
                </div>
              </Field>

              {/* Optional metadata (collapsible) */}
              <details className="text-[#8b95a8]">
                <summary className="cursor-pointer select-none text-[11px] tracking-[0.12em]">
                  › OPTIONAL — DISPLAY NAME & DESCRIPTION
                </summary>
                <div className="mt-4 space-y-4">
                  <input
                    type="text"
                    placeholder="Display name (defaults to your domain)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-transparent border-0 border-b border-[#1e2a3a] px-0 py-2 text-[15px] text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
                  />
                  <textarea
                    placeholder="One-line description for your public listing"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    className="w-full bg-transparent border-0 border-b border-[#1e2a3a] px-0 py-2 text-[15px] text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none resize-none"
                  />
                </div>
              </details>

              {error && (
                <div className="border-l-2 border-red-500 bg-red-500/10 px-4 py-3 font-mono text-[13px] text-red-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="bg-[#3da8ff] px-8 py-4 text-[13px] font-medium tracking-[0.12em] text-black hover:bg-[#2d8fe0] disabled:bg-[#1e2a3a] disabled:text-[#4a5568] transition-colors"
              >
                {submitting ? "PROVISIONING WALLET…" : "GO LIVE  →"}
              </button>

              <p className="pt-6 text-xs leading-relaxed text-[#4a5568]">
                No account required. You get a vault-backed Solana wallet the
                moment you click Go Live. We probe your origin for you and show
                you a green check if it answered. You can kill the listing at
                any time from the dashboard.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  eyebrow,
  label,
  hint,
  children,
}: {
  eyebrow: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] tracking-[0.12em] text-[#8b95a8]">
        {eyebrow}
      </div>
      <label className="mb-4 block text-[17px] text-[#eef1f8]">{label}</label>
      {children}
      <p className="mt-3 text-xs text-[#4a5568] leading-relaxed">{hint}</p>
    </div>
  );
}

function SuccessCard({ result }: { result: NewMerchantResponse }) {
  return (
    <div>
      <div className="mb-2 text-[11px] tracking-[0.12em] text-[#3da8ff]">
        › LIVE
      </div>
      <h1 className="mb-6 text-5xl font-medium tracking-[-0.03em]">
        You&apos;re in.
      </h1>
      <p className="mb-10 text-[15px] leading-relaxed text-[#8b95a8]">
        A vault sub-org was minted. Your wallet is below. Redirecting to your
        dashboard…
      </p>

      <div className="space-y-6">
        <Kv label="slug" value={result.slug} mono />
        <Kv label="wallet" value={result.wallet_address} mono />
        <Kv label="gateway" value={result.gateway_url} mono />
        <Kv
          label="origin probe"
          value={
            result.origin_probe.ok
              ? `✓ ${result.origin_probe.status} (${result.origin_probe.latency_ms}ms)`
              : `× ${result.origin_probe.error ?? "no response"}`
          }
          color={result.origin_probe.ok ? "#3da8ff" : "#ef4444"}
        />
      </div>
    </div>
  );
}

function Kv({
  label,
  value,
  mono,
  color,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
}) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.12em] text-[#4a5568] font-mono uppercase">
        {label}
      </div>
      <div
        className={`mt-1 break-all text-[15px] ${mono ? "font-mono" : ""}`}
        style={{ color: color ?? "#eef1f8" }}
      >
        {value}
      </div>
    </div>
  );
}
