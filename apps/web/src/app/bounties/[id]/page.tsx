"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getMarketplaceTask,
  claimTask,
  submitTask,
  unclaimTask,
  releaseTask,
  rejectTask,
} from "@/lib/thumper-api";
import type { MarketplaceTask } from "@/lib/thumper-types";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  ArrowLeft,
  DollarSign,
  Clock,
  User,
  CheckCircle,
  XCircle,
  Loader2,
  AlertCircle,
  ShieldCheck,
  Star,
} from "lucide-react";

function formatUsdc(micro: number): string {
  const usdc = micro / 1_000_000;
  return `$${usdc.toFixed(usdc < 0.01 ? 4 : 2)} USDC`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const statusColors: Record<string, string> = {
  pending: "bg-blue-500/10 text-blue-400",
  in_progress: "bg-yellow-500/10 text-yellow-400",
  awaiting_approval: "bg-purple-500/10 text-purple-400",
  completed: "bg-green-500/10 text-green-400",
  cancelled: "bg-red-500/10 text-red-400",
  failed: "bg-red-500/10 text-red-400",
};

export default function BountyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { authenticated, user } = useThumperAuth();

  const [task, setTask] = useState<MarketplaceTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [submitText, setSubmitText] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t = await getMarketplaceTask(id);
      setTask(t);
    } catch {
      setError("Bounty not found or no longer available.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const isFunder = authenticated && user && task?.funder_id === user.id;
  const isExecutor =
    authenticated && user && task?.executor_id === user.id;
  const canClaim =
    authenticated &&
    !isFunder &&
    !isExecutor &&
    task?.status === "pending" &&
    !task?.executor_id;

  async function handleClaim() {
    setActionLoading(true);
    setActionMsg("");
    try {
      const res = await claimTask(id);
      setActionMsg(
        `Claimed! Deadline: ${new Date(res.claim_expires_at).toLocaleString()}`,
      );
      await load();
    } catch (e: unknown) {
      setActionMsg((e as Error).message || "Failed to claim");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSubmit() {
    if (!submitText.trim()) return;
    setActionLoading(true);
    setActionMsg("");
    try {
      let result: unknown;
      try {
        result = JSON.parse(submitText);
      } catch {
        result = { text: submitText };
      }
      await submitTask(id, result);
      setActionMsg("Submitted for review!");
      setSubmitText("");
      await load();
    } catch (e: unknown) {
      setActionMsg((e as Error).message || "Failed to submit");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUnclaim() {
    setActionLoading(true);
    try {
      await unclaimTask(id);
      setActionMsg("Claim dropped. Task returned to marketplace.");
      await load();
    } catch (e: unknown) {
      setActionMsg((e as Error).message || "Failed to unclaim");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRelease() {
    setActionLoading(true);
    setActionMsg("");
    try {
      const res = await releaseTask(id);
      setActionMsg(
        `Payment released! Executor receives ${formatUsdc(res.executor_amount)} (${formatUsdc(res.platform_fee)} platform fee).`,
      );
      await load();
    } catch (e: unknown) {
      setActionMsg((e as Error).message || "Failed to release");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject() {
    setActionLoading(true);
    setActionMsg("");
    try {
      await rejectTask(id, rejectReason || undefined);
      setActionMsg("Submission rejected. Executor can resubmit.");
      setShowReject(false);
      setRejectReason("");
      await load();
    } catch (e: unknown) {
      setActionMsg((e as Error).message || "Failed to reject");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d]">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <div className="h-8 w-32 animate-pulse rounded bg-[#161822] mb-6" />
          <div className="h-64 animate-pulse rounded-xl bg-[#161822]" />
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="min-h-screen bg-[#08090d]">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <Link
            href="/bounties"
            className="inline-flex items-center gap-1 text-sm text-[#8b95a8] hover:text-[#eef1f8] mb-6"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Bounties
          </Link>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-10 text-center">
            <AlertCircle className="h-8 w-8 text-[#4a5568] mx-auto mb-3" />
            <p className="text-[#8b95a8]">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Link
          href="/bounties"
          className="inline-flex items-center gap-1 text-sm text-[#8b95a8] hover:text-[#eef1f8] mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Bounties
        </Link>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-2xl font-bold text-[#eef1f8]">
              {task.title || "Untitled Task"}
            </h1>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${statusColors[task.status] || "bg-[#1e2a3a] text-[#8b95a8]"}`}
            >
              {task.status.replace(/_/g, " ")}
            </span>
          </div>
          <span className="mt-2 inline-block rounded-full bg-[#3da8ff]/10 px-2.5 py-0.5 text-xs font-medium capitalize text-[#3da8ff]">
            {task.task_type.replace(/_/g, " ")}
          </span>
        </div>

        {/* Info cards */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] p-3">
            <div className="flex items-center gap-1.5 text-xs text-[#8b95a8] mb-1">
              <DollarSign className="h-3.5 w-3.5 text-green-400" /> Bounty
            </div>
            <p className="font-semibold text-[#eef1f8]">
              {task.bounty_usdc != null ? formatUsdc(task.bounty_usdc) : "None"}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] p-3">
            <div className="flex items-center gap-1.5 text-xs text-[#8b95a8] mb-1">
              <Clock className="h-3.5 w-3.5" /> Posted
            </div>
            <p className="font-semibold text-[#eef1f8]">
              {timeAgo(task.created_at)}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] p-3">
            <div className="flex items-center gap-1.5 text-xs text-[#8b95a8] mb-1">
              <User className="h-3.5 w-3.5" /> Executor
            </div>
            <p className="font-semibold text-[#eef1f8] truncate">
              {task.executor_id
                ? `${task.executor_id.slice(0, 8)}...`
                : "Unclaimed"}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] p-3">
            <div className="flex items-center gap-1.5 text-xs text-[#8b95a8] mb-1">
              <Clock className="h-3.5 w-3.5" /> Deadline
            </div>
            <p className="font-semibold text-[#eef1f8]">
              {task.claim_expires_at
                ? new Date(task.claim_expires_at).toLocaleDateString()
                : "N/A"}
            </p>
          </div>
        </div>

        {/* Funder Identity */}
        <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <h2 className="mb-3 text-sm font-semibold text-[#8b95a8]">
            Posted By
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#3da8ff]/10 text-[#3da8ff]">
              <User className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium text-[#eef1f8] truncate">
                  {task.funder_name || `${task.funder_id.slice(0, 12)}...`}
                </p>
                {task.funder_verified && (
                  <ShieldCheck className="h-4 w-4 text-[#3da8ff] shrink-0" />
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-[#8b95a8]">
                {task.funder_reputation != null && (
                  <span className="flex items-center gap-1">
                    <Star className="h-3 w-3 text-yellow-500" />
                    Reputation: {(task.funder_reputation * 100).toFixed(0)}%
                  </span>
                )}
                {task.funder_bounties_funded != null && task.funder_bounties_funded > 0 && (
                  <span>{task.funder_bounties_funded} bounties funded</span>
                )}
              </div>
            </div>
          </div>
          {task.min_reputation != null && (
            <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-yellow-500/5 px-3 py-2 text-xs text-yellow-400">
              <Star className="h-3.5 w-3.5" />
              Minimum reputation {(task.min_reputation * 100).toFixed(0)}% required to claim
            </div>
          )}
        </div>

        {/* Description */}
        <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <h2 className="mb-2 text-sm font-semibold text-[#8b95a8]">
            Description
          </h2>
          <p className="text-[#eef1f8] whitespace-pre-wrap">
            {task.description || "No description provided."}
          </p>
        </div>

        {/* Params */}
        {task.params &&
          Object.keys(task.params).length > 0 && (
            <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
              <h2 className="mb-2 text-sm font-semibold text-[#8b95a8]">
                Parameters
              </h2>
              <pre className="text-sm text-[#eef1f8] overflow-x-auto">
                {JSON.stringify(task.params, null, 2)}
              </pre>
            </div>
          )}

        {/* Action message */}
        {actionMsg && (
          <div className="mb-4 rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-3 text-sm text-[#eef1f8]">
            {actionMsg}
          </div>
        )}

        {/* ── Action Sections ── */}

        {/* Not authenticated */}
        {!authenticated && task.status === "pending" && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
            <p className="text-[#8b95a8] mb-4">
              Sign in to claim this bounty and start earning.
            </p>
            <Link
              href={`/signin`}
              className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
            >
              Sign In to Claim
            </Link>
          </div>
        )}

        {/* Can claim */}
        {canClaim && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
            <p className="text-[#8b95a8] mb-4">
              Claim this bounty to start working. You&apos;ll have 24 hours to
              submit your work.
            </p>
            <button
              onClick={handleClaim}
              disabled={actionLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50"
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <DollarSign className="h-4 w-4" />
              )}
              Claim This Bounty
            </button>
          </div>
        )}

        {/* Executor: in_progress — submit form */}
        {isExecutor && task.status === "in_progress" && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-3 font-semibold text-[#eef1f8]">
              Submit Your Work
            </h2>
            <textarea
              value={submitText}
              onChange={(e) => setSubmitText(e.target.value)}
              placeholder="Paste your result here (text or JSON)..."
              rows={6}
              className="mb-3 w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
            />
            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                disabled={actionLoading || !submitText.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-5 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                Submit Work
              </button>
              <button
                onClick={handleUnclaim}
                disabled={actionLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2 text-sm text-[#8b95a8] hover:bg-[#161822] transition-colors disabled:opacity-50"
              >
                Drop Claim
              </button>
            </div>
          </div>
        )}

        {/* Executor: awaiting approval */}
        {isExecutor && task.status === "awaiting_approval" && (
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-6 text-center">
            <p className="text-purple-300">
              Your submission is awaiting review from the funder.
            </p>
          </div>
        )}

        {/* Funder: pending — waiting */}
        {isFunder && task.status === "pending" && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
            <p className="text-[#8b95a8]">
              Waiting for someone to claim your bounty.
            </p>
          </div>
        )}

        {/* Funder: in_progress */}
        {isFunder && task.status === "in_progress" && (
          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-6 text-center">
            <p className="text-yellow-300">
              An executor has claimed this task and is working on it.
            </p>
          </div>
        )}

        {/* Funder: awaiting_approval — review */}
        {isFunder && task.status === "awaiting_approval" && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
            <h2 className="mb-3 font-semibold text-[#eef1f8]">
              Review Submission
            </h2>
            <div className="flex gap-3">
              <button
                onClick={handleRelease}
                disabled={actionLoading}
                className="inline-flex items-center gap-2 rounded-lg bg-green-500/10 px-5 py-2 text-sm font-medium text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                Release Payment
              </button>
              <button
                onClick={() => setShowReject(!showReject)}
                disabled={actionLoading}
                className="inline-flex items-center gap-2 rounded-lg bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </button>
            </div>
            {showReject && (
              <div className="mt-3">
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason for rejection (optional)..."
                  rows={2}
                  className="mb-2 w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none"
                />
                <button
                  onClick={handleReject}
                  disabled={actionLoading}
                  className="rounded-lg bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                >
                  Confirm Rejection
                </button>
              </div>
            )}
          </div>
        )}

        {/* Completed */}
        {task.status === "completed" && (
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-6 text-center">
            <CheckCircle className="h-6 w-6 text-green-400 mx-auto mb-2" />
            <p className="text-green-300">
              This bounty has been completed and paid out.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
