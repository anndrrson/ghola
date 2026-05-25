"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  FileCheck2,
  Loader2,
  LockKeyhole,
  Mic,
  ReceiptText,
  Search,
  ShieldCheck,
  ShoppingBag,
  Wallet,
} from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
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
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import {
  type PaymentHealth,
  formatMicroUsd,
  summarizePrivateBalance,
} from "@/lib/private-balance";

type Step = "ask" | "offers" | "quote" | "approval" | "receipt";
type PrivateVoiceState = "idle" | "starting" | "recording" | "transcribing";
type PrivateVoiceWarmState = "idle" | "warming" | "ready" | "unavailable";

const EXAMPLE_GOALS = [
  "Find a private AI service under $5",
  "Compare secure email options",
  "Pay for a research tool privately",
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

function shortAddress(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

async function fetchPaymentHealth(): Promise<PaymentHealth | null> {
  const res = await fetch("/api/payments/health", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as PaymentHealth;
}

export default function IntentPage() {
  const thumperAuth = useThumperAuth();
  const turnkeyWallet = useTurnkeyWallet();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const [goal, setGoal] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("5.00");
  const [privacyMode, setPrivacyMode] = useState<"private" | "open">("private");
  const [intent, setIntent] = useState<CommerceIntent | null>(null);
  const [offers, setOffers] = useState<CommerceOffer[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [quote, setQuote] = useState<CommerceQuote | null>(null);
  const [execution, setExecution] = useState<CommerceExecution | null>(null);
  const [paymentHealth, setPaymentHealth] = useState<PaymentHealth | null>(null);
  const [loading, setLoading] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [privateVoiceState, setPrivateVoiceState] =
    useState<PrivateVoiceState>("idle");
  const [voiceStatus, setVoiceStatus] = useState(
    "Private voice warms up in the background. Audio stays on this device.",
  );
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceWarmState, setVoiceWarmState] =
    useState<PrivateVoiceWarmState>("idle");

  useEffect(() => {
    void fetchPaymentHealth().then(setPaymentHealth).catch(() => setPaymentHealth(null));
  }, []);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;

    const warm = () => {
      if (cancelled) return;
      setVoiceWarmState("warming");
      void import("@/lib/private-voice")
        .then(({ warmPrivateVoice }) =>
          warmPrivateVoice((status) => {
            if (!cancelled) setVoiceStatus(status);
          }),
        )
        .then(() => {
          if (!cancelled) {
            setVoiceWarmState("ready");
            setVoiceStatus("Private voice ready. Audio stays on this device.");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setVoiceWarmState("unavailable");
            setVoiceStatus("Private voice is unavailable here. Typing still works.");
          }
        });
    };

    if (typeof window.requestIdleCallback !== "function") {
      const timeout = globalThis.setTimeout(() => {
        if (cancelled) return;
        warm();
      }, 1200);
      return () => {
        cancelled = true;
        globalThis.clearTimeout(timeout);
      };
    }

    const idleId = window.requestIdleCallback(
      warm,
      { timeout: 2500 },
    );
    return () => {
      cancelled = true;
      window.cancelIdleCallback(idleId);
    };
  }, []);

  useEffect(() => {
    if (thumperAuth.loading || turnkeyWallet.loading) return;
    if (thumperAuth.authenticated && turnkeyWallet.walletAddress) return;
    setIntent(null);
    setOffers([]);
    setSelectedOfferId(null);
    setQuote(null);
    setExecution(null);
  }, [thumperAuth.loading, thumperAuth.authenticated, turnkeyWallet.loading, turnkeyWallet.walletAddress]);

  const privateSummary = summarizePrivateBalance(paymentHealth);
  const selectedOffer = useMemo(
    () => offers.find((offer) => offer.offer_id === selectedOfferId) ?? null,
    [offers, selectedOfferId]
  );
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
  const needsAuth = !thumperAuth.loading && !thumperAuth.authenticated;
  const walletReady = !!turnkeyWallet.walletAddress;
  const accountReady = thumperAuth.authenticated;
  const formLocked = !accountReady;
  const walletStatusLabel = thumperAuth.loading || turnkeyWallet.loading
    ? "Checking account"
    : walletReady
      ? `Wallet ${shortAddress(turnkeyWallet.walletAddress!)}`
      : thumperAuth.authenticated
        ? "Signed in"
        : "Sign in required";
  const primaryLabel = thumperAuth.loading || turnkeyWallet.loading
    ? "Checking account"
    : needsAuth
      ? "Sign in to continue"
      : "Find private options";

  const privateCheckout = privacyMode === "private";
  const paymentModeLabel = privateCheckout ? "Private payment" : "Public payment";
  const paymentModeDetail = privateCheckout
    ? "Ghola uses the private rail when available and stops if it cannot be used."
    : "Public payment uses a visible on-chain settlement rail.";

  async function submitIntent() {
    setError(null);
    setExecution(null);
    setQuote(null);
    if (!thumperAuth.authenticated) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
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

  async function handlePrimaryAction() {
    if (needsAuth) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    await submitIntent();
  }

  function appendGoalText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setGoal((current) => `${current}${current.trim() ? " " : ""}${trimmed}`.trim());
  }

  function stopPrivateVoiceRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  async function finishPrivateVoiceRecording() {
    const chunks = audioChunksRef.current;
    const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
    audioChunksRef.current = [];
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;

    if (chunks.length === 0) {
      setPrivateVoiceState("idle");
      setVoiceStatus("No audio was captured.");
      return;
    }

    setPrivateVoiceState("transcribing");
    setVoiceError(null);
    try {
      const { transcribePrivateAudio } = await import("@/lib/private-voice");
      const blob = new Blob(chunks, { type: mimeType });
      const transcript = await transcribePrivateAudio(blob, setVoiceStatus);
      if (!transcript) {
        setVoiceStatus("No speech detected. Try a slightly longer request.");
        return;
      }
      appendGoalText(transcript);
      setVoiceStatus("Transcript added locally. Review it before submitting.");
    } catch (err) {
      setVoiceError(
        err instanceof Error
          ? err.message
          : "Private transcription failed on this device.",
      );
      setVoiceStatus("Private voice stopped.");
    } finally {
      setPrivateVoiceState("idle");
    }
  }

  async function toggleVoiceInput() {
    if (formLocked) return;
    if (privateVoiceState === "recording") {
      stopPrivateVoiceRecording();
      return;
    }
    if (privateVoiceState === "starting" || privateVoiceState === "transcribing") {
      return;
    }
    if (voiceWarmState === "warming") {
      setVoiceStatus("Private voice is almost ready. You can type while it finishes.");
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setVoiceError("Private voice needs a browser with local microphone recording.");
      return;
    }

    if (voiceWarmState !== "ready") {
      setVoiceStatus("Preparing private voice before recording.");
      setVoiceWarmState("warming");
      try {
        const { isPrivateVoiceReady, warmPrivateVoice } = await import("@/lib/private-voice");
        if (!isPrivateVoiceReady()) {
          await warmPrivateVoice(setVoiceStatus);
        }
        setVoiceWarmState("ready");
        setVoiceStatus("Private voice ready. Audio stays on this device.");
      } catch {
        setVoiceWarmState("unavailable");
        setVoiceError("Private voice is unavailable here. Type your request instead.");
        return;
      }
    }

    setPrivateVoiceState("starting");
    setVoiceStatus("Requesting microphone access for local-only recording.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioChunksRef.current = [];
      mediaStreamRef.current = stream;
      const options = MediaRecorder.isTypeSupported("audio/webm")
        ? { mimeType: "audio/webm" }
        : undefined;
      const recorder = new MediaRecorder(stream, options);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void finishPrivateVoiceRecording();
      };
      recorder.onerror = () => {
        setPrivateVoiceState("idle");
        setVoiceError("Private recording failed in this browser.");
        stream.getTracks().forEach((track) => track.stop());
      };
      mediaRecorderRef.current = recorder;
      setError(null);
      setVoiceError(null);
      setVoiceStatus("Recording locally. Stop when you are done speaking.");
      setPrivateVoiceState("recording");
      recorder.start();
    } catch (err) {
      setPrivateVoiceState("idle");
      setVoiceError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission was blocked."
          : "Could not start private voice on this device.",
      );
    }
  }

  async function quoteOffer() {
    if (!intent || !selectedOffer) return;
    setError(null);
    setExecution(null);
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
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
        redirectTo={null}
      />
      <section className="border-b border-[#151b26] px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-medium text-[#8ea2c1]">
              <ShoppingBag className="h-3.5 w-3.5 text-[#3da8ff]" />
              Shop / Pay
            </div>
            <h1 className="mt-3 max-w-2xl text-2xl font-medium tracking-tight text-[#f6f8ff] sm:text-3xl">
              Ask Ghola to buy something.
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#8b95a8]">
              Describe what you need. Ghola finds options, shows the exact cost,
              and waits for your approval before any payment.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#8b95a8]">
              <span className="inline-flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    railStatusKnown && privateSummary.privateSpendReady
                      ? "bg-[#7ee787]"
                      : "bg-[#3da8ff]"
                  }`}
                />
                {railReadyLabel}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <LockKeyhole className="h-3.5 w-3.5" />
                Approval required
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Wallet className="h-3.5 w-3.5" />
                {walletStatusLabel}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="space-y-5">
            <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15] shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
              <div className="grid gap-4 p-4 sm:p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-medium text-[#f6f8ff]">
                      What are you buying?
                    </h2>
                    <p className="mt-1 text-xs text-[#7f8ca3]">
                      Type it like a normal request. Ghola handles the routing
                      and keeps private payments private.
                    </p>
                  </div>
                </div>
                {error && (
                  <div className="flex items-start gap-3 rounded-md border border-[#5a2430] bg-[#1b0d13] px-4 py-3 text-sm text-[#ffb4c0]">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                {formLocked && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#090d13] px-4 py-3 text-sm text-[#9fb2cc]">
                    <span className="font-medium text-[#d6deec]">
                      {thumperAuth.loading ? "Checking account." : "Sign in required."}
                    </span>{" "}
                    {thumperAuth.loading
                      ? "Ghola is checking whether this browser already has an active account session."
                      : "Ghola needs an account before it can create quotes or payments."}
                  </div>
                )}
                <div className="grid gap-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-[#f6f8ff]">
                        Describe it naturally
                      </p>
                      <p className="mt-1 text-xs text-[#7f8ca3]">
                        Type, tap an example, or speak once private voice is ready.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={toggleVoiceInput}
                      disabled={
                        formLocked ||
                        voiceWarmState === "warming" ||
                        voiceWarmState === "unavailable" ||
                        privateVoiceState === "starting" ||
                        privateVoiceState === "transcribing"
                      }
                      className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium transition sm:w-fit ${
                        privateVoiceState === "recording"
                          ? "border-[#ff6b8a]/50 bg-[#2a1018] text-[#ffb4c0]"
                          : "border-[#2f435c] bg-[#0b1119] text-[#b8c7de] hover:border-[#3da8ff]/60 hover:text-[#eef1f8]"
                      } disabled:cursor-not-allowed disabled:opacity-45`}
                    >
                      {privateVoiceState === "starting" ||
                      privateVoiceState === "transcribing" ||
                      voiceWarmState === "warming" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Mic className="h-3.5 w-3.5" />
                      )}
                      {privateVoiceState === "recording"
                        ? "Stop recording"
                        : privateVoiceState === "transcribing"
                          ? "Transcribing"
                          : voiceWarmState === "warming"
                            ? "Preparing voice"
                            : voiceWarmState === "ready"
                              ? "Speak"
                              : "Private voice"}
                    </button>
                  </div>
                  <div
                    className={`rounded-md border px-3 py-2 text-xs ${
                      voiceError
                        ? "border-[#5a4324] bg-[#1b150d] text-[#ffd49a]"
                        : privateVoiceState === "recording" ||
                            privateVoiceState === "transcribing"
                          ? "border-[#254568] bg-[#0a121d] text-[#9ccfff]"
                          : "border-[#1e2a3a] bg-[#090d13] text-[#7f8ca3]"
                    }`}
                  >
                    {voiceError ?? voiceStatus}
                  </div>
                  <textarea
                    value={goal}
                    onChange={(event) => setGoal(event.target.value)}
                    disabled={formLocked}
                    aria-label="Commerce request"
                    className="min-h-28 w-full resize-y rounded-md border border-[#263449] bg-[#08090d] px-3 py-3 text-base leading-6 text-[#eef1f8] outline-none transition focus:border-[#3da8ff] disabled:cursor-not-allowed disabled:text-[#64748b]"
                    maxLength={1200}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#6f7d9a]">
                      Try
                    </span>
                    {EXAMPLE_GOALS.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setGoal(example)}
                        disabled={formLocked}
                        className="rounded-md border border-[#1e2a3a] bg-[#090d13] px-3 py-1.5 text-xs text-[#8ea2c1] transition hover:border-[#2f435c] hover:text-[#eef1f8] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-[9rem_minmax(15rem,1fr)_auto] md:items-end">
                  <label className="grid gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#6f7d9a]">
                      Budget
                    </span>
                    <input
                      value={budgetUsd}
                      onChange={(event) => setBudgetUsd(event.target.value)}
                      inputMode="decimal"
                      disabled={formLocked}
                      className="h-10 rounded-md border border-[#263449] bg-[#08090d] px-3 text-sm text-[#eef1f8] outline-none transition focus:border-[#3da8ff] disabled:cursor-not-allowed disabled:text-[#64748b]"
                    />
                  </label>
                  <div className="grid gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#6f7d9a]">
                      Payment
                    </span>
                    <div className="flex h-10 items-center rounded-md border border-[#263449] bg-[#08090d] px-3 text-sm text-[#d6deec]">
                      {paymentModeLabel}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handlePrimaryAction}
                    disabled={!!loading || thumperAuth.loading || turnkeyWallet.loading}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#3da8ff] px-4 text-sm font-semibold text-[#05080d] shadow-[0_10px_28px_-14px_rgba(61,168,255,0.9)] transition hover:bg-[#67bbff] active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-[#1a2635] disabled:text-[#64748b] disabled:shadow-none"
                  >
                    {loading === "ask" || loading === "offers" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    {primaryLabel}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#151b26] pt-3 text-xs text-[#7f8ca3]">
                  <span className="text-[#9fb2cc]">{paymentModeLabel}</span>
                  <span>{paymentModeDetail}</span>
                  <details className="group">
                    <summary className="cursor-pointer text-[#6f7d9a] hover:text-[#9fb2cc]">
                      Payment details
                    </summary>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[#6f7d9a]">
                      <span>
                        {privacyMode === "private"
                          ? "Private USDCx preferred"
                          : "Public USDC selected"}
                      </span>
                      <span>
                        {railStatusKnown ? "Rail status checked" : "Checking rail status"}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setPrivacyMode(privacyMode === "private" ? "open" : "private")
                        }
                        disabled={formLocked}
                        className="rounded border border-[#263449] px-2 py-1 text-[11px] text-[#9fb2cc] hover:border-[#3da8ff]/60 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {privacyMode === "private"
                          ? "Use public payment"
                          : "Use private payment"}
                      </button>
                    </div>
                  </details>
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
                  <div className="px-4 py-8 text-sm text-[#7f8ca3] sm:px-5">
                    <span className="block text-[#d6deec]">Options will appear here.</span>
                    <span className="mt-1 block">
                      Search once, compare quotes, then approve the exact payment.
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
                      <span className="text-xs text-[#7f8ca3]">
                        {offer.rail.includes("shielded") || offer.rail.includes("usdcx")
                          ? "Private"
                          : "Public"}
                      </span>
                    </button>
                  ))
                )}
              </div>
              {offers.length > 0 && (
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
                    Review quote
                  </button>
                </div>
              )}
            </section>

            {quote && (
              <section className="rounded-md border border-[#1e2a3a] bg-[#0c0f15]">
                <div className="border-b border-[#1e2a3a] px-5 py-4">
                  <h2 className="text-sm font-medium text-[#f6f8ff]">Approve payment</h2>
                </div>
                <div className="grid gap-4 p-5">
                  <div className="grid gap-3 rounded-md border border-[#263449] bg-[#08090d] p-4 text-sm text-[#b7c3d8] md:grid-cols-3">
                    <span>{quote.provider_label ?? selectedOffer?.merchant_label ?? quote.offer_id}</span>
                    <span>{formatMicroUsd(quote.amount_micro_usdc)}</span>
                    <span>{quote.rail.includes("shielded") || quote.rail.includes("usdcx") ? "Private payment" : "Public payment"}</span>
                  </div>
                  <div className="rounded-md border border-[#263449] bg-[#08090d] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-[#eef1f8]">
                      <LockKeyhole className="h-4 w-4 text-[#3da8ff]" />
                      What you are approving
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#9fb2cc]">
                      Ghola will send the provider, amount, payment mode, and
                      your approval timestamp. The raw approval secret is never
                      returned in the receipt.
                    </p>
                    <details className="mt-3 text-xs leading-5 text-[#7f8ca3]">
                      <summary className="cursor-pointer text-[#9fb2cc]">
                        Payment details
                      </summary>
                      <p className="mt-2">
                        Rail: {railLabel(quote.rail)}.{" "}
                        {selectedOffer?.privacy_disclosure ??
                          "This external execution requires explicit approval."}
                      </p>
                    </details>
                  </div>
                  <button
                    type="button"
                    onClick={approveAndPay}
                    disabled={!!loading}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#3da8ff] px-4 text-sm font-semibold text-[#05080d] transition hover:bg-[#67bbff] disabled:cursor-not-allowed disabled:bg-[#1a2635] disabled:text-[#64748b] sm:w-fit"
                  >
                    {loading === "approval" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    Approve payment
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
                    <p className="text-xs uppercase tracking-[0.16em] text-[#7bbd89]">Payment privacy</p>
                    <p className="mt-1">
                      {execution.receipt.rail.includes("shielded") ||
                      execution.receipt.rail.includes("usdcx")
                        ? "Private"
                        : "Public"}
                    </p>
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
        </div>
      </section>
    </main>
  );
}
