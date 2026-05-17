"use client";

import { useEffect, useState, useCallback } from "react";
import { Shield, AlertTriangle, Save, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { getLimits, updateLimits, type LimitsView } from "@/lib/api";

// Spending limits page — defensive mode for power users.
// Most visitors never see this; defaults are sane on signup ($50/day,
// $1000/month). The few who care (production agent runners, anyone burned
// by a runaway loop, finance teams approving deposits) need it accessible.

const formatUsd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

export default function LimitsPage() {
  const [view, setView] = useState<LimitsView | null>(null);
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  const [total, setTotal] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await getLimits();
      setView(v);
      setDaily((v.budget.daily_cap_micro / 1_000_000).toString());
      setMonthly((v.budget.monthly_cap_micro / 1_000_000).toString());
      setTotal(
        v.budget.total_cap_micro
          ? (v.budget.total_cap_micro / 1_000_000).toString()
          : ""
      );
      setEnabled(v.budget.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load limits");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setError(null);
    setSavedMsg(null);
    setSaving(true);
    try {
      const dailyNum = parseFloat(daily);
      const monthlyNum = parseFloat(monthly);
      const totalNum = total.trim() === "" ? null : parseFloat(total);
      if (Number.isNaN(dailyNum) || Number.isNaN(monthlyNum)) {
        throw new Error("Daily and monthly caps must be numbers");
      }
      await updateLimits({
        daily_cap_usd: dailyNum,
        monthly_cap_usd: monthlyNum,
        total_cap_usd: totalNum,
        enabled,
      });
      setSavedMsg("Limits saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/account"
        className="inline-flex items-center gap-2 text-sm text-[#a1a1a1] hover:text-[#fafafa] mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Back to account
      </Link>

      <div className="mb-10">
        <div className="flex items-center gap-3 mb-3">
          <Shield className="h-6 w-6 text-[#00E5A0]" />
          <h1 className="text-3xl font-medium tracking-tight text-[#fafafa]">
            Spending limits
          </h1>
        </div>
        <p className="max-w-xl text-[#a1a1a1]">
          Cap how much you can spend in a day, month, or lifetime. Hits a cap →
          calls 402 with a useful error. Defaults are $50/day, $1000/month, no
          lifetime cap.
        </p>
      </div>

      {/* Current spend snapshot */}
      {view && (
        <div className="rounded-xl border border-[#262626] bg-[#141414] p-6 mb-8">
          <h2 className="text-sm font-medium text-[#a1a1a1] mb-4 uppercase tracking-wide">
            Current spend
          </h2>
          <div className="grid grid-cols-3 gap-6">
            <SpendStat
              label="Today"
              spent={view.spend.day_micro}
              cap={view.budget.daily_cap_micro}
            />
            <SpendStat
              label="Last 30d"
              spent={view.spend.month_micro}
              cap={view.budget.monthly_cap_micro}
            />
            <SpendStat
              label="All time"
              spent={view.spend.total_micro}
              cap={view.budget.total_cap_micro}
            />
          </div>
        </div>
      )}

      {/* Cap inputs */}
      <div className="rounded-xl border border-[#262626] bg-[#141414] p-6 mb-8">
        <h2 className="text-lg font-medium text-[#fafafa] mb-6">Caps</h2>

        <label className="block mb-5">
          <span className="block text-sm text-[#a1a1a1] mb-1.5">
            Daily cap (USD)
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            className="w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-4 py-2.5 text-[#fafafa] focus:border-[#00E5A0] focus:outline-none"
          />
        </label>

        <label className="block mb-5">
          <span className="block text-sm text-[#a1a1a1] mb-1.5">
            Monthly cap (USD)
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            className="w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-4 py-2.5 text-[#fafafa] focus:border-[#00E5A0] focus:outline-none"
          />
        </label>

        <label className="block mb-5">
          <span className="block text-sm text-[#a1a1a1] mb-1.5">
            Lifetime cap (USD, optional)
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="No lifetime cap"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            className="w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-4 py-2.5 text-[#fafafa] focus:border-[#00E5A0] focus:outline-none"
          />
        </label>

        <label className="flex items-center gap-3 mb-6 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-[#262626] bg-[#0a0a0a]"
          />
          <span className="text-sm text-[#fafafa]">
            Enforce these caps (off = unlimited spend)
          </span>
        </label>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 p-3 text-sm text-[#fca5a5]">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        {savedMsg && (
          <div className="mb-4 rounded-lg border border-[#00E5A0]/30 bg-[#00E5A0]/10 p-3 text-sm text-[#00E5A0]">
            {savedMsg}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-[#00E5A0] px-6 py-2.5 text-sm font-medium text-[#0a0a0a] hover:bg-[#00cc8e] disabled:opacity-50 transition-colors active:scale-[0.98]"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save limits"}
        </button>
      </div>

      {!enabled && (
        <p className="text-sm text-[#fbbf24] flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          Caps are off — a runaway agent could drain your full balance. Most
          users should leave this on.
        </p>
      )}
    </main>
  );
}

function SpendStat({
  label,
  spent,
  cap,
}: {
  label: string;
  spent: number;
  cap: number | null;
}) {
  const pct = cap && cap > 0 ? Math.min(100, (spent / cap) * 100) : null;
  const overCap = cap !== null && spent >= cap;
  return (
    <div>
      <div className="text-xs text-[#666] uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="text-2xl font-mono text-[#fafafa]">
        {formatUsd(spent)}
      </div>
      <div className="text-xs text-[#666] mt-1">
        {cap === null ? "no cap" : `of ${formatUsd(cap)}`}
      </div>
      {pct !== null && (
        <div className="mt-2 h-1 w-full rounded-full bg-[#262626]">
          <div
            className={`h-1 rounded-full transition-all ${
              overCap ? "bg-[#ef4444]" : pct > 80 ? "bg-[#fbbf24]" : "bg-[#00E5A0]"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
