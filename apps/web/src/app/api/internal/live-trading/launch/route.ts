import { NextResponse } from "next/server";
import { verifyInternalBearer } from "@/lib/internal-control-auth";
import { gholaCommitment } from "@/lib/private-account";
import {
  LIVE_TRADING_CAPABILITIES,
  LIVE_TRADING_CONTRACT_VERSION,
  canonicalLiveTradingCaps,
  type LiveTradingLaunchState,
} from "@/lib/live-trading-contract";
import {
  configuredLiveTradingPublicCapabilities,
  currentLiveTradingReleaseIdentity,
} from "@/lib/live-trading-release.server";
import {
  evaluateLiveTradingCapability,
  getLiveTradingLaunchControl,
  putLiveTradingLaunchControl,
} from "@/lib/live-trading-store";
import { probeLiveTradingWorkerReadiness } from "@/lib/private-agent-worker-readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLIC_CONFIRMATION = "ACTIVATE HYPERLIQUID MAINNET LIVE TRADING";

export async function GET(request: Request) {
  if (!authorized(request)) return reply({ error: "live_trading_control_auth_required" }, 401);
  return reply(await launchSnapshot());
}

export async function POST(request: Request) {
  if (!authorized(request)) return reply({ error: "live_trading_control_auth_required" }, 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const state = body?.state;
  if (!isLaunchState(state)) return reply({ error: "launch_state_invalid" }, 400);
  const updatedBy = safeOperator(body?.updated_by);
  if (!updatedBy) return reply({ error: "updated_by_required" }, 400);

  const snapshot = await launchSnapshot(state === "public");
  if ((state === "canary" || state === "public") && !snapshot.release_identity.valid) {
    return reply({ error: "release_identity_not_ready", reason_codes: snapshot.release_identity.reason_codes }, 409);
  }
  if ((state === "canary" || state === "public") && !snapshot.worker_readiness.ready) {
    return reply({ error: "worker_not_ready", reason_codes: snapshot.worker_readiness.reason_codes }, 409);
  }
  if (state === "public") {
    if (body?.confirmation !== PUBLIC_CONFIRMATION) return reply({ error: "public_activation_confirmation_required" }, 409);
    const incomplete = snapshot.capabilities.filter((capability) =>
      snapshot.public_capabilities.includes(capability.id) && capability.state !== "live"
    );
    if (incomplete.length) {
      return reply({ error: "capability_proofs_incomplete", capabilities: incomplete }, 409);
    }
  }

  const current = await getLiveTradingLaunchControl();
  const now = new Date().toISOString();
  const evidenceCommitment = gholaCommitment("live_trading_launch_control", {
    state,
    release_identity: snapshot.release_identity,
    public_capabilities: snapshot.public_capabilities,
    caps: canonicalLiveTradingCaps(),
    updated_by: updatedBy,
    updated_at: now,
  });
  const stored = await putLiveTradingLaunchControl({
    version: 2,
    state,
    contract_version: LIVE_TRADING_CONTRACT_VERSION,
    web_git_sha: snapshot.release_identity.web_git_sha,
    worker_git_sha: snapshot.release_identity.worker_git_sha,
    worker_image_digest: snapshot.release_identity.worker_image_digest,
    config_fingerprint: snapshot.release_identity.config_fingerprint,
    public_capabilities: snapshot.public_capabilities,
    caps: canonicalLiveTradingCaps(),
    evidence_commitment: evidenceCommitment,
    updated_by: updatedBy,
    created_at: current.created_at === new Date(0).toISOString() ? now : current.created_at,
    updated_at: now,
  });
  return reply({ accepted: true, launch_control: stored });
}

async function launchSnapshot(evaluateAsPublic = false) {
  const release = currentLiveTradingReleaseIdentity();
  const publicCapabilities = configuredLiveTradingPublicCapabilities();
  const [control, workerReadiness] = await Promise.all([
    getLiveTradingLaunchControl(),
    probeLiveTradingWorkerReadiness({
      expectedRelease: release,
      requiredCapabilities: publicCapabilities,
    }),
  ]);
  const capabilities = await Promise.all(LIVE_TRADING_CAPABILITIES.map((capability) =>
    evaluateLiveTradingCapability({
      capability,
      release,
      launch_state: evaluateAsPublic ? "public" : control.state,
      visible: publicCapabilities.includes(capability),
    })
  ));
  return {
    version: 2,
    launch_control: control,
    release_identity: release,
    worker_readiness: workerReadiness,
    public_capabilities: publicCapabilities,
    capabilities,
    required_public_confirmation: PUBLIC_CONFIRMATION,
    checked_at: new Date().toISOString(),
  };
}

function authorized(request: Request) {
  return verifyInternalBearer(request, "GHOLA_LIVE_TRADING_CONTROL_TOKEN");
}

function isLaunchState(value: unknown): value is LiveTradingLaunchState {
  return value === "disabled" || value === "canary" || value === "public" || value === "killed";
}

function safeOperator(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9@._:-]{3,100}$/.test(text) ? text : null;
}

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
