"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock3, Loader2, RefreshCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import {
  INVESTOR_ACCESS_MIN_REMAINING_MS,
  evaluateInvestorAccess,
  inspectInvestorAccessInvite,
  type InvestorAccessReadiness,
  type InvestorAccessRequirements,
} from "@/lib/investor-access";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { getThumperBillingStatus, redeemComplimentaryAccessPass } from "@/lib/thumper-api";
import type { ThumperBillingStatusResponse } from "@/lib/thumper-types";
import { investorFacingErrorMessage } from "@/lib/investor-facing-error";

export type InvestorAccessControl = {
  billing: ThumperBillingStatusResponse;
  readiness: InvestorAccessReadiness;
  ensureReady: () => Promise<boolean>;
};

type Props = InvestorAccessRequirements & {
  children: (control: InvestorAccessControl) => ReactNode;
};

export function InvestorAccessGate({
  children,
  minRemainingMs,
  requiredComputeSeconds,
  requiredFilledNotionalMicroUsd,
  requireComplimentaryPass,
}: Props) {
  const auth = useThumperAuth();
  const [captureComplete, setCaptureComplete] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteProblem, setInviteProblem] = useState<string | null>(null);
  const [billing, setBilling] = useState<ThumperBillingStatusResponse | null>(null);
  const [readiness, setReadiness] = useState<InvestorAccessReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [authOpen, setAuthOpen] = useState(false);
  const requestIdRef = useRef(0);
  const redeemedCodeRef = useRef<string | null>(null);

  const requirements = useMemo(() => ({
    minRemainingMs,
    requiredComputeSeconds,
    requiredFilledNotionalMicroUsd,
    requireComplimentaryPass,
  }), [minRemainingMs, requiredComputeSeconds, requiredFilledNotionalMicroUsd, requireComplimentaryPass]);

  useLayoutEffect(() => {
    const invite = inspectInvestorAccessInvite(window.location.href);
    if (invite.clean_path !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", invite.clean_path);
    }
    setInviteCode(invite.code);
    setInviteProblem(invite.error ? inviteProblemMessage(invite.error) : null);
    setCaptureComplete(true);
  }, []);

  const loadAccess = useCallback(async (options: { redeemInvite?: boolean; forceRedeem?: boolean } = {}) => {
    if (!auth.authenticated) return false;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    let redemptionProblem: string | null = null;
    try {
      if (
        options.redeemInvite && inviteCode &&
        (options.forceRedeem || redeemedCodeRef.current !== inviteCode)
      ) {
        try {
          await redeemComplimentaryAccessPass(inviteCode);
          redeemedCodeRef.current = inviteCode;
        } catch (error) {
          redemptionProblem = errorMessage(error, "Investor access could not be activated.");
        }
      }
      const nextBilling = await getThumperBillingStatus();
      const nextReadiness = evaluateInvestorAccess(nextBilling, Date.now(), requirements);
      if (requestId === requestIdRef.current) {
        setBilling(nextBilling);
        setReadiness(nextReadiness);
        setInviteProblem(nextReadiness.ready ? null : redemptionProblem);
      }
      return nextReadiness.ready;
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setBilling(null);
        setReadiness(evaluateInvestorAccess(null, Date.now(), requirements));
        setInviteProblem(errorMessage(error, "Account access could not be verified."));
      }
      return false;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    auth.authenticated,
    inviteCode,
    requirements,
  ]);

  const ensureReady = useCallback(
    () => loadAccess(),
    [loadAccess],
  );

  useEffect(() => {
    if (!captureComplete || auth.loading || !auth.authenticated) return;
    void loadAccess({ redeemInvite: true });
  }, [auth.authenticated, auth.loading, captureComplete, loadAccess]);

  useEffect(() => {
    if (!readiness?.ready) return;
    const refreshOnFocus = () => void ensureReady();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void ensureReady();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    let expiryTimer: number | null = null;
    if (readiness.expires_at) {
      const deadline = Date.parse(readiness.expires_at) -
        (minRemainingMs ?? INVESTOR_ACCESS_MIN_REMAINING_MS);
      const delay = Math.min(2_147_000_000, Math.max(0, deadline - Date.now() + 25));
      expiryTimer = window.setTimeout(() => void ensureReady(), delay);
    }
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (expiryTimer != null) window.clearTimeout(expiryTimer);
    };
  }, [ensureReady, minRemainingMs, readiness?.expires_at, readiness?.ready]);

  if (!captureComplete || auth.loading || (loading && !billing && !readiness)) {
    return <AccessNotice loading message="Checking investor access before wallet authorization…" />;
  }

  if (!auth.authenticated) {
    return (
      <>
        <AccessNotice
          message={inviteCode
            ? "Investor pass detected. Sign in or create the email-bound account to activate it."
            : "Sign in before wallet authorization or live trading."}
        >
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => { setAuthMode("signin"); setAuthOpen(true); }} className="trade-action h-9 rounded-md px-4 text-xs font-semibold">
              Sign in
            </button>
            <button type="button" onClick={() => { setAuthMode("signup"); setAuthOpen(true); }} className="trade-chip h-9 rounded-md px-4 text-xs">
              Create account
            </button>
          </div>
        </AccessNotice>
        <AuthModal
          mode={authMode}
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          onModeChange={setAuthMode}
          redirectTo={null}
          verifiedEmailRequired={Boolean(inviteCode || requireComplimentaryPass)}
        />
      </>
    );
  }

  if (!billing || !readiness?.ready) {
    const message = inviteProblem ?? readiness?.message ?? "Account access could not be verified.";
    return (
      <AccessNotice message={message} error expiresAt={readiness?.expires_at ?? null}>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadAccess({ redeemInvite: true, forceRedeem: true })}
            className="trade-chip inline-flex h-9 items-center gap-2 rounded-md px-4 text-xs disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            Recheck access
          </button>
          <Link href="/settings" className="trade-chip inline-flex h-9 items-center rounded-md px-4 text-xs">
            Review plan
          </Link>
        </div>
      </AccessNotice>
    );
  }

  const control: InvestorAccessControl = { billing, readiness, ensureReady };
  return (
    <div className="space-y-3" data-investor-access="ready">
      <div className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.05] px-4 py-3 text-xs text-emerald-100" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" />
            {billing.access_source === "complimentary_pass" ? "Investor access ready" : "Private-agent access ready"}
          </p>
          <button type="button" disabled={loading} onClick={() => void ensureReady()} className="text-[10px] text-emerald-200/70 underline underline-offset-2 disabled:opacity-50">
            {loading ? "Rechecking…" : "Refresh access"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] leading-4 text-emerald-100/70">
          <span>{planLabel(billing.tier)}</span>
          {readiness.expires_at ? (
            <span className="flex items-center gap-1">
              <Clock3 className="h-3 w-3" />
              Expires <time dateTime={readiness.expires_at}>{formatExactExpiry(readiness.expires_at)}</time>
            </span>
          ) : <span>Subscription access</span>}
          {readiness.remaining_compute_seconds != null ? (
            <span>{readiness.remaining_compute_seconds.toLocaleString()} compute seconds remaining</span>
          ) : null}
          {readiness.remaining_filled_notional_micro_usd != null ? (
            <span>{formatMicroUsd(readiness.remaining_filled_notional_micro_usd)} included filled notional remaining</span>
          ) : null}
        </div>
      </div>
      {children(control)}
    </div>
  );
}

function AccessNotice({
  message,
  children,
  error = false,
  loading = false,
  expiresAt = null,
}: {
  message: string;
  children?: ReactNode;
  error?: boolean;
  loading?: boolean;
  expiresAt?: string | null;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      data-investor-access={error ? "blocked" : "checking"}
      className={`rounded-md border px-4 py-3 text-xs leading-5 ${error
        ? "border-amber-400/30 bg-amber-400/[0.06] text-amber-100"
        : "border-[#2d3342] bg-[#0b0f15] text-[#9ba8bc]"}`}
    >
      <p className="flex items-start gap-2">
        {loading
          ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          : error
            ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>
          {message}
          {expiresAt ? (
            <> Expiry: <time dateTime={expiresAt}>{formatExactExpiry(expiresAt)}</time>.</>
          ) : null}
        </span>
      </p>
      {children}
    </div>
  );
}

function inviteProblemMessage(error: "invite_code_invalid" | "invite_code_ambiguous") {
  return error === "invite_code_ambiguous"
    ? "More than one investor pass was supplied. Reopen the original invite link."
    : "The investor pass link is malformed. Reopen the original invite email.";
}

const errorMessage = investorFacingErrorMessage;

function formatExactExpiry(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" })
    : value;
}

function formatMicroUsd(value: number) {
  return (value / 1_000_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function planLabel(tier: ThumperBillingStatusResponse["tier"]) {
  return tier === "starter" ? "Starter Agent" : tier.replaceAll("_", " ");
}
