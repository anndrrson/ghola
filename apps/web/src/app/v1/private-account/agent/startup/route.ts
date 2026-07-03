import { NextResponse } from "next/server";
import { privateAccountOwnerFromRequest } from "../../_lib";
import { GET as liveTradingStatusGET } from "../../live-trading/status/route";
import { agentPassportForOwner, type AgentPassport } from "@/lib/private-agent-passport";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { gholaCommitment } from "@/lib/private-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PublicVenueId = "coinbase" | "jupiter" | "phoenix" | "hyperliquid";
type PassportVenueId = "coinbase_advanced" | "jupiter" | "hyperliquid";

interface AgentStartupLiveStatus {
  status: "green" | "red" | string;
  live_submit_mode: "disabled" | "byo_mainnet" | "pooled_and_byo" | string;
  byo_live_trading_enabled: boolean;
  pooled_live_trading_enabled: boolean;
  gate_commitment?: string | null;
  byo_live_venues?: Array<{
    id?: string;
    status?: "green" | "red" | string;
  }>;
}

const PUBLIC_VENUES: Array<{
  id: PublicVenueId;
  passport_id: PassportVenueId | null;
  label: string;
  headline: string;
}> = [
  {
    id: "coinbase",
    passport_id: "coinbase_advanced",
    label: "Coinbase",
    headline: "Scoped Coinbase key",
  },
  {
    id: "jupiter",
    passport_id: "jupiter",
    label: "Jupiter",
    headline: "Sealed Solana swap authority",
  },
  {
    id: "phoenix",
    passport_id: null,
    label: "Phoenix",
    headline: "Eligible wallet live path",
  },
  {
    id: "hyperliquid",
    passport_id: "hyperliquid",
    label: "Hyperliquid",
    headline: "Scoped API wallet",
  },
];

export async function GET(request: Request) {
  const [runtime, liveStatus, owner] = await Promise.all([
    getPrivateAgentRuntimeStatus(),
    readLiveStatus(),
    privateAccountOwnerFromRequest(request),
  ]);
  const passport = owner ? await agentPassportForOwner(owner) : null;
  const runtimeState = runtime.remote_execution_ready ? "ready" : phalaConfigured(runtime) ? "warming" : "blocked";
  const venues = PUBLIC_VENUES.map((venue) => publicVenueStartup({
    venue,
    authenticated: Boolean(owner),
    passport,
    runtimeReady: runtime.remote_execution_ready,
    liveStatus,
  }));
  const readyVenue = venues.find((venue) => venue.can_start_live);
  const preparedVenue = venues.find((venue) => venue.can_prepare);
  const primary = !owner
    ? {
        label: "Sign in to connect a venue",
        enabled: true,
        message: "Create or unlock your Ghola account, then connect scoped venue access.",
      }
    : readyVenue
      ? {
          label: `Start ${readyVenue.label} agent`,
          enabled: true,
          message: "Secure worker, venue access, and caps are green.",
        }
      : preparedVenue
        ? {
            label: "Start secure worker",
            enabled: true,
            message: preparedVenue.user_access === "ready"
              ? "Your venue access is ready. Start the secure worker before live execution."
              : "Start the secure worker while you connect eligible venue access.",
          }
        : {
            label: "Connect a venue",
            enabled: true,
            message: "Pick any supported venue you already use. Ghola will only enable real green actions.",
          };
  const checkedAt = new Date().toISOString();

  return NextResponse.json({
    version: 1,
    checked_at: checkedAt,
    authenticated: Boolean(owner),
    runtime: {
      status: runtimeState,
      ready: runtime.remote_execution_ready,
      selected_provider: runtime.selected_provider,
      label: runtime.remote_execution_ready
        ? "Secure worker ready"
        : runtimeState === "warming"
          ? "Secure worker can start"
          : "Secure worker unavailable",
      message: runtime.remote_execution_ready
        ? "Agent execution can run inside the attested worker."
        : runtimeState === "warming"
          ? "Starting secure worker can take about a minute."
          : "Live agents are temporarily unavailable. Venue access will not be used until the worker is ready.",
    },
    live_trading: {
      status: liveStatus.status,
      live_submit_mode: liveStatus.live_submit_mode,
      byo_live_trading_enabled: liveStatus.byo_live_trading_enabled,
      pooled_live_trading_enabled: liveStatus.pooled_live_trading_enabled,
      gate_commitment: liveStatus.gate_commitment,
    },
    agent_passport: passport
      ? {
          status: passport.status,
          passport_commitment: passport.passport_commitment,
          ready_venues: passport.venues.filter((venue) => venue.status === "ready").map((venue) => venue.venue_id),
        }
      : null,
    venues,
    primary_action: primary,
    startup_commitment: gholaCommitment("public_agent_startup", {
      authenticated: Boolean(owner),
      runtime_status: runtimeState,
      runtime_provider: runtime.selected_provider,
      live_submit_mode: liveStatus.live_submit_mode,
      venues: venues.map((venue) => ({
        id: venue.id,
        live_gate: venue.live_gate,
        user_access: venue.user_access,
        can_start_live: venue.can_start_live,
      })),
      checked_at: checkedAt,
    }),
  }, {
    headers: { "cache-control": "no-store" },
  });
}

async function readLiveStatus(): Promise<AgentStartupLiveStatus> {
  const response = await liveTradingStatusGET();
  return (await response.json()) as AgentStartupLiveStatus;
}

function publicVenueStartup(input: {
  venue: (typeof PUBLIC_VENUES)[number];
  authenticated: boolean;
  passport: AgentPassport | null;
  runtimeReady: boolean;
  liveStatus: AgentStartupLiveStatus;
}) {
  const liveVenue = (input.liveStatus.byo_live_venues ?? []).find((venue: { id?: string }) => venue.id === input.venue.id);
  const liveGate = liveVenue?.status === "green" ? "green" as const : "blocked" as const;
  const passportVenue = input.venue.passport_id
    ? input.passport?.venues.find((venue) => venue.venue_id === input.venue.passport_id)
    : null;
  const hasUserAccess = passportVenue?.status === "ready";
  const userAccess = !input.authenticated
    ? "sign_in_required" as const
    : input.venue.passport_id === null
      ? "wallet_required" as const
      : hasUserAccess
        ? "ready" as const
        : "connect_required" as const;
  const canPrepare = input.authenticated && liveGate === "green" && (hasUserAccess || input.venue.passport_id === null);
  const canStartLive = canPrepare && input.runtimeReady && userAccess === "ready";
  const statusLabel = venueStatusLabel({
    authenticated: input.authenticated,
    liveGate,
    userAccess,
    runtimeReady: input.runtimeReady,
    isPhoenix: input.venue.id === "phoenix",
  });

  return {
    id: input.venue.id,
    label: input.venue.label,
    headline: input.venue.headline,
    live_gate: liveGate,
    user_access: userAccess,
    status_label: statusLabel.label,
    status_tone: statusLabel.tone,
    next_action: statusLabel.nextAction,
    can_prepare: canPrepare,
    can_start_live: canStartLive,
    passport_permission_commitment: passportVenue?.permission_commitment ?? null,
    vault_commitment: passportVenue?.vault_commitment ?? null,
  };
}

function venueStatusLabel(input: {
  authenticated: boolean;
  liveGate: "green" | "blocked";
  userAccess: "sign_in_required" | "wallet_required" | "ready" | "connect_required";
  runtimeReady: boolean;
  isPhoenix: boolean;
}) {
  if (!input.authenticated) {
    return {
      label: "Sign in to connect",
      tone: "neutral" as const,
      nextAction: "Sign in",
    };
  }
  if (input.liveGate !== "green") {
    return {
      label: "Venue live gate not ready",
      tone: "warn" as const,
      nextAction: "Check later",
    };
  }
  if (input.userAccess === "connect_required") {
    return {
      label: "Connect scoped access",
      tone: "primary" as const,
      nextAction: "Connect venue",
    };
  }
  if (input.userAccess === "wallet_required") {
    return {
      label: input.isPhoenix ? "Eligible wallet required" : "Connect wallet",
      tone: "primary" as const,
      nextAction: input.isPhoenix ? "Connect eligible wallet" : "Connect wallet",
    };
  }
  if (!input.runtimeReady) {
    return {
      label: "Ready after secure worker starts",
      tone: "warn" as const,
      nextAction: "Start worker",
    };
  }
  return {
    label: "Agent ready",
    tone: "good" as const,
    nextAction: "Start live agent",
  };
}

function phalaConfigured(runtime: Awaited<ReturnType<typeof getPrivateAgentRuntimeStatus>>) {
  const phala = runtime.providers.find((provider) => provider.id === "phala");
  return phala?.configured === true;
}
