"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listBounties,
  getEarnings,
  withdrawEarnings,
  listTasks,
} from "@/lib/thumper-api";
import type { TaskBounty, EarningsResponse } from "@/lib/thumper-types";
import type { ThumperTaskResponse } from "@/lib/thumper-types";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  clearPayoutAttempt,
  payoutAttemptStorageKey,
  preparePayoutAttempt,
  readPendingPayoutAttempt,
} from "@/lib/payout-idempotency";
import {
  Plus,
  DollarSign,
  ArrowDownToLine,
  Loader2,
  ExternalLink,
} from "lucide-react";

function formatUsdc(micro: number): string {
  const usdc = micro / 1_000_000;
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)}`;
}

const statusColors: Record<string, string> = {
  pending: "bg-blue-500/10 text-blue-400",
  in_progress: "bg-yellow-500/10 text-yellow-400",
  awaiting_approval: "bg-purple-500/10 text-purple-400",
  completed: "bg-green-500/10 text-green-400",
  cancelled: "bg-red-500/10 text-red-400",
  held: "bg-blue-500/10 text-blue-400",
  released: "bg-green-500/10 text-green-400",
  refunded: "bg-[#1e2a3a] text-[#8b95a8]",
};

export default function BountyDashboardPage() {
  const router = useRouter();
  const { authenticated, loading: authLoading, user } = useThumperAuth();

  const [tab, setTab] = useState<"posted" | "claimed">("posted");
  const [postedTasks, setPostedTasks] = useState<ThumperTaskResponse[]>([]);
  const [claimedBounties, setClaimedBounties] = useState<TaskBounty[]>([]);
  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Withdraw state
  const [withdrawAddr, setWithdrawAddr] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState("");

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/signin");
    }
  }, [authLoading, authenticated, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [earningsRes, postedRes, claimedRes] = await Promise.all([
        getEarnings().catch(() => null),
        listTasks().catch(() => []),
        listBounties().catch(() => []),
      ]);
      setEarnings(earningsRes);
      // Filter to only bounty tasks
      setPostedTasks(
        (postedRes as ThumperTaskResponse[]).filter(
          (t) => t.bounty_usdc != null,
        ),
      );
      setClaimedBounties(claimedRes as TaskBounty[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) load();
  }, [authenticated, load]);

  useEffect(() => {
    if (!user?.id) return;
    const pending = readPendingPayoutAttempt(
      window.localStorage,
      payoutAttemptStorageKey("bounty", user.id),
    );
    if (!pending) return;
    if (pending.request.to_address) setWithdrawAddr(pending.request.to_address);
    if (pending.request.amount_usdc != null) {
      setWithdrawAmt(String(pending.request.amount_usdc / 1_000_000));
    }
    setWithdrawMsg("A withdrawal may still be pending. Retry it to refresh its final status.");
  }, [user?.id]);

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawMsg("");
    if (!withdrawAddr.trim()) {
      setWithdrawMsg("Enter a Solana address.");
      return;
    }
    if (!user?.id) {
      setWithdrawMsg("Sign in again before withdrawing.");
      return;
    }
    const parsedAmount = withdrawAmt ? Number.parseFloat(withdrawAmt) : null;
    if (parsedAmount != null && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
      setWithdrawMsg("Enter a valid withdrawal amount.");
      return;
    }
    const amountUsdc = parsedAmount == null
      ? undefined
      : Math.round(parsedAmount * 1_000_000);
    const request = {
      to_address: withdrawAddr.trim(),
      amount_usdc: amountUsdc,
    };
    const storageKey = payoutAttemptStorageKey("bounty", user.id);
    let prepared: ReturnType<typeof preparePayoutAttempt>;
    try {
      prepared = preparePayoutAttempt(window.localStorage, storageKey, request);
    } catch {
      setWithdrawMsg("Secure retry storage is unavailable, so no withdrawal was sent.");
      return;
    }
    if (!prepared.ok) {
      if (prepared.pending.request.to_address) {
        setWithdrawAddr(prepared.pending.request.to_address);
      }
      setWithdrawAmt(
        prepared.pending.request.amount_usdc == null
          ? ""
          : String(prepared.pending.request.amount_usdc / 1_000_000),
      );
      setWithdrawMsg("Retry the pending withdrawal before starting a different one.");
      return;
    }
    setWithdrawing(true);
    try {
      const res = await withdrawEarnings({
        ...request,
        idempotency_key: prepared.attempt.idempotency_key,
      });
      const terminalSuccess = res.status === "confirmed" || res.status === "completed";
      const terminalFailure = res.status === "failed" || res.status === "cancelled";
      if (terminalSuccess || terminalFailure) {
        clearPayoutAttempt(
          window.localStorage,
          storageKey,
          prepared.attempt.idempotency_key,
        );
      }
      if (terminalSuccess && res.signature) {
        setWithdrawMsg(`Withdrawn! Tx: ${res.signature.slice(0, 16)}...`);
        setWithdrawAddr("");
        setWithdrawAmt("");
        await load();
      } else if (terminalFailure) {
        setWithdrawMsg("Withdrawal failed before confirmation. You can try again.");
      } else {
        setWithdrawMsg("Withdrawal submitted. Retry this same request to refresh its final status.");
      }
    } catch (err: unknown) {
      const status = (err as Error & { status?: number }).status;
      if (status != null && status >= 400 && status < 500 && ![409, 425, 429].includes(status)) {
        clearPayoutAttempt(
          window.localStorage,
          storageKey,
          prepared.attempt.idempotency_key,
        );
      }
      setWithdrawMsg((err as Error).message || "Withdrawal failed.");
    } finally {
      setWithdrawing(false);
    }
  }

  if (authLoading || (!authenticated && !authLoading)) {
    return (
      <div className="min-h-screen bg-[#08090d] flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[#3da8ff]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-6xl px-4 py-10">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#eef1f8]">My Bounties</h1>
            <p className="mt-2 text-[#8b95a8]">
              Manage your posted and claimed bounties.
            </p>
          </div>
          <Link
            href="/bounties/create"
            className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
          >
            <Plus className="h-4 w-4" />
            Post Bounty
          </Link>
        </div>

        {/* Earnings Stats */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <p className="text-xs text-[#8b95a8] mb-1">Available to Withdraw</p>
            <p className="text-2xl font-bold text-green-400">
              {earnings ? formatUsdc(earnings.available_usdc) : "$0.00"}
            </p>
          </div>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <p className="text-xs text-[#8b95a8] mb-1">Total Earned</p>
            <p className="text-2xl font-bold text-[#eef1f8]">
              {earnings ? formatUsdc(earnings.earned_usdc) : "$0.00"}
            </p>
          </div>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <p className="text-xs text-[#8b95a8] mb-1">Total Withdrawn</p>
            <p className="text-2xl font-bold text-[#eef1f8]">
              {earnings ? formatUsdc(earnings.withdrawn_usdc) : "$0.00"}
            </p>
          </div>
        </div>

        {/* Withdraw */}
        {earnings && earnings.available_usdc > 0 && (
          <div className="mb-8 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="text-sm font-semibold text-[#8b95a8] mb-3">
              Withdraw Earnings
            </h2>
            <form onSubmit={handleWithdraw} className="flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                value={withdrawAddr}
                onChange={(e) => setWithdrawAddr(e.target.value)}
                placeholder="Solana wallet address"
                className="flex-1 rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
                required
              />
              <input
                type="number"
                step="0.01"
                min="0.10"
                value={withdrawAmt}
                onChange={(e) => setWithdrawAmt(e.target.value)}
                placeholder={`Max: ${formatUsdc(earnings.available_usdc)}`}
                className="w-full sm:w-32 rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
              />
              <button
                type="submit"
                disabled={withdrawing}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#3da8ff] px-5 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50"
              >
                {withdrawing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-4 w-4" />
                )}
                Withdraw
              </button>
            </form>
            {withdrawMsg && (
              <p className="mt-2 text-sm text-[#8b95a8]">{withdrawMsg}</p>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setTab("posted")}
            className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
              tab === "posted"
                ? "bg-[#3da8ff] text-[#08090d]"
                : "border border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:bg-[#161822]"
            }`}
          >
            Posted ({postedTasks.length})
          </button>
          <button
            onClick={() => setTab("claimed")}
            className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
              tab === "claimed"
                ? "bg-[#3da8ff] text-[#08090d]"
                : "border border-[#1e2a3a] bg-[#0f1117] text-[#8b95a8] hover:bg-[#161822]"
            }`}
          >
            Claimed ({claimedBounties.length})
          </button>
        </div>

        {/* Posted Tab */}
        {tab === "posted" && (
          <div className="space-y-3">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded-xl bg-[#161822]"
                />
              ))
            ) : postedTasks.length === 0 ? (
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-10 text-center">
                <p className="text-[#8b95a8] mb-3">
                  You haven&apos;t posted any bounties yet.
                </p>
                <Link
                  href="/bounties/create"
                  className="inline-flex items-center gap-2 text-sm text-[#3da8ff] hover:underline"
                >
                  <Plus className="h-4 w-4" /> Post your first bounty
                </Link>
              </div>
            ) : (
              postedTasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/bounties/${task.id}`}
                  className="flex items-center justify-between rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4 hover:border-[#3da8ff]/30 hover:bg-[#161822] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[#eef1f8] truncate">
                      {task.template_id || task.task_type}
                    </p>
                    <p className="text-xs text-[#8b95a8]">
                      {new Date(task.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    {task.bounty_usdc != null && (
                      <span className="flex items-center gap-1 text-sm font-medium text-[#eef1f8]">
                        <DollarSign className="h-3.5 w-3.5 text-green-400" />
                        {formatUsdc(task.bounty_usdc)}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[task.status] || "bg-[#1e2a3a] text-[#8b95a8]"}`}
                    >
                      {task.status.replace(/_/g, " ")}
                    </span>
                    <ExternalLink className="h-4 w-4 text-[#4a5568]" />
                  </div>
                </Link>
              ))
            )}
          </div>
        )}

        {/* Claimed Tab */}
        {tab === "claimed" && (
          <div className="space-y-3">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded-xl bg-[#161822]"
                />
              ))
            ) : claimedBounties.length === 0 ? (
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-10 text-center">
                <p className="text-[#8b95a8] mb-3">
                  You haven&apos;t claimed any bounties yet.
                </p>
                <Link
                  href="/bounties"
                  className="inline-flex items-center gap-2 text-sm text-[#3da8ff] hover:underline"
                >
                  Browse available bounties
                </Link>
              </div>
            ) : (
              claimedBounties.map((bounty) => (
                <Link
                  key={bounty.id}
                  href={`/bounties/${bounty.task_id}`}
                  className="flex items-center justify-between rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4 hover:border-[#3da8ff]/30 hover:bg-[#161822] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[#eef1f8] truncate">
                      Task {bounty.task_id.slice(0, 8)}...
                    </p>
                    <p className="text-xs text-[#8b95a8]">
                      {new Date(bounty.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className="flex items-center gap-1 text-sm font-medium text-[#eef1f8]">
                      <DollarSign className="h-3.5 w-3.5 text-green-400" />
                      {formatUsdc(bounty.amount_usdc)}
                    </span>
                    {bounty.executor_amount > 0 && (
                      <span className="text-xs text-green-400">
                        earned {formatUsdc(bounty.executor_amount)}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[bounty.status] || "bg-[#1e2a3a] text-[#8b95a8]"}`}
                    >
                      {bounty.status}
                    </span>
                    <ExternalLink className="h-4 w-4 text-[#4a5568]" />
                  </div>
                </Link>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
