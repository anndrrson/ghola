"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, Cpu, DatabaseZap, FileText, LockKeyhole, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import {
  getPrivateAccountOperationsStatus,
  getPrivateAccountPrivacyHealth,
} from "@/lib/private-account-client";
import { useThumperAuth } from "@/lib/thumper-auth-context";

interface HealthState {
  status?: string;
  private_mode_enabled?: boolean;
  production_enabled?: boolean;
  production_enablement_reason?: string | null;
  verifier?: {
    status?: string;
  };
  coordinator?: {
    status?: string;
    reason?: string | null;
    lock?: {
      lock_id?: string;
      expires_at?: string;
    } | null;
  };
  shielded_pool?: {
    status?: string;
    mode?: string;
    indexer?: { status?: string };
    prover?: { status?: string };
    relayer?: { status?: string };
    sealed_runtime?: { status?: string };
  };
  sealed_runtime?: {
    status?: string;
    mode?: string;
    reason?: string | null;
  };
  v6_production_gates?: {
    status?: string;
    failures?: string[];
  };
  canaries?: CanarySummary[];
}

interface CanarySummary {
  canary_kind?: string;
  status?: string;
  evidence_commitment?: string | null;
  reason?: string | null;
}

interface ImportSummary {
  import_commitment: string;
  verifier_status: string;
}

interface OperationsStatus {
  health?: HealthState;
  connector_health?: ConnectorHealth[];
  connector_work_order_depth?: number;
  connector_ready_count?: number;
  connector_work_orders?: ConnectorWorkOrderSummary[];
  connector_results?: ConnectorResultSummary[];
  connector_linkability?: ConnectorLinkabilitySummary[];
  platform_rotations?: PlatformRotationSummary[];
  linkability_simulations?: LinkabilitySimulationSummary[];
  queue_depth?: number;
  ready_evidence?: unknown[];
  settlement_evidence?: unknown[];
  pending_settlements?: unknown[];
  failed_settlements?: unknown[];
  stuck_batches?: unknown[];
  rejected_imports?: ImportSummary[];
  stale_imports?: ImportSummary[];
  canaries?: CanarySummary[];
  anonymity_set_health?: {
    effective: number;
    required: number;
    status: string;
  } | null;
}

interface ConnectorHealth {
  platform_class?: string;
  status?: string;
  live_submit_enabled?: boolean;
  reason_codes?: string[];
}

interface ConnectorWorkOrderSummary {
  work_order_commitment?: string;
  platform_class?: string;
  status?: string;
}

interface ConnectorResultSummary {
  connector_result_commitment?: string;
  platform_class?: string;
  status?: string;
}

interface ConnectorLinkabilitySummary {
  platform_class?: string;
  score_bps?: number;
  risk?: string;
  decision?: string;
}

interface PlatformRotationSummary {
  rotation_commitment?: string;
  status?: string;
  reuse_count?: number;
  withdrawal_destination_reuse_count?: number;
}

interface LinkabilitySimulationSummary {
  simulator_commitment?: string;
  score_bps?: number;
  decision?: string;
  intent_id?: string;
}

export function PrivateAccountOperationsPanel() {
  const auth = useThumperAuth();
  const [status, setStatus] = useState<OperationsStatus | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextHealth = await getPrivateAccountPrivacyHealth();
      setHealth(nextHealth);
      if (auth.authenticated) {
        setStatus(await getPrivateAccountOperationsStatus());
      } else {
        setStatus(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load operations status.");
    } finally {
      setLoading(false);
    }
  }, [auth.authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const effectiveHealth = status?.health || health;
  const verifier = effectiveHealth?.verifier;
  const coordinator = effectiveHealth?.coordinator;
  const shieldedPool = effectiveHealth?.shielded_pool;
  const sealedRuntime = effectiveHealth?.sealed_runtime || shieldedPool?.sealed_runtime;
  const v6Gates = effectiveHealth?.v6_production_gates;
  const canaries = status?.canaries || effectiveHealth?.canaries || [];
  const readyEvidence = status?.ready_evidence || [];
  const settlementEvidence = status?.settlement_evidence || [];
  const pendingSettlements = status?.pending_settlements || [];
  const failedSettlements = status?.failed_settlements || [];
  const stuckBatches = status?.stuck_batches || [];
  const rejectedImports = status?.rejected_imports || [];
  const staleImports = status?.stale_imports || [];
  const connectorHealth = status?.connector_health || [];
  const connectorWorkOrders = status?.connector_work_orders || [];
  const connectorResults = status?.connector_results || [];
  const connectorLinkability = status?.connector_linkability || [];
  const platformRotations = status?.platform_rotations || [];
  const linkabilitySimulations = status?.linkability_simulations || [];

  return (
    <section className="border-t border-[#151b26] px-5 py-10 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">
              Live operations
            </p>
            <h2 className="mt-3 text-2xl font-medium text-[#f6f8ff]">
              Private Mode evidence health
            </h2>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex h-10 items-center gap-2 border border-[#344155] px-3 text-sm text-[#aab5c8] disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric
            icon={ShieldCheck}
            label="Verifier"
            value={verifier?.status || "unknown"}
            tone={verifier?.status === "green" ? "good" : "bad"}
          />
          <Metric
            icon={Activity}
            label="Coordinator"
            value={coordinator?.status || "unknown"}
            tone={coordinator?.status === "green" ? "good" : "bad"}
          />
          <Metric
            icon={Cpu}
            label="Shielded pool"
            value={shieldedPool?.status || "unknown"}
            tone={shieldedPool?.status === "green" ? "good" : "bad"}
          />
          <Metric
            icon={LockKeyhole}
            label="Sealed runtime"
            value={sealedRuntime?.status || "unknown"}
            tone={sealedRuntime?.status === "green" ? "good" : "bad"}
          />
          <Metric
            icon={ShieldCheck}
            label="V6 gates"
            value={v6Gates?.status || "unknown"}
            tone={v6Gates?.status === "green" ? "good" : "bad"}
          />
          <Metric
            icon={ShieldCheck}
            label="Private Mode"
            value={effectiveHealth?.private_mode_enabled ? "enabled" : "disabled"}
            tone={effectiveHealth?.private_mode_enabled ? "good" : "bad"}
          />
          <Metric
            icon={Activity}
            label="Canaries"
            value={`${canaries.filter((item) => item.status === "green").length}/${canaries.length || 3} green`}
            tone={canaries.length > 0 && canaries.every((item) => item.status === "green") ? "good" : "bad"}
          />
          <Metric
            icon={DatabaseZap}
            label="Queue depth"
            value={`${status?.queue_depth ?? 0} waiting`}
            tone={(status?.queue_depth ?? 0) === 0 ? "neutral" : "warn"}
          />
          <Metric
            icon={FileText}
            label="Ready evidence"
            value={`${readyEvidence.length} batches`}
            tone={readyEvidence.length > 0 ? "good" : "neutral"}
          />
          <Metric
            icon={Activity}
            label="Connectors"
            value={`${status?.connector_ready_count ?? 0}/${connectorHealth.length || 6} ready`}
            tone={(status?.connector_ready_count ?? 0) > 0 ? "good" : "warn"}
          />
          <Metric
            icon={DatabaseZap}
            label="Connector work"
            value={`${status?.connector_work_order_depth ?? 0} active`}
            tone={(status?.connector_work_order_depth ?? 0) === 0 ? "neutral" : "warn"}
          />
          <Metric
            icon={LockKeyhole}
            label="Rotations"
            value={`${platformRotations.filter((item) => item.status !== "ready").length} pending`}
            tone={platformRotations.some((item) => item.status !== "ready") ? "warn" : "good"}
          />
          <Metric
            icon={Activity}
            label="Simulator"
            value={`${linkabilitySimulations.filter((item) => item.decision !== "proceed").length} wait/block`}
            tone={linkabilitySimulations.some((item) => item.decision !== "proceed") ? "warn" : "good"}
          />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <ListPanel
            title="Anonymity set"
            items={[
              status?.anonymity_set_health
                ? `${status.anonymity_set_health.effective}/${status.anonymity_set_health.required} compatible imports`
                : "No batch evidence yet",
            ]}
          />
          <ListPanel
            title="Settlement evidence"
            items={settlementEvidence.map((item) =>
              settlementSummary(item))}
          />
          <ListPanel
            title="Pending settlement"
            items={pendingSettlements.map((item) =>
              settlementSummary(item))}
          />
          <ListPanel
            title="Failed settlement"
            items={failedSettlements.map((item) =>
              settlementSummary(item))}
          />
          <ListPanel
            title="Connector health"
            items={connectorHealth.map((item) =>
              `${item.platform_class || "connector"} · ${item.status || "unknown"}${item.reason_codes?.length ? ` · ${item.reason_codes.join(",")}` : ""}`)}
          />
          <ListPanel
            title="Connector work orders"
            items={connectorWorkOrders.map((item) =>
              `${item.work_order_commitment || "work"} · ${item.platform_class || "platform"} · ${item.status || "unknown"}`)}
          />
          <ListPanel
            title="Connector results"
            items={connectorResults.map((item) =>
              `${item.connector_result_commitment || "result"} · ${item.platform_class || "platform"} · ${item.status || "unknown"}`)}
          />
          <ListPanel
            title="Linkability"
            items={connectorLinkability.map((item) =>
              `${item.platform_class || "platform"} · ${item.score_bps ?? 0} bps · ${item.risk || "unknown"} · ${item.decision || "unknown"}`)}
          />
          <ListPanel
            title="Platform rotation"
            items={platformRotations.map((item) =>
              `${item.rotation_commitment || "rotation"} · ${item.status || "unknown"} · reuse ${item.reuse_count ?? 0} · withdrawals ${item.withdrawal_destination_reuse_count ?? 0}`)}
          />
          <ListPanel
            title="Adversarial simulator"
            items={linkabilitySimulations.map((item) =>
              `${item.simulator_commitment || "simulation"} · ${item.score_bps ?? 0} bps · ${item.decision || "unknown"}`)}
          />
          <ListPanel
            title="V6 gate failures"
            items={v6Gates?.failures || []}
          />
          <ListPanel
            title="Canaries"
            items={canaries.map((item) =>
              `${item.canary_kind || "canary"} · ${item.status || "unknown"}${item.reason ? ` · ${item.reason}` : ""}`)}
          />
          <ListPanel
            title="Stuck batches"
            items={stuckBatches.map((item) =>
              batchSummary(item))}
          />
          <ListPanel
            title="Rejected imports"
            items={rejectedImports.map((item: ImportSummary) =>
              `${item.import_commitment} · ${item.verifier_status}`)}
          />
          <ListPanel
            title="Stale imports"
            items={staleImports.map((item: ImportSummary) =>
              `${item.import_commitment} · ${item.verifier_status}`)}
          />
        </div>

        {!auth.authenticated && (
          <p className="mt-4 flex items-center gap-2 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            Sign in to view account-specific queues, imports, evidence, and exports.
          </p>
        )}
        {error && <p className="mt-4 text-sm text-red-200">{error}</p>}
      </div>
    </section>
  );
}

function settlementSummary(item: unknown): string {
  if (!item || typeof item !== "object") return "unknown settlement";
  const record = item as Record<string, unknown>;
  return `${String(record.settlement_commitment || "settlement")} · ${String(record.lifecycle_status || record.relay_status || "unknown")}`;
}

function batchSummary(item: unknown): string {
  if (!item || typeof item !== "object") return "unknown batch";
  const record = item as Record<string, unknown>;
  return `${String(record.batch_id || "batch")} · ${String(record.effective_anonymity_set || 0)}/${String(record.required_anonymity_set || 0)}`;
}

function Metric({ icon: Icon, label, value, tone }: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "neutral";
}) {
  const color = tone === "good"
    ? "text-emerald-200"
    : tone === "bad"
      ? "text-red-200"
      : tone === "warn"
        ? "text-amber-200"
        : "text-[#aab5c8]";
  return (
    <div className="border border-[#1e2a3a] bg-[#0f1117] p-4">
      <Icon className={`h-4 w-4 ${color}`} />
      <p className="mt-3 text-xs text-[#6f7d9a]">{label}</p>
      <p className={`mt-1 text-sm font-medium ${color}`}>{value.replaceAll("_", " ")}</p>
    </div>
  );
}

function ListPanel({ title, items }: { title: string; items: string[] }) {
  const safeItems = items.length ? items : ["none"];
  return (
    <div className="border border-[#1e2a3a] bg-[#0f1117] p-4">
      <h3 className="text-sm font-medium text-[#eef1f8]">{title}</h3>
      <div className="mt-3 space-y-2">
        {safeItems.slice(0, 5).map((item) => (
          <p key={item} className="break-all font-mono text-xs text-[#8b95a8]">{item}</p>
        ))}
      </div>
    </div>
  );
}
