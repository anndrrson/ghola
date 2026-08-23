import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { privateAccountLaunchStatus } from "@/lib/private-account-launch-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Trading beta readiness — Ghola",
  description: "Live, fail-closed release readiness for Ghola's public trading beta.",
  robots: { index: false, follow: false },
};

export default async function TradingBetaReadinessPage() {
  let status: Awaited<ReturnType<typeof privateAccountLaunchStatus>> | null = null;

  try {
    status = await privateAccountLaunchStatus();
  } catch {
    status = null;
  }

  if (!status) {
    return (
      <ReadinessShell
        ready={false}
        summary="The readiness check is unavailable, so launch is blocked."
      />
    );
  }

  const blocked = status.checks.filter((item) => item.status !== "ready");

  return (
    <ReadinessShell
      ready={status.ready_to_accept_users}
      checkedAt={status.checked_at}
      summary={
        status.ready_to_accept_users
          ? "Every safety and operations gate is ready."
          : `${blocked.length} release ${blocked.length === 1 ? "gate is" : "gates are"} blocking launch.`
      }
    >
      <div className="mt-10 space-y-3">
        {status.checks.map((item) => (
          <div
            key={item.check}
            className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="font-mono text-xs text-[#d7dce7]">
              {item.check}
            </span>
            <span
              className={
                item.status === "ready"
                  ? "text-sm text-emerald-400"
                  : "text-sm text-amber-300"
              }
            >
              {item.status === "ready" ? "Ready" : item.reason ?? item.status}
            </span>
          </div>
        ))}
      </div>
    </ReadinessShell>
  );
}

function ReadinessShell({
  ready,
  checkedAt,
  summary,
  children,
}: {
  ready: boolean;
  checkedAt?: string;
  summary: string;
  children?: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[#08090d] px-6 py-16 text-[#eef1f8] lg:py-24">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/security/status"
          className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8] hover:text-[#eef1f8]"
        >
          ← security status
        </Link>
        <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
          Public trading beta · live release gate
        </p>
        <h1 className="mt-4 font-display text-4xl font-medium leading-tight md:text-5xl">
          {ready ? "Ready to accept users" : "Launch blocked"}
        </h1>
        <p className={ready ? "mt-4 text-emerald-400" : "mt-4 text-amber-300"}>
          {summary}
        </p>
        {checkedAt ? (
          <p className="mt-2 font-mono text-xs text-[#6f798c]">
            Checked {checkedAt}
          </p>
        ) : null}
        {children}
      </div>
    </main>
  );
}
