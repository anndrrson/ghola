import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/app/api/auth/session/_lib";

export const FUNDED_TESTNET_CONFIRMATION =
  "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_FUNDED_TESTNET_POSITION";

const UI_CONFIRMATION = "RUN_FUNDED_HYPERLIQUID_TESTNET_ROUND_TRIP";
const MAX_OUTPUT_BYTES = 1_000_000;
const ROUND_TRIP_TIMEOUT_MS = 120_000;

export type FundedTestnetRoundTripReport = {
  ok: true;
  network: "testnet";
  market: string;
  notional_usd: number;
  claim_store: "postgres";
  entry_status: "filled";
  entry_fill_proven: true;
  duplicate_entry_prevented: true;
  opened_position_verified: true;
  exit_status: "filled";
  exit_fill_proven: true;
  duplicate_exit_prevented: true;
  flat_after_exit: true;
  open_orders_after_exit: 0;
  stored_receipt_replayed: true;
  entry_work_order_commitment: string;
  exit_work_order_commitment: string;
  completed_at: string;
};

type Dependencies = {
  runRoundTrip: () => Promise<unknown>;
};

export function fundedTestnetRoundTripEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV !== "production" &&
    env.GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED === "true" &&
    env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM === FUNDED_TESTNET_CONFIRMATION &&
    /^postgres(?:ql)?:\/\//.test(env.PRIVATE_AGENT_TEST_POSTGRES_URL?.trim() ?? "") &&
    /^0x[0-9a-fA-F]{40}$/.test(env.GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS?.trim() ?? "") &&
    /^0x[0-9a-fA-F]{64}$/.test(env.GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY?.trim() ?? "");
}

export function createFundedTestnetRoundTripPost(dependencies: Dependencies) {
  let running = false;

  return async function POST(req: NextRequest) {
    if (!fundedTestnetRoundTripEnabled()) {
      return json({ error: "funded_testnet_round_trip_unavailable" }, 404);
    }
    if (!sameOrigin(req)) {
      return json({ error: "cross_site_testnet_round_trip_rejected" }, 403);
    }
    if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return json({ error: "json_content_type_required" }, 415);
    }
    const body = await req.json().catch(() => null);
    if (!exactConfirmation(body)) {
      return json({ error: "funded_testnet_round_trip_confirmation_required" }, 400);
    }
    if (running) {
      return json({ error: "funded_testnet_round_trip_already_running" }, 409);
    }

    running = true;
    try {
      const report = inspectReport(await dependencies.runRoundTrip());
      if (!report) {
        console.error(JSON.stringify({
          level: "error",
          event: "funded_testnet_round_trip_invalid_report",
          checked_at: new Date().toISOString(),
        }));
        return json({ error: "funded_testnet_round_trip_failed" }, 502);
      }
      console.info(JSON.stringify({
        level: "info",
        event: "funded_testnet_round_trip_completed",
        market: report.market,
        notional_usd: report.notional_usd,
        entry_work_order_commitment: report.entry_work_order_commitment,
        exit_work_order_commitment: report.exit_work_order_commitment,
        completed_at: report.completed_at,
      }));
      return json(report, 200);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "funded_testnet_round_trip_failed",
        error: error instanceof Error ? error.message : "unknown",
        checked_at: new Date().toISOString(),
      }));
      return json({ error: "funded_testnet_round_trip_failed" }, 502);
    } finally {
      running = false;
    }
  };
}

export async function runFundedTestnetRoundTripSubprocess(): Promise<unknown> {
  const workerRoot = resolve(process.cwd(), "../private-agent-worker");
  const script = resolve(workerRoot, "scripts/hyperliquid-testnet-roundtrip.mjs");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: workerRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      callback();
    };
    const append = (current: string, chunk: Buffer) => {
      const next = `${current}${chunk.toString("utf8")}`;
      return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const report = reportFromOutput(stdout);
      if (code === 0 && report) {
        resolvePromise(report);
        return;
      }
      reject(new Error(`round_trip_process_failed:${code ?? "unknown"}:${safeFailure(stderr)}`));
    }));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("round_trip_process_timeout")));
    }, ROUND_TRIP_TIMEOUT_MS);
  });
}

function reportFromOutput(output: string): unknown {
  const line = output
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("GHOLA_TESTNET_ROUNDTRIP_RESULT="));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("GHOLA_TESTNET_ROUNDTRIP_RESULT=".length));
  } catch {
    return null;
  }
}

function inspectReport(value: unknown): FundedTestnetRoundTripReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  const completedAt = typeof report.completed_at === "string" ? Date.parse(report.completed_at) : Number.NaN;
  if (
    report.ok !== true ||
    report.network !== "testnet" ||
    report.claim_store !== "postgres" ||
    report.entry_status !== "filled" ||
    report.entry_fill_proven !== true ||
    report.duplicate_entry_prevented !== true ||
    report.opened_position_verified !== true ||
    report.exit_status !== "filled" ||
    report.exit_fill_proven !== true ||
    report.duplicate_exit_prevented !== true ||
    report.flat_after_exit !== true ||
    report.open_orders_after_exit !== 0 ||
    report.stored_receipt_replayed !== true ||
    typeof report.market !== "string" ||
    !/^[A-Z0-9]{2,12}$/.test(report.market) ||
    typeof report.notional_usd !== "number" ||
    !Number.isFinite(report.notional_usd) ||
    report.notional_usd < 10 ||
    report.notional_usd > 15 ||
    !workOrder(report.entry_work_order_commitment, "entry") ||
    !workOrder(report.exit_work_order_commitment, "exit") ||
    !Number.isFinite(completedAt) ||
    new Date(completedAt).toISOString() !== report.completed_at
  ) return null;
  return report as FundedTestnetRoundTripReport;
}

function exactConfirmation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 1 && row.confirmation === UI_CONFIRMATION;
}

function workOrder(value: unknown, phase: "entry" | "exit") {
  return typeof value === "string" &&
    new RegExp(`^hl_testnet_roundtrip_${phase}_[a-z0-9_]{8,80}$`).test(value);
}

function safeFailure(value: string) {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted_postgres_url]")
    .replace(/0x[0-9a-fA-F]{40,64}/g, "[redacted]")
    .slice(-500);
}

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
}
