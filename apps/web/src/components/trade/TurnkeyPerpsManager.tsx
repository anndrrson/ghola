"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, KeyRound, Power, ShieldCheck } from "lucide-react";
import {
  armHyperliquidExecutionAgent,
  getHyperliquidExecutionVaultStatus,
  sealHyperliquidExecutionVault,
  verifyPrivateAccountConnectorNoSubmit,
} from "@/lib/private-account-client";
import { buildPrivateExecutionInstructionBundle } from "@/lib/private-execution-instruction-seal";
import { buildTurnkeyHyperliquidExecutionVaultBundle } from "@/lib/hyperliquid-vault-seal";
import { usePerpsTurnkey } from "@/lib/perps-turnkey-provider";
import {
  buildGholaPerpsMandate,
  DEFAULT_GHOLA_PERPS_RISK,
  riskFromMobileSetupQuery,
  setupStep,
  type GholaPerpsRiskInputs,
} from "@/lib/turnkey-perps-setup";
import type { PerpsMandateV1 } from "@ghola/perps-core";
import { hyperliquidApiWalletBindingMessage } from "@/lib/hyperliquid-agent-binding";

type SetupRecord = {
  version: 1;
  network: "mainnet" | "testnet";
  ownerAddress: string;
  agentAddress: string;
  sealingAddress: string;
  delegatedUserId?: string;
  policyIds?: string[];
  keyRef?: string;
  agentName: string;
  mandate?: PerpsMandateV1;
  mandateSignature?: `0x${string}`;
  active: boolean;
  noSubmitVerified: boolean;
};

type DelegatedKeyConfig = {
  configured: boolean;
  network: "mainnet" | "testnet";
  key_ref: string;
  public_key: string | null;
  no_submit_default: boolean;
  live_submit_enabled: boolean;
};

export function TurnkeyPerpsManager({
  network,
  market,
  referencePrice,
  onReady,
}: {
  network: "mainnet" | "testnet";
  market: string;
  referencePrice: string | null | undefined;
  onReady?: (risk: GholaPerpsRiskInputs) => void;
}) {
  const turnkey = usePerpsTurnkey();
  const [record, setRecord] = useState<SetupRecord | null>(null);
  const [risk, setRisk] = useState<GholaPerpsRiskInputs>({ ...DEFAULT_GHOLA_PERPS_RISK });
  const [eligible, setEligible] = useState(false);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const [acceptedCustody, setAcceptedCustody] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const stored = readSetupRecord(network);
    setRecord(stored);
    if (stored?.mandate) {
      const restored = riskFromMandate(stored.mandate);
      setRisk(restored);
      if (stored.active) onReadyRef.current?.(restored);
    } else if (!stored) {
      const imported = riskFromMobileSetupQuery(new URLSearchParams(window.location.search));
      if (imported) {
        setRisk(imported);
        setNotice("Mobile risk draft imported. Review every limit before signing.");
      }
    }
  }, [network]);

  const step = setupStep({
    turnkeyConfigured: turnkey.configured,
    authenticated: turnkey.authenticated,
    walletsReady: Boolean(record?.ownerAddress && record.agentAddress && record.sealingAddress),
    delegationReady: Boolean(record?.delegatedUserId && record.keyRef),
    mandateSigned: Boolean(record?.mandate && record.mandateSignature),
    active: record?.active === true,
  });
  const mainnetBlocked = network === "mainnet" && process.env.NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED !== "true";
  const checklist = useMemo(() => [
    { label: "User-held owner wallet", ready: Boolean(record?.ownerAddress) },
    { label: "Separate scoped agent wallet", ready: Boolean(record?.agentAddress) },
    { label: "Turnkey delegated-user policies", ready: Boolean(record?.delegatedUserId) },
    { label: "Owner-signed risk mandate", ready: Boolean(record?.mandateSignature) },
    { label: "Capital-free no-submit check", ready: record?.noSubmitVerified === true },
  ], [record]);

  const save = useCallback((next: SetupRecord) => {
    localStorage.setItem(storageKey(network), JSON.stringify(next));
    setRecord(next);
  }, [network]);

  async function run(label: string, action: () => Promise<void>) {
    setWorking(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setWorking(null);
    }
  }

  async function createWallets() {
    await run("wallets", async () => {
      const pair = await turnkey.ensureWalletPair();
      save({
        version: 1,
        network,
        ownerAddress: pair.owner.address.toLowerCase(),
        agentAddress: pair.agent.address.toLowerCase(),
        sealingAddress: pair.sealing.address,
        agentName: record?.agentName || "ghola-perps",
        active: false,
        noSubmitVerified: false,
      });
      setNotice("Owner and agent wallets created inside your Turnkey organization.");
    });
  }

  async function delegateWorker() {
    await run("delegation", async () => {
      if (!record) throw new Error("Create the Turnkey wallets first.");
      const response = await fetch("/api/perps/turnkey/delegated-key", { cache: "no-store" });
      const config = await response.json() as DelegatedKeyConfig;
      if (!response.ok || !config.configured || !config.public_key) {
        throw new Error("The local Turnkey worker key is not configured.");
      }
      if (config.network !== network) throw new Error(`The worker is configured for ${config.network}, not ${network}.`);
      const installed = await turnkey.installDelegation(config.public_key);
      save({
        ...record,
        delegatedUserId: installed.delegatedUserId,
        policyIds: installed.policyIds,
        keyRef: config.key_ref,
        active: false,
        noSubmitVerified: false,
      });
      setNotice("The worker can sign only from the agent wallet; owner signing remains blocked.");
    });
  }

  async function signMandate() {
    await run("mandate", async () => {
      if (!record?.delegatedUserId || !record.keyRef) throw new Error("Install delegated policies first.");
      if (!eligible || !acceptedRisk || !acceptedCustody) throw new Error("Complete all eligibility and risk acknowledgements.");
      const mandate = buildGholaPerpsMandate({
        mandateId: `mandate:${crypto.randomUUID()}`,
        network,
        ownerAddress: record.ownerAddress,
        agentAddress: record.agentAddress,
        risk,
        jurisdictionEligible: eligible,
        acceptedRisk,
      });
      const mandateSignature = await turnkey.signOwnerMandate(mandate);
      save({ ...record, mandate, mandateSignature, active: false, noSubmitVerified: false });
      setNotice("Risk limits signed by the owner wallet. No venue action was sent.");
    });
  }

  async function activate() {
    await run("activate", async () => {
      if (mainnetBlocked) throw new Error("Mainnet activation is disabled.");
      if (!record?.mandate || !record.mandateSignature || !record.keyRef) {
        throw new Error("Sign the risk mandate first.");
      }
      const pair = await turnkey.ensureWalletPair();
      await turnkey.configureHyperliquid({
        network,
        markets: [...record.mandate.allowed_markets],
        leverage: record.mandate.configured_leverage,
        marginMode: record.mandate.margin_mode,
        agentName: record.agentName,
      });
      const status = await getHyperliquidExecutionVaultStatus() as { account_commitment?: string };
      if (!status.account_commitment) throw new Error("Private account commitment is unavailable.");
      const sealed = await buildTurnkeyHyperliquidExecutionVaultBundle({
        accountCommitment: status.account_commitment,
        sealingWalletAddress: pair.sealing.address,
        signBytes: turnkey.signSealingBytes,
        credential: {
          signing_mode: "turnkey_delegated",
          turnkey_organization_id: pair.organizationId,
          turnkey_agent_key_ref: record.keyRef,
          owner_wallet_address: pair.owner.address,
          agent_wallet_address: pair.agent.address,
          hyperliquid_account_address: pair.owner.address,
          owner_mandate_signature: record.mandateSignature,
          perps_mandate: record.mandate,
          agent_name: record.agentName,
        },
      });
      const bindingMessage = hyperliquidApiWalletBindingMessage({
        accountCommitment: status.account_commitment,
        network,
        ownerAddress: pair.owner.address,
        agentAddress: pair.agent.address,
      });
      const bindingSignature = await turnkey.signAgentBinding(bindingMessage);
      await sealHyperliquidExecutionVault({
        encrypted_execution_vault: sealed.encrypted_execution_vault,
        credential_binding: {
          version: 1,
          network,
          owner_address: pair.owner.address.toLowerCase(),
          agent_address: pair.agent.address.toLowerCase(),
          signature: bindingSignature,
        },
      });
      await armHyperliquidExecutionAgent({
        execution_mode: "byo_api_key",
        market_allowlist: [...record.mandate.allowed_markets],
        max_notional_bucket: notionalBucket(risk.maxOrderUsd),
        max_order_count: risk.maxOrdersPerDay,
        kill_switch: false,
      });
      let noSubmitVerified = false;
      try {
        noSubmitVerified = await verifyNoSubmit({
          record,
          market,
          referencePrice,
          pair,
          signBytes: turnkey.signSealingBytes,
        });
      } catch {
        noSubmitVerified = false;
      }
      save({ ...record, active: true, noSubmitVerified });
      onReady?.(risk);
      setNotice(noSubmitVerified
        ? "Turnkey delegation, Hyperliquid testnet setup, sealed vault, and no-submit check passed."
        : "Agent armed. The no-submit worker check still needs a live local worker/configured market feed.");
    });
  }

  async function revoke() {
    if (!record?.delegatedUserId) return;
    if (!window.confirm("Kill the Ghola session, delete worker access, and replace the Hyperliquid API wallet?")) return;
    await run("revoke", async () => {
      await turnkey.revokeHyperliquid({
        network,
        agentName: record.agentName,
        delegatedUserId: record.delegatedUserId!,
      });
      await armHyperliquidExecutionAgent({
        execution_mode: "byo_api_key",
        market_allowlist: record.mandate?.allowed_markets || risk.markets,
        max_notional_bucket: notionalBucket(risk.maxOrderUsd),
        max_order_count: risk.maxOrdersPerDay,
        kill_switch: true,
      }).catch(() => null);
      save({ ...record, delegatedUserId: undefined, policyIds: [], active: false, noSubmitVerified: false });
      setNotice("Worker access deleted and the venue agent replaced. Owner funds remain at Hyperliquid.");
    });
  }

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-lg border border-[#29405a] bg-[#0a111a] p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[#112943] text-[#72c0ff]">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-white">Turnkey-native perps manager</p>
            <p className="mt-1 text-xs leading-5 text-[#93a2b5]">
              Owner wallet controls funds, leverage, and revocation. A separate agent wallet can place only risk-gated Hyperliquid orders.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {checklist.map((item) => (
            <div key={item.label} className="flex items-center gap-2 text-xs text-[#9da8b8]">
              <span className={item.ready ? "h-2 w-2 rounded-full bg-emerald-400" : "h-2 w-2 rounded-full bg-[#445064]"} />
              {item.label}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-[#303744] bg-[#090b0f] p-4 text-xs leading-5 text-[#9aa5b5]">
        Turnkey custodies wallet keys—not trading collateral. USDC deposited for perps is held on HyperCore under the owner address. USDT is not direct Hyperliquid perp collateral and must be converted externally. Deposits and withdrawals remain owner-only.
      </div>

      {!turnkey.configured && (
        <SetupAlert>Set the public Turnkey organization and Auth Proxy config IDs locally. No server-held wallet fallback is used.</SetupAlert>
      )}
      {mainnetBlocked && <SetupAlert>Mainnet is disabled. This surface can be exercised on Hyperliquid testnet without real funds.</SetupAlert>}

      {turnkey.configured && !turnkey.authenticated && (
        <ActionButton disabled={Boolean(working)} onClick={() => void run("login", turnkey.login)}>
          <KeyRound className="h-4 w-4" /> {working === "login" ? "Opening Turnkey…" : "Authenticate with Turnkey"}
        </ActionButton>
      )}
      {turnkey.authenticated && !record?.ownerAddress && (
        <ActionButton disabled={Boolean(working)} onClick={() => void createWallets()}>
          Create owner + agent wallets
        </ActionButton>
      )}
      {record?.ownerAddress && !record.delegatedUserId && (
        <ActionButton disabled={Boolean(working)} onClick={() => void delegateWorker()}>
          Install scoped worker policies
        </ActionButton>
      )}

      {record?.delegatedUserId && !record.mandateSignature && (
        <>
          <RiskEditor value={risk} onChange={setRisk} />
          <div className="space-y-2 rounded-lg border border-[#2a323e] bg-[#080a0d] p-4">
            <Check value={eligible} onChange={setEligible}>I attest I am eligible to use this venue where I am located.</Check>
            <Check value={acceptedRisk} onChange={setAcceptedRisk}>I accept leverage, liquidation, oracle, smart-contract, and stablecoin risks.</Check>
            <Check value={acceptedCustody} onChange={setAcceptedCustody}>I understand collateral sits at Hyperliquid, while Turnkey protects wallet keys.</Check>
          </div>
          <ActionButton disabled={Boolean(working)} onClick={() => void signMandate()}>
            {working === "mandate" ? "Signing…" : "Sign deterministic risk mandate"}
          </ActionButton>
        </>
      )}

      {record?.mandateSignature && !record.active && (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-[#9aa5b5]">
            This explicit owner action configures {record.mandate?.configured_leverage}× {record.mandate?.margin_mode} leverage and approves the agent on Hyperliquid {network}. It never deposits or withdraws funds.
          </p>
          <ActionButton disabled={Boolean(working) || mainnetBlocked} onClick={() => void activate()}>
            <Power className="h-4 w-4" /> {working === "activate" ? "Activating…" : `Approve agent and activate ${network}`}
          </ActionButton>
        </div>
      )}

      {record?.active && (
        <div className="grid gap-3">
          <div className="rounded-lg border border-[#285c49] bg-[#0d251c] px-4 py-3 text-xs leading-5 text-[#9be4bf]">
            Manager armed · {record.mandate?.configured_leverage}× {record.mandate?.margin_mode} · ${microToUsd(record.mandate?.max_order_notional_micro_usdc)} max/order · {record.noSubmitVerified ? "no-submit verified" : "no-submit pending"}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <a href={network === "testnet" ? "https://app.hyperliquid-testnet.xyz" : "https://app.hyperliquid.xyz"} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#344052] text-xs font-semibold text-[#b8c4d3] hover:border-[#52637a] hover:text-white">
              Owner funding <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button type="button" disabled={Boolean(working)} onClick={() => void revoke()} className="h-10 rounded-md border border-[#67363d] text-xs font-semibold text-[#ffb7bd] hover:bg-[#2a1115] disabled:opacity-50">
              {working === "revoke" ? "Revoking…" : "Kill & revoke"}
            </button>
          </div>
        </div>
      )}

      {(record?.ownerAddress || record?.agentAddress) && (
        <div className="grid gap-2 rounded-lg border border-[#252d38] bg-[#07090c] p-3 font-mono text-[10px] text-[#728095]">
          <span>Owner {shortAddress(record?.ownerAddress)}</span>
          <span>Agent {shortAddress(record?.agentAddress)}</span>
          <span>State {step.replaceAll("_", " ")}</span>
        </div>
      )}
      {error && <p role="alert" className="rounded-md border border-[#5d3036] bg-[#2a1115] px-3 py-2 text-xs leading-5 text-[#ffb7bd]">{error}</p>}
      {notice && <p role="status" className="rounded-md border border-[#285c49] bg-[#0d251c] px-3 py-2 text-xs leading-5 text-[#92e1bd]">{notice}</p>}
      <p className="text-[10px] leading-4 text-[#647083]">Not investment advice. Automated leverage can rapidly liquidate collateral. Availability depends on venue rules and your jurisdiction.</p>
    </div>
  );
}

async function verifyNoSubmit(input: {
  record: SetupRecord;
  market: string;
  referencePrice: string | null | undefined;
  pair: Awaited<ReturnType<ReturnType<typeof usePerpsTurnkey>["ensureWalletPair"]>>;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
}) {
  const reference = Number(input.referencePrice);
  if (!Number.isFinite(reference) || reference <= 0 || !input.record.mandate) return false;
  const workOrderCommitment = `connector_work_order_${crypto.randomUUID()}`;
  const sealed = await buildPrivateExecutionInstructionBundle({
    ownerWalletAddress: input.pair.sealing.address,
    previewCommitment: `perps_no_submit_${crypto.randomUUID()}`,
    workOrderCommitment,
    signBytes: input.signBytes,
    ttlMs: 60_000,
    order: {
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      market: input.market,
      side: "buy",
      base_size: "",
      quote_size: "10",
      limit_price: reference.toFixed(6),
      order_type: "limit",
      size_mode: "quote",
      tif: "Gtc",
      leverage: input.record.mandate.configured_leverage,
      margin_mode: input.record.mandate.margin_mode,
      max_slippage_bps: String(input.record.mandate.max_slippage_bps),
      protective_orders: { stop_loss: (reference * 0.96).toFixed(6) },
      agent_strategy_profile: "momentum_continuation",
      agent_entry_trigger: "preview_now",
      agent_exit_rule: "take_profit_stop",
      agent_time_horizon: "intraday",
      agent_route_priority: "best_price",
    },
  });
  const result = await verifyPrivateAccountConnectorNoSubmit({
    platform_class: "hyperliquid_style_market",
    work_order_commitment: workOrderCommitment,
    encrypted_execution_instruction_bundle: sealed.encrypted_execution_instruction_bundle,
  }) as { status?: string; checks?: { transaction_broadcast?: boolean } };
  return result.status === "verified_no_funds" && result.checks?.transaction_broadcast === false;
}

function RiskEditor({ value, onChange }: { value: GholaPerpsRiskInputs; onChange: (value: GholaPerpsRiskInputs) => void }) {
  const numberField = (key: keyof GholaPerpsRiskInputs, raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange({ ...value, [key]: parsed });
  };
  return (
    <details className="rounded-lg border border-[#2a323e] bg-[#080a0d] p-4" open>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-[#9fcfff]">Risk mandate</summary>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <RiskInput label="Markets" value={value.markets.join(", ")} onChange={(raw) => onChange({ ...value, markets: raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) })} />
        <label className="text-[10px] uppercase tracking-[0.1em] text-[#748195]">Margin mode<select value={value.marginMode} onChange={(event) => onChange({ ...value, marginMode: event.target.value as "cross" | "isolated" })} className="mt-1 h-9 w-full rounded-md border border-[#2b3441] bg-[#07090c] px-2 text-xs normal-case text-white"><option value="isolated">Isolated</option><option value="cross">Cross</option></select></label>
        <RiskInput label="Fixed leverage" value={String(value.leverage)} onChange={(raw) => numberField("leverage", raw)} suffix="×" />
        <RiskInput label="Max order" value={String(value.maxOrderUsd)} onChange={(raw) => numberField("maxOrderUsd", raw)} prefix="$" />
        <RiskInput label="Max gross" value={String(value.maxGrossUsd)} onChange={(raw) => numberField("maxGrossUsd", raw)} prefix="$" />
        <RiskInput label="Daily notional" value={String(value.maxDailyNotionalUsd)} onChange={(raw) => numberField("maxDailyNotionalUsd", raw)} prefix="$" />
        <RiskInput label="Daily loss stop" value={String(value.dailyLossUsd)} onChange={(raw) => numberField("dailyLossUsd", raw)} prefix="$" />
        <RiskInput label="Drawdown stop" value={String(value.maxDrawdownUsd)} onChange={(raw) => numberField("maxDrawdownUsd", raw)} prefix="$" />
        <RiskInput label="Max slippage" value={String(value.maxSlippageBps)} onChange={(raw) => numberField("maxSlippageBps", raw)} suffix="bps" />
        <RiskInput label="Required stop" value={String(value.stopLossBps)} onChange={(raw) => numberField("stopLossBps", raw)} suffix="bps" />
      </div>
    </details>
  );
}

function RiskInput({ label, value, onChange, prefix, suffix }: { label: string; value: string; onChange: (value: string) => void; prefix?: string; suffix?: string }) {
  return <label className="text-[10px] uppercase tracking-[0.1em] text-[#748195]">{label}<span className="mt-1 flex h-9 items-center rounded-md border border-[#2b3441] bg-[#07090c] px-2"><span className="text-[#657185]">{prefix}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs normal-case text-white outline-none" /><span className="normal-case text-[#657185]">{suffix}</span></span></label>;
}

function Check({ value, onChange, children }: { value: boolean; onChange: (value: boolean) => void; children: React.ReactNode }) {
  return <label className="flex items-start gap-2 text-xs leading-5 text-[#9da8b8]"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} className="mt-1" /><span>{children}</span></label>;
}

function ActionButton({ children, disabled, onClick }: { children: React.ReactNode; disabled: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#3da8ff] text-xs font-bold text-[#03101d] hover:bg-[#67baff] disabled:cursor-wait disabled:opacity-50">{children}</button>;
}

function SetupAlert({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-[#594a2b] bg-[#211a0d] px-3 py-2 text-xs leading-5 text-[#e7cd91]">{children}</p>;
}

function storageKey(network: string) {
  return `ghola:turnkey-perps:v1:${network}`;
}

function readSetupRecord(network: "mainnet" | "testnet"): SetupRecord | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(network)) || "null") as SetupRecord | null;
    return value?.version === 1 && value.network === network ? value : null;
  } catch {
    return null;
  }
}

function riskFromMandate(mandate: PerpsMandateV1): GholaPerpsRiskInputs {
  return {
    markets: [...mandate.allowed_markets],
    marginMode: mandate.margin_mode,
    leverage: mandate.configured_leverage,
    maxOrderUsd: mandate.max_order_notional_micro_usdc / 1_000_000,
    maxGrossUsd: mandate.max_gross_exposure_micro_usdc / 1_000_000,
    maxDailyNotionalUsd: mandate.max_daily_notional_micro_usdc / 1_000_000,
    dailyLossUsd: mandate.daily_loss_limit_micro_usdc / 1_000_000,
    maxDrawdownUsd: mandate.max_drawdown_micro_usdc / 1_000_000,
    maxDrawdownBps: mandate.max_drawdown_bps,
    maxSlippageBps: mandate.max_slippage_bps,
    stopLossBps: mandate.stop_loss_bps,
    maxOpenOrders: mandate.max_open_orders,
    maxOrdersPerDay: mandate.max_orders_per_day,
    expiresInHours: Math.max(1, Math.round((mandate.expires_at_ms - Date.now()) / 3_600_000)),
  };
}

function notionalBucket(value: number): "5" | "10" | "25" | "50" | "100" | "250" | "500" | "1000" {
  const buckets = [5, 10, 25, 50, 100, 250, 500, 1_000] as const;
  return String(buckets.find((bucket) => bucket >= value) || 1_000) as ReturnType<typeof notionalBucket>;
}

function shortAddress(value: string | undefined) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
}

function microToUsd(value: number | undefined) {
  return value == null ? "—" : (value / 1_000_000).toLocaleString();
}

function friendlyError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Perps setup failed.");
  if (raw.toLowerCase().includes("user rejected")) return "The owner declined the signing request.";
  return raw.replaceAll("_", " ");
}
