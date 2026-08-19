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
  transitionLiveTradingLaunchControl,
  type LiveTradingLaunchControl,
  type LiveTradingLaunchTransitionResult,
} from "@/lib/live-trading-store";
import { probeLiveTradingWorkerReadiness } from "@/lib/private-agent-worker-readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLIC_CONFIRMATION = "ACTIVATE HYPERLIQUID MAINNET LIVE TRADING";
const KILL_CONFIRMATION = "KILL HYPERLIQUID MAINNET LIVE TRADING";
const RESET_CONFIRMATION = "RESET KILLED LIVE TRADING TO DISABLED";

export async function GET(request: Request) {
  if (!authorized(request) && !resetAuthorized(request)) {
    return reply({ error: "live_trading_control_auth_required" }, 401);
  }
  return reply(await launchSnapshot());
}

export async function POST(request: Request) {
  const controlAuthorized = authorized(request);
  const hasResetAuthority = resetAuthorized(request);
  if (!controlAuthorized && !hasResetAuthority) {
    return reply({ error: "live_trading_control_auth_required" }, 401);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const state = body?.state;
  if (!isLaunchState(state)) return reply({ error: "launch_state_invalid" }, 400);
  const updatedBy = safeOperator(body?.updated_by);
  if (!updatedBy) return reply({ error: "updated_by_required" }, 400);

  if (state === "killed") {
    if (!controlAuthorized) return reply({ error: "live_trading_control_auth_required" }, 401);
    if (body?.confirmation !== KILL_CONFIRMATION) return reply({ error: "kill_confirmation_required" }, 409);
    const now = new Date().toISOString();
    return transitionReply(await transitionLiveTradingLaunchControl({
      kind: "kill",
      updated_by: updatedBy,
      updated_at: now,
      evidence_commitment: gholaCommitment("live_trading_launch_control", {
        state: "killed",
        updated_by: updatedBy,
        updated_at: now,
      }),
    }));
  }

  if (state === "disabled" && hasResetAuthority) {
    if (body?.confirmation !== RESET_CONFIRMATION) {
      return reply({ error: "killed_reset_confirmation_required" }, 409);
    }
    const expectedRevision = safeRevision(body?.expected_revision);
    if (expectedRevision === null) return reply({ error: "killed_reset_revision_required" }, 409);
    const now = new Date().toISOString();
    return transitionReply(await transitionLiveTradingLaunchControl({
      kind: "reset",
      expected_revision: expectedRevision,
      updated_by: updatedBy,
      updated_at: now,
      evidence_commitment: gholaCommitment("live_trading_launch_control", {
        state: "disabled",
        reset_from: "killed",
        expected_revision: expectedRevision,
        updated_by: updatedBy,
        updated_at: now,
      }),
    }));
  }

  if (!controlAuthorized) return reply({ error: "live_trading_control_auth_required" }, 401);
  if (state === "public" && body?.confirmation !== PUBLIC_CONFIRMATION) {
    return reply({ error: "public_activation_confirmation_required" }, 409);
  }

  const current = await getLiveTradingLaunchControl();
  if (current.state === "killed") {
    return reply({ error: "launch_killed_absorbing", launch_control: current }, 409);
  }
  if (state === "disabled") {
    const now = new Date().toISOString();
    const evidenceCommitment = gholaCommitment("live_trading_launch_control", {
      state,
      previous_revision: current.revision,
      updated_by: updatedBy,
      updated_at: now,
    });
    return transitionReply(await transitionLiveTradingLaunchControl({
      kind: "set",
      expected_revision: current.revision,
      control: controlForSet(current, {
        state,
        evidence_commitment: evidenceCommitment,
        updated_by: updatedBy,
        updated_at: now,
      }),
    }));
  }

  const snapshot = await launchSnapshot(state === "public", current);
  if ((state === "canary" || state === "public") && !snapshot.release_identity.valid) {
    return reply({ error: "release_identity_not_ready", reason_codes: snapshot.release_identity.reason_codes }, 409);
  }
  if ((state === "canary" || state === "public") && !snapshot.worker_readiness.ready) {
    return reply({ error: "worker_not_ready", reason_codes: snapshot.worker_readiness.reason_codes }, 409);
  }
  if (state === "public") {
    const incomplete = snapshot.capabilities.filter((capability) =>
      snapshot.public_capabilities.includes(capability.id) && capability.state !== "live"
    );
    if (incomplete.length) {
      return reply({ error: "capability_proofs_incomplete", capabilities: incomplete }, 409);
    }
  }

  const now = new Date().toISOString();
  const evidenceCommitment = gholaCommitment("live_trading_launch_control", {
    state,
    release_identity: snapshot.release_identity,
    public_capabilities: snapshot.public_capabilities,
    caps: canonicalLiveTradingCaps(),
    updated_by: updatedBy,
    updated_at: now,
  });
  return transitionReply(await transitionLiveTradingLaunchControl({
    kind: "set",
    expected_revision: current.revision,
    control: {
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
    },
  }));
}

async function launchSnapshot(evaluateAsPublic = false, knownControl?: LiveTradingLaunchControl) {
  const release = currentLiveTradingReleaseIdentity();
  const publicCapabilities = configuredLiveTradingPublicCapabilities();
  const [control, workerReadiness] = await Promise.all([
    knownControl ?? getLiveTradingLaunchControl(),
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
    required_kill_confirmation: KILL_CONFIRMATION,
    required_killed_reset_confirmation: RESET_CONFIRMATION,
    checked_at: new Date().toISOString(),
  };
}

function authorized(request: Request) {
  return verifyInternalBearer(request, "GHOLA_LIVE_TRADING_CONTROL_TOKEN");
}

function resetAuthorized(request: Request) {
  const controlToken = process.env.GHOLA_LIVE_TRADING_CONTROL_TOKEN?.trim() || "";
  const resetToken = process.env.GHOLA_LIVE_TRADING_RESET_TOKEN?.trim() || "";
  return resetToken !== controlToken && verifyInternalBearer(request, "GHOLA_LIVE_TRADING_RESET_TOKEN");
}

function isLaunchState(value: unknown): value is LiveTradingLaunchState {
  return value === "disabled" || value === "canary" || value === "public" || value === "killed";
}

function safeOperator(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9@._:-]{3,100}$/.test(text) ? text : null;
}

function safeRevision(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function controlForSet(
  current: LiveTradingLaunchControl,
  update: Pick<LiveTradingLaunchControl, "state" | "evidence_commitment" | "updated_by" | "updated_at">,
): Omit<LiveTradingLaunchControl, "revision"> {
  return {
    version: current.version,
    state: update.state,
    contract_version: current.contract_version,
    web_git_sha: current.web_git_sha,
    worker_git_sha: current.worker_git_sha,
    worker_image_digest: current.worker_image_digest,
    config_fingerprint: current.config_fingerprint,
    public_capabilities: current.public_capabilities,
    caps: current.caps,
    evidence_commitment: update.evidence_commitment,
    updated_by: update.updated_by,
    created_at: current.created_at === new Date(0).toISOString() ? update.updated_at : current.created_at,
    updated_at: update.updated_at,
  };
}

function transitionReply(result: LiveTradingLaunchTransitionResult) {
  return result.ok
    ? reply({ accepted: true, launch_control: result.control })
    : reply({ error: result.error, launch_control: result.control }, 409);
}

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
