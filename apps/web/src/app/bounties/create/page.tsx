"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBountyTask } from "@/lib/thumper-api";
import { BOUNTY_TASK_TYPES } from "@/lib/thumper-types";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { ArrowLeft, Loader2, DollarSign } from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors";
const labelCls = "mb-1 block text-sm font-medium text-[#eef1f8]";
const hintCls = "mt-1 text-xs text-[#8b95a8]";

export default function CreateBountyPage() {
  const router = useRouter();
  const { authenticated, loading: authLoading } = useThumperAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState("other");
  const [bountyUsdc, setBountyUsdc] = useState("");
  const [paramsJson, setParamsJson] = useState("");
  const [minReputation, setMinReputation] = useState("");

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/signin");
    }
  }, [authLoading, authenticated, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!description.trim()) {
      setError("Description is required.");
      return;
    }
    const amount = parseFloat(bountyUsdc);
    if (isNaN(amount) || amount <= 0) {
      setError("Bounty amount must be a positive number.");
      return;
    }

    let params: Record<string, unknown> = {};
    if (paramsJson.trim()) {
      try {
        params = JSON.parse(paramsJson);
      } catch {
        setError("Parameters must be valid JSON.");
        return;
      }
    }

    setSubmitting(true);
    try {
      const minRep = minReputation ? parseFloat(minReputation) / 100 : undefined;
      await createBountyTask({
        title: title.trim(),
        description: description.trim(),
        task_type: taskType,
        bounty_usdc: Math.round(amount * 1_000_000),
        params,
        min_reputation: minRep,
      });
      router.push("/bounties/dashboard");
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to create bounty.");
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#08090d] flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[#3da8ff]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#08090d]">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link
          href="/bounties"
          className="inline-flex items-center gap-1 text-sm text-[#8b95a8] hover:text-[#eef1f8] mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Bounties
        </Link>

        <h1 className="text-2xl font-bold text-[#eef1f8] mb-1">
          Post a Bounty
        </h1>
        <p className="text-[#8b95a8] mb-8">
          Create a task with a USDC bounty for someone to complete.
        </p>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Task Details */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[#8b95a8] uppercase tracking-wider">
              Task Details
            </h2>

            <div>
              <label className={labelCls}>Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Research competitor pricing strategies"
                className={inputCls}
                required
              />
            </div>

            <div>
              <label className={labelCls}>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what the executor needs to do, deliverables, and any requirements..."
                rows={4}
                className={inputCls}
                required
              />
            </div>

            <div>
              <label className={labelCls}>Task Type</label>
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
                className={inputCls}
              >
                {BOUNTY_TASK_TYPES.map((tt) => (
                  <option key={tt} value={tt}>
                    {tt.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Bounty Amount */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[#8b95a8] uppercase tracking-wider">
              Bounty
            </h2>

            <div>
              <label className={labelCls}>Amount (USDC)</label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#4a5568]" />
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={bountyUsdc}
                  onChange={(e) => setBountyUsdc(e.target.value)}
                  placeholder="5.00"
                  className={`${inputCls} pl-10`}
                  required
                />
              </div>
              <p className={hintCls}>
                3% platform fee applies. Funds are held in escrow until you
                approve the work.
              </p>
            </div>

            <div>
              <label className={labelCls}>
                Minimum Reputation (optional)
              </label>
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={minReputation}
                onChange={(e) => setMinReputation(e.target.value)}
                placeholder="e.g. 60 (percent)"
                className={inputCls}
              />
              <p className={hintCls}>
                Only executors with this reputation score or higher can claim.
                Leave blank to allow anyone.
              </p>
            </div>
          </div>

          {/* Optional Params */}
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[#8b95a8] uppercase tracking-wider">
              Additional Parameters (optional)
            </h2>
            <div>
              <label className={labelCls}>Parameters (JSON)</label>
              <textarea
                value={paramsJson}
                onChange={(e) => setParamsJson(e.target.value)}
                placeholder='{"deadline": "2026-04-01", "format": "PDF"}'
                rows={3}
                className={`${inputCls} font-mono text-sm`}
              />
              <p className={hintCls}>
                Structured data for the executor. Must be valid JSON.
              </p>
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <DollarSign className="h-4 w-4" />
            )}
            {submitting ? "Creating..." : "Post Bounty"}
          </button>
        </form>
      </div>
    </div>
  );
}
