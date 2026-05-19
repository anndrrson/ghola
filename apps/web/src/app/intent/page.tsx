"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  FileCheck2,
  Loader2,
  LockKeyhole,
  ReceiptText,
  Search,
  ShieldCheck,
  ShoppingBag,
} from "lucide-react";
import {
  createCommerceIntent,
  createCommerceQuote,
  executeCommerceQuote,
  listCommerceOffers,
} from "@/lib/thumper-api";
import type {
  CommerceExecution,
  CommerceIntent,
  CommerceOffer,
  CommerceQuote,
} from "@/lib/thumper-types";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  type PaymentHealth,
  formatMicroUsd,
  summarizePrivateBalance,
} from "@/lib/private-balance";

type Step = "ask" | "offers" | "quote" | "approval" | "receipt";

const steps: Array<{ id: Step; label: string }> = [
  { id: "ask", label: "Ask" },
  { id: "offers", label: "Options" },
  { id: "quote", label: "Quote" },
  { id: "approval", label: "Approve" },
  { id: "receipt", label: "Receipt" },
];

function approvalNonce() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `commerce-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function railLabel(rail: string) {
  if (rail === "aleo_usdcx_shielded" || rail === "shielded_stablecoin") {
    return "Private USDCx";
  }
  if (rail === "solana_public_usdc" || rail === "solana_public_stablecoin") {
    return "Public USDC";
  }
  return rail.replaceAll("_", " ");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

async function fetchPaymentHealth(): Promise<PaymentHealth | null> {
  const res = await fetch("/api/payments/health", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as PaymentHealth;
}

export default function IntentPage() {
  const thumperAuth = useThumperAuth();
  const [goal, setGoal] = useState(
    "Find a privacy-friendly AI service I can pay for."
  );
  const [budgetUsd, setBudgetUsd] = useState("5.00");
  const [privacyMode, setPrivacyMode] = useState<"private" | "open">("private");
  const [intent, setIntent] = useState<CommerceIntent | null>(null);
  const [offers, setOffers] = useState<CommerceOffer[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [quote, setQuote] = useState<CommerceQuote | null>(null);
  const [execution, setExecution] = useState<CommerceExecution | null>(null);
  const [approved, setApproved] = useState(false);
  const [paymentHealth, setPaymentHealth] = useState<PaymentHealth | null>(null);
  const [loading, setLoading] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchPaymentHealth().then(setPaymentHealth).catch(() => setPaymentHealth(null));
  }, []);

  const privateSummary = summarizePrivateBalance(paymentHealth);
  const selectedOffer = useMemo(
    () => offers.find((offer) => offer.offer_id === selectedOfferId) ?? null,
    [offers, selectedOfferId]
  );
  const activeStep: Step = execution
    ? "receipt"
    : quote
      ? "approval"
      : selectedOffer
        ? "quote"
        : offers.length
          ? "offers"
          : "ask";
  const receipt = execution?.receipt.receipt ?? {};
  const fundedStatus =
    stringValue(receipt.funded_private_settlement_status) ??
    "funded_usdcx_proof_pending";
  const railStatusKnown = paymentHealth !== null;
  const railReadyLabel = !railStatusKnown
    ? "Checking private payments"
    : privateSummary.privateSpendReady
      ? "Private payments ready"
      : "Private payments paused";
  const railDetail = !railStatusKnown
    ? "Checking private rail status."
    : privateSummary.privateSpendReady
      ? "USDCx is configured. Private checkout will not fall back to public USDC."
      : privateSummary.detail;
  const railPillClass = !railStatusKnown
    ? "border-[#263449] bg-[#0c0f15] text-[#9fb2cc]"
    : privateSummary.privateSpendReady
      ? "border-[#24452d] bg-[#0d1510] text-[#a7f3b5]"
      : "border-[#4d2e22] bg-[#1a100d] text-[#ffc7aa]";

  async function submitIntent() {
    setError(null);
    setExecution(null);
    setQuote(null);
    setApproved(false);
    const budget = Math.round(Number(budgetUsd || "0") * 1_000_000);
    if (!goal.trim()) {
      setError("Tell Ghola what you want to buy or pay for.");
      return;
    }
    if (!Number.isFinite(budget) || budget <= 0) {
      setError("Budget must be greater than zero.");
      return;
    }

    setLoading("ask");
    try {
      const created = await createCommerceIntent({
        goal,
        budget_micro_usdc: budget,
        privacy_mode: privacyMode,
        preferred_rail: privacyMode === "private" ? "aleo_usdcx_shielded" : "solana_public_usdc",
        allowed_adapters: ["fixture_catalog", "x402_agent", "merchant_checkout"],
      });
      setIntent(created);
      setLoading("offers");
      const discovered = await listCommerceOffers(created.id);
      setOffers(discovered);
      setSelectedOfferId(discovered.find((offer) => offer.available)?.offer_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not discover options.");
    } finally {
      setLoading(null);
    }
  }

  async function quoteOffer() {
    if (!intent || !selectedOffer) return;
    setError(null);
    setExecution(null);
    setApproved(false);
    setLoading("quote");
    try {
      const nextQuote = await createCommerceQuote(intent.id, {
        offer_id: selectedOffer.offer_id,
        rail: selectedOffer.rail,
      });
      setQuote(nextQuote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create quote.");
    } finally {
      setLoading(null);
    }
  }

  async function approveAndPay() {
    if (!intent || !quote) return;
    setError(null);
    setLoading("approval");
    try {
      const approvedAt = new Date().toISOString();
      const summary = `Approved ${quote.provider_label ?? quote.offer_id} for ${formatMicroUsd(
        quote.amount_micro_usdc
      )} via ${railLabel(quote.rail)}.`;
      const result = await executeCommerceQuote(intent.id, {
        quote_id: quote.id,
        privacy_mode: "strictLocal",
        network_scope: "commerceExecution",
        user_approved_at: approvedAt,
        approval_nonce: approvalNonce(),
        approval_summary: summary,
      });
      setExecution(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete checkout.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      <section className="border-b border-[#151b26] px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[#203149] bg-[#0d121c] px-3 py-1 text-xs text-[#9fb2cc]">
              <ShoppingBag className="h-3.5 w-3.5 text-[#3da8ff]" />
              Shop / Pay
            </div>
            <h1 className="mt-3 max-w-2xl text-2xl font-medium tracking-tight text-[#f6f8ff] sm:text-3xl">
              Find it. Approve it. Pay privately.
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${railPillClass}`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {railReadyLabel}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#263449] bg-[#0c0f15] px-3 py-1.5 text-[#9fb2cc]">
              <LockKeyhole className="h-3.5 w-3.5" />
              Approval required
            </span>
          </div>
        </div>
      </section>

      <section className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="space-y-5">
            <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15] shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
              <div className="grid gap-4 p-4 sm:p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-medium text-[#f6f8ff]">
                      What do you want to buy or pay for?
                    </h2>
                    <p className="mt-1 text-xs text-[#7f8ca3]">
                      Ghola shows options first. Nothing is paid until you approve.
                    </p>
                  </div>
                  {!thumperAuth.loading && !thumperAuth.authenticated && (
                    <span className="inline-flex rounded-full border border-[#4d2e22] bg-[#1a100d] px-3 py-1.5 text-xs text-[#ffc7aa]">
                      Sign in to continue
                    </span>
                  )}
                </div>
                {error && (
                  <div className="flex items-start gap-3 rounded-md border border-[#5a2430] bg-[#1b0d13] px-4 py-3 text-sm text-[#ffb4c0]">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  className="min-h-24 resize-y rounded-md border border-[#263449] bg-[#08090d] px-3 py-3 text-base leading-6 text-[#eef1f8] outline-none transition placeholder:text-[#5b6880] focus:border-[#3da8ff]"
                  maxLength={1200}
                  placeholder="Example: Find a privacy-friendly AI tool under $5."
                />
                <div className="grid gap-3 md:grid-cols-[9rem_minmax(15rem,1fr)_auto] md:items-end">
                  <label className="grid gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#6f7d9a]">
                      Budget
                    </span>
                    <input
                      value={budgetUsd}
                      onChange={(event) => setBudgetUsd(event.target.value)}
                      inputMode="decimal"
                      className="h-10 rounded-md border border-[#263449] bg-[#08090d] px-3 text-sm text-[#eef1f8] outline-none transition focus:border-[#3da8ff]"
                    />
                  </label>
                  <div className="grid gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#6f7d9a]">
                      Payment mode
                    </span>
                    <div className="grid h-10 grid-cols-2 overflow-hidden rounded-md border border-[#263449] bg-[#08090d]">
                      {(["private", "open"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setPrivacyMode(mode)}
                          className={`text-sm font-medium transition ${
                            privacyMode === mode
                              ? "bg-[#182536] text-[#eef1f8]"
                              : "text-[#7f8ca3] hover:text-[#eef1f8]"
                          }`}
                        >
                          {mode === "private" ? "Private USDCx" : "Public USDC"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={submitIntent}
                    disabled={!!loading || !thumperAuth.authenticated}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#3da8ff] px-4 text-sm font-medium text-[#07111d] transition hover:bg-[#67bbff] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading === "ask" || loading === "offers" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Find options
                  </button>
                </div>
              </div>
            </section>

            <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15]">
              <div className="flex items-center justify-between border-b border-[#1e2a3a] px-4 py-3 sm:px-5">
                <h2 className="text-sm font-medium text-[#f6f8ff]">Options</h2>
                <span className="text-xs text-[#6f7d9a]">{offers.length} found</span>
              </div>
              <div className="divide-y divide-[#151b26]">
                {offers.length === 0 ? (
                  <div className="grid gap-3 px-4 py-6 text-sm text-[#7f8ca3] sm:px-5 sm:grid-cols-3">
                    <span className="rounded-md border border-[#1a2635] bg-[#090d13] p-3">
                      Search private checkout offers
                    </span>
                    <span className="rounded-md border border-[#1a2635] bg-[#090d13] p-3">
                      Compare rail and provider details
                    </span>
                    <span className="rounded-md border border-[#1a2635] bg-[#090d13] p-3">
                      Approve before payment
                    </span>
                  </div>
                ) : (
                  offers.map((offer) => (
                    <button
                      key={offer.offer_id}
                      type="button"
                      onClick={() => offer.available && setSelectedOfferId(offer.offer_id)}
                      disabled={!offer.available}
                      className={`grid w-full gap-3 px-4 py-4 text-left transition sm:px-5 md:grid-cols-[1fr_8rem_8rem] md:items-center ${
                        selectedOfferId === offer.offer_id
                          ? "bg-[#111a26]"
                          : "hover:bg-[#101620]"
                      } ${!offer.available ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <span>
                        <span className="block text-sm font-medium text-[#eef1f8]">
                          {offer.title}
                        </span>
                        <span className="mt-1 block text-xs text-[#9fb2cc]">
                          {offer.merchant_label} · {offer.fulfillment_kind.replaceAll("_", " ")}
                        </span>
                        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-[#7f8ca3]">
                          {offer.available
                            ? offer.trust_summary || offer.description
                            : offer.unavailable_reason ?? "Unavailable"}
                        </span>
                      </span>
                      <span className="text-sm text-[#d6deec]">
                        {formatMicroUsd(offer.amount_micro_usdc)}
                      </span>
                      <span className="text-xs text-[#7f8ca3]">{railLabel(offer.rail)}</span>
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-[#1e2a3a] px-4 py-3 sm:px-5">
                <button
                  type="button"
                  onClick={quoteOffer}
                  disabled={!selectedOffer || !!loading}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#2f435c] px-4 text-sm font-medium text-[#d6deec] transition hover:border-[#3da8ff]/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading === "quote" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileCheck2 className="h-4 w-4" />
                  )}
                  Create quote
                </button>
              </div>
            </section>

            {quote && (
              <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15]">
                <div className="border-b border-[#1e2a3a] px-5 py-4">
                  <h2 className="text-sm font-medium text-[#f6f8ff]">Approve checkout</h2>
                </div>
                <div className="grid gap-4 p-5">
                  <div className="grid gap-3 rounded-md border border-[#263449] bg-[#08090d] p-4 text-sm text-[#b7c3d8] md:grid-cols-3">
                    <span>{quote.provider_label ?? selectedOffer?.merchant_label ?? quote.offer_id}</span>
                    <span>{formatMicroUsd(quote.amount_micro_usdc)}</span>
                    <span>{railLabel(quote.rail)}</span>
                  </div>
                  <div className="rounded-md border border-[#263449] bg-[#08090d] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-[#eef1f8]">
                      <LockKeyhole className="h-4 w-4 text-[#3da8ff]" />
                      What leaves Ghola
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#9fb2cc]">
                      Merchant label, quote amount, selected rail, approval timestamp,
                      and a hashed approval nonce. Ghola does not return raw provider
                      payloads or raw approval nonces in receipts.
                    </p>
                    <p className="mt-3 text-xs leading-5 text-[#7f8ca3]">
                      {selectedOffer?.privacy_disclosure ?? "This external execution requires explicit approval."}
                    </p>
                  </div>
                  <label className="flex items-start gap-3 text-sm leading-6 text-[#b7c3d8]">
                    <input
                      type="checkbox"
                      checked={approved}
                      onChange={(event) => setApproved(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-[#2f435c] bg-[#08090d]"
                    />
                    <span>
                      I approve this checkout and understand which provider and payment rail Ghola will use.
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={approveAndPay}
                    disabled={!approved || !!loading}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#d9f99d] px-4 text-sm font-medium text-[#142000] transition hover:bg-[#e5ffb7] disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit"
                  >
                    {loading === "approval" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    Approve and pay
                  </button>
                </div>
              </section>
            )}

            {execution && (
              <section className="rounded-md border border-[#24452d] bg-[#0d1510]">
                <div className="flex items-center gap-2 border-b border-[#24452d] px-5 py-4">
                  <ReceiptText className="h-4 w-4 text-[#a7f3b5]" />
                  <h2 className="text-sm font-medium text-[#ecfff0]">Receipt</h2>
                </div>
                <div className="grid gap-4 p-5 text-sm text-[#c8f5d1] md:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[#7bbd89]">Status</p>
                    <p className="mt-1 text-lg font-medium">{execution.status}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[#7bbd89]">Total</p>
                    <p className="mt-1 text-lg font-medium">
                      {formatMicroUsd(execution.receipt.amount_micro_usdc)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[#7bbd89]">Rail</p>
                    <p className="mt-1">{railLabel(execution.receipt.rail)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[#7bbd89]">Private proof</p>
                    <p className="mt-1">
                      {fundedStatus === "funded_usdcx_proof_verified"
                        ? "Funded USDCx proof verified"
                        : "Funded USDCx proof pending"}
                    </p>
                  </div>
                  <p className="md:col-span-2 text-xs leading-5 text-[#9bdca8]">
                    Receipt ID {execution.receipt.id}. Sensitive prompt, provider payload,
                    wallet address, and approval nonce are not returned here.
                  </p>
                </div>
              </section>
            )}
          </div>

          <aside className="space-y-5">
            <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15] p-5">
              <h2 className="text-sm font-medium text-[#f6f8ff]">Checkout path</h2>
              <div className="mt-5 space-y-4">
                {steps.map((step) => {
                  const done =
                    step.id === "ask"
                      ? !!intent
                      : step.id === "offers"
                        ? offers.length > 0
                        : step.id === "quote"
                          ? !!quote
                          : step.id === "approval"
                            ? !!execution
                            : step.id === "receipt"
                              ? !!execution
                              : false;
                  const active = activeStep === step.id;
                  return (
                    <div key={step.id} className="flex items-center gap-3">
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                          done
                            ? "border-[#69d58b] bg-[#14301e] text-[#a7f3b5]"
                            : active
                              ? "border-[#3da8ff] bg-[#122236] text-[#a8d8ff]"
                              : "border-[#263449] text-[#6f7d9a]"
                        }`}
                      >
                        {done ? <CheckCircle2 className="h-4 w-4" /> : null}
                      </span>
                      <span
                        className={`text-sm ${
                          active || done ? "text-[#eef1f8]" : "text-[#7f8ca3]"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15] p-5">
              <div className="flex items-center gap-2">
                <CircleDollarSign className="h-4 w-4 text-[#3da8ff]" />
                <h2 className="text-sm font-medium text-[#f6f8ff]">Payment rail</h2>
              </div>
              <p className="mt-3 text-sm font-medium text-[#eef1f8]">{railReadyLabel}</p>
              <p className="mt-2 text-xs leading-5 text-[#8b95a8]">{railDetail}</p>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border border-[#1a2635] bg-[#090d13] p-3">
                  <p className="text-[#6f7d9a]">Private</p>
                  <p className="mt-1 text-[#d6deec]">USDCx</p>
                </div>
                <div className="rounded-md border border-[#1a2635] bg-[#090d13] p-3">
                  <p className="text-[#6f7d9a]">Funded proof</p>
                  <p className="mt-1 text-[#d6deec]">
                    {fundedStatus === "funded_usdcx_proof_verified" ? "Verified" : "Pending"}
                  </p>
                </div>
              </div>
              <Link
                href="/private-balance"
                className="mt-4 inline-flex items-center gap-2 text-xs text-[#3da8ff] hover:text-[#67bbff]"
              >
                View Private Balance
              </Link>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}
