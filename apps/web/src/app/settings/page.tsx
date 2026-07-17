"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, User, Cpu, BarChart3, CreditCard, Eye, EyeOff, Check, MessageCircle, Copy, ExternalLink, Unlink, Link2, Mail } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  getUserProfile,
  updateUserProfile,
  getUsage,
  getLlmConfig,
  updateLlmConfig,
  listProviders,
  createThumperCheckout,
  getThumperBillingStatus,
  updatePrivateAgentTradingFeeCap,
  createTelegramLinkCode,
  getTelegramLinkStatus,
  unlinkTelegram,
  getGmailAuthorizeUrl,
  getAccountsStatus,
} from "@/lib/thumper-api";
import type {
  ThumperUserProfile,
  ThumperUsageResponse,
  ThumperLlmConfigResponse,
  ThumperProviderInfo,
  ThumperBillingStatusResponse,
  ThumperTelegramLinkCode,
  ThumperTelegramStatus,
} from "@/lib/thumper-types";
import {
  PRIVATE_AGENT_ACTIVE_AGENT_LIMIT,
  PRIVATE_AGENT_STARTER_ACTIVE_AGENT_LIMIT,
  PRIVATE_AGENT_STARTER_INCLUDED_COMPUTE_SECONDS,
  PRIVATE_AGENT_STARTER_MONTHLY_PRICE_USD,
  PRIVATE_AGENT_STARTER_INCLUDED_NOTIONAL_USD,
  PRIVATE_AGENT_STARTER_OVERAGE_FEE_BPS,
  PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS,
  PRIVATE_AGENT_MONTHLY_PRICE_USD,
  PRIVATE_AGENT_INCLUDED_NOTIONAL_USD,
  PRIVATE_AGENT_OVERAGE_FEE_BPS,
  PRIVATE_AGENT_TRIAL_PACK_DAYS,
  PRIVATE_AGENT_TRIAL_PACK_INCLUDED_COMPUTE_SECONDS,
  PRIVATE_AGENT_TRIAL_PACK_PRICE_USD,
  privateAgentComputeHours,
  privateAgentIncludedComputeHours,
} from "@/lib/private-agent-pricing";
import { GholaLogo } from "@/components/GholaLogo";

type Tab = "profile" | "model" | "usage" | "accounts" | "telegram" | "plan";

export default function SettingsPage() {
  const { authenticated, loading, user, logout } = useThumperAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("profile");

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/signup");
    }
  }, [authenticated, loading, router]);

  // Auto-select tab from URL params (e.g. after OAuth redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlTab = params.get("tab");
    if (urlTab && ["profile", "model", "usage", "accounts", "telegram", "plan"].includes(urlTab)) {
      setTab(urlTab as Tab);
    }
  }, []);

  if (loading || !authenticated) return null;

  const tabs: { id: Tab; label: string; icon: typeof User }[] = [
    { id: "profile", label: "Profile", icon: User },
    { id: "model", label: "AI Model", icon: Cpu },
    { id: "usage", label: "Usage", icon: BarChart3 },
    { id: "accounts", label: "Accounts", icon: Link2 },
    { id: "telegram", label: "Telegram", icon: MessageCircle },
    { id: "plan", label: "Plan", icon: CreditCard },
  ];

  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <div className="mx-auto max-w-2xl px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => router.push("/trade")}
            className="p-1.5 rounded-lg text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822] transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <GholaLogo size={24} className="text-[#eef1f8]" />
          <h1 className="text-lg font-semibold text-[#eef1f8]">Settings</h1>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 rounded-lg bg-[#0f1117] p-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium transition-colors cursor-pointer ${
                  tab === t.id
                    ? "bg-[#161822] text-[#eef1f8]"
                    : "text-[#4a5568] hover:text-[#8b95a8]"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        {tab === "profile" && <ProfileTab userEmail={user?.email} onLogout={() => { logout(); router.push("/"); }} />}
        {tab === "model" && <ModelTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "accounts" && <AccountsTab />}
        {tab === "telegram" && <TelegramTab />}
        {tab === "plan" && <PlanTab />}
      </div>
    </div>
  );
}

function ProfileTab({ userEmail, onLogout }: { userEmail?: string; onLogout: () => void }) {
  const [profile, setProfile] = useState<ThumperUserProfile | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getUserProfile()
      .then((p) => {
        setProfile(p);
        setName(p.name || "");
        setPhone(p.phone || "");
        setTimezone(p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateUserProfile({ name, phone, timezone });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
        <div>
          <label className="block text-sm text-[#8b95a8] mb-1.5">Email</label>
          <input
            type="email"
            value={userEmail || profile?.email || ""}
            disabled
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#4a5568]"
          />
        </div>
        <div>
          <label className="block text-sm text-[#8b95a8] mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff] transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm text-[#8b95a8] mb-1.5">Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 (555) 123-4567"
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm text-[#8b95a8] mb-1.5">Timezone</label>
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff] transition-colors"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
        >
          {saved ? (
            <>
              <Check className="h-4 w-4" />
              Saved
            </>
          ) : (
            saving ? "Saving..." : "Save changes"
          )}
        </button>
      </div>

      <button
        onClick={onLogout}
        className="w-full rounded-lg border border-[#1e2a3a] px-4 py-2.5 text-sm text-[#4a5568] hover:text-red-400 hover:border-red-400/30 transition-colors cursor-pointer"
      >
        Sign out
      </button>
    </div>
  );
}

function ModelTab() {
  const [config, setConfig] = useState<ThumperLlmConfigResponse | null>(null);
  const [providers, setProviders] = useState<ThumperProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([getLlmConfig(), listProviders()])
      .then(([cfg, provs]) => {
        setConfig(cfg);
        setProviders(provs);
        setProvider(cfg.provider || "");
        setModel(cfg.model || "");
        setBaseUrl(cfg.base_url || "");
      })
      .catch(() => {});
  }, []);

  const selectedProvider = providers.find((p) => p.id === provider);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data: { provider: string; model: string; api_key?: string; base_url?: string } = {
        provider,
        model,
      };
      if (apiKey) data.api_key = apiKey;
      if (baseUrl) data.base_url = baseUrl;
      await updateLlmConfig(data);
      setSaved(true);
      setApiKey("");
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[#eef1f8] mb-1">Bring Your Own Model</h3>
        <p className="text-xs text-[#4a5568]">
          Use your own API key to choose which AI model powers ghola
        </p>
      </div>

      <div>
        <label className="block text-sm text-[#8b95a8] mb-1.5">Provider</label>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel("");
          }}
          className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff] transition-colors cursor-pointer"
        >
          <option value="">Select provider</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {selectedProvider && (
        <div>
          <label className="block text-sm text-[#8b95a8] mb-1.5">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff] transition-colors cursor-pointer"
          >
            <option value="">Select model</option>
            {selectedProvider.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm text-[#8b95a8] mb-1.5">API Key</label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.has_api_key ? "Key saved — enter new to replace" : "Your API key"}
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 pr-10 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#4a5568] hover:text-[#8b95a8] cursor-pointer"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-[#4a5568] hover:text-[#8b95a8] transition-colors cursor-pointer"
      >
        {showAdvanced ? "Hide" : "Show"} advanced options
      </button>

      {showAdvanced && (
        <div>
          <label className="block text-sm text-[#8b95a8] mb-1.5">Base URL (optional)</label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
          />
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !provider || !model}
        className="flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
      >
        {saved ? (
          <>
            <Check className="h-4 w-4" />
            Saved
          </>
        ) : (
          saving ? "Saving..." : "Save model config"
        )}
      </button>
    </div>
  );
}

function UsageTab() {
  const [usage, setUsage] = useState<ThumperUsageResponse | null>(null);

  useEffect(() => {
    getUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  if (!usage) {
    return (
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center text-sm text-[#4a5568]">
        Loading usage data...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <UsageMeter
        label="Phone calls"
        used={usage.calls_used}
        limit={usage.calls_limit}
      />
      <UsageMeter
        label="Emails"
        used={usage.emails_used}
        limit={usage.emails_limit}
      />
      <p className="text-xs text-[#4a5568] text-center">
        Usage resets {new Date(usage.period_end).toLocaleDateString()}
      </p>
    </div>
  );
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm font-medium text-[#eef1f8]">{label}</span>
        <span className="text-sm text-[#8b95a8]">
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 rounded-full bg-[#161822] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            pct > 90 ? "bg-red-400" : pct > 70 ? "bg-yellow-400" : "bg-[#3da8ff]"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function AccountsTab() {
  const [accounts, setAccounts] = useState<{ provider: string; connected: boolean; connected_at: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    getAccountsStatus()
      .then(setAccounts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const gmailAccount = accounts.find((a) => a.provider === "gmail");

  const handleConnectGmail = async () => {
    setConnecting(true);
    try {
      const { authorize_url } = await getGmailAuthorizeUrl();
      window.location.href = authorize_url;
    } catch {
      setConnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center text-sm text-[#4a5568]">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#3da8ff]/10">
            <Mail className="h-5 w-5 text-[#3da8ff]" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-[#eef1f8]">Gmail</h3>
            <p className="text-xs text-[#4a5568]">
              {gmailAccount
                ? `Connected ${gmailAccount.connected_at ? new Date(gmailAccount.connected_at).toLocaleDateString() : ""}`
                : "Connect your Gmail to send emails through ghola"}
            </p>
          </div>
          {gmailAccount && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <Check className="h-3 w-3" />
              Connected
            </span>
          )}
        </div>

        {!gmailAccount ? (
          <button
            onClick={handleConnectGmail}
            disabled={connecting}
            className="flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <Link2 className="h-4 w-4" />
            {connecting ? "Redirecting..." : "Connect Gmail"}
          </button>
        ) : (
          <p className="text-xs text-[#8b95a8]">
            ghola can send emails on your behalf when you approve them in chat.
          </p>
        )}
      </div>
    </div>
  );
}

function TelegramTab() {
  const [status, setStatus] = useState<ThumperTelegramStatus | null>(null);
  const [linkCode, setLinkCode] = useState<ThumperTelegramLinkCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    getTelegramLinkStatus()
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Countdown timer for link code expiry
  useEffect(() => {
    if (!linkCode) return;
    const expires = new Date(linkCode.expires_at).getTime();
    const update = () => {
      const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) setLinkCode(null);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [linkCode]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const code = await createTelegramLinkCode();
      setLinkCode(code);
    } catch {
      // silent
    }
    setGenerating(false);
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await unlinkTelegram();
      setStatus({ linked: false });
      setLinkCode(null);
    } catch {
      // silent
    }
    setUnlinking(false);
  };

  const handleCopy = () => {
    if (linkCode) {
      navigator.clipboard.writeText(linkCode.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center text-sm text-[#4a5568]">
        Loading...
      </div>
    );
  }

  if (status?.linked) {
    return (
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#3da8ff]/10">
            <MessageCircle className="h-5 w-5 text-[#3da8ff]" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-[#eef1f8]">Telegram Connected</h3>
            <p className="text-xs text-[#8b95a8]">
              {status.telegram_username ? `@${status.telegram_username}` : "Linked"} — {status.linked_at ? new Date(status.linked_at).toLocaleDateString() : ""}
            </p>
          </div>
        </div>
        <p className="text-xs text-[#4a5568]">
          Message @GholaBot on Telegram to chat with your AI assistant. Your conversations sync with your ghola account.
        </p>
        <button
          onClick={handleUnlink}
          disabled={unlinking}
          className="flex items-center gap-2 rounded-lg border border-[#1e2a3a] px-4 py-2 text-sm text-[#4a5568] hover:text-red-400 hover:border-red-400/30 disabled:opacity-50 transition-colors cursor-pointer"
        >
          <Unlink className="h-3.5 w-3.5" />
          {unlinking ? "Unlinking..." : "Disconnect Telegram"}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[#eef1f8] mb-1">Connect Telegram</h3>
        <p className="text-xs text-[#4a5568]">
          Chat with ghola directly from Telegram — make calls, send emails, and get things done without opening a browser.
        </p>
      </div>

      {!linkCode ? (
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
        >
          <MessageCircle className="h-4 w-4" />
          {generating ? "Generating..." : "Connect Telegram"}
        </button>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-[#1e2a3a] bg-[#161822] p-4 text-center space-y-3">
            <p className="text-xs text-[#8b95a8]">Your linking code</p>
            <div className="flex items-center justify-center gap-3">
              <span className="font-mono text-3xl font-bold tracking-[0.3em] text-[#eef1f8]">
                {linkCode.code}
              </span>
              <button
                onClick={handleCopy}
                className="p-1.5 rounded-md text-[#4a5568] hover:text-[#eef1f8] hover:bg-[#1e2a3a] transition-colors cursor-pointer"
                title="Copy code"
              >
                {copied ? <Check className="h-4 w-4 text-[#3da8ff]" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-[#4a5568]">
              Expires in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
            </p>
          </div>

          <a
            href={`https://t.me/${linkCode.bot_username}?start=${linkCode.code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <ExternalLink className="h-4 w-4" />
            Open in Telegram
          </a>

          <p className="text-xs text-[#4a5568] text-center">
            Or send <span className="font-mono text-[#8b95a8]">/link {linkCode.code}</span> to @GholaBot in Telegram
          </p>
        </div>
      )}
    </div>
  );
}

function PlanTab() {
  const [billing, setBilling] = useState<ThumperBillingStatusResponse | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [savingCap, setSavingCap] = useState(false);
  const [capUsd, setCapUsd] = useState("");

  useEffect(() => {
    getThumperBillingStatus()
      .then((status) => {
        setBilling(status);
        if (status.private_agent_trading) {
          setCapUsd(String(status.private_agent_trading.monthly_fee_cap_micro_usd / 1_000_000));
        }
      })
      .catch(() => {});
  }, []);

  const handleSaveCap = async () => {
    const nextUsd = Number(capUsd);
    if (!Number.isFinite(nextUsd) || nextUsd < 0 || nextUsd > 10_000) return;
    setSavingCap(true);
    try {
      const private_agent_trading = await updatePrivateAgentTradingFeeCap(Math.round(nextUsd * 1_000_000));
      setBilling((current) => current ? { ...current, private_agent_trading } : current);
    } finally {
      setSavingCap(false);
    }
  };

  const handleUpgrade = async (tier: string) => {
    setUpgrading(tier);
    try {
      const { checkout_url } = await createThumperCheckout(tier);
      window.location.href = checkout_url;
    } catch {
      setUpgrading(null);
    }
  };

  const plans: Array<{
    id: "free" | "pro" | "trial_pack" | "starter" | "private_agent" | "unlimited" | "enterprise";
    name: string;
    price: string;
    period: string;
    features: string[];
    featured?: boolean;
    badge?: string;
    computeSeconds?: number;
  }> = [
    {
      id: "free",
      name: "Free",
      price: "$0",
      period: "/forever",
      features: ["Explore Ghola", "Simulations and read-only flows", "No live secure-worker execution"],
    },
    {
      id: "pro",
      name: "Pro",
      price: "$9.99",
      period: "/month",
      features: ["30 calls/month", "50 emails/month", "BYOM support", "Priority responses"],
    },
    {
      id: "trial_pack",
      name: "Trial Pack",
      price: `$${PRIVATE_AGENT_TRIAL_PACK_PRICE_USD}`,
      period: " once",
      badge: "Proof",
      computeSeconds: PRIVATE_AGENT_TRIAL_PACK_INCLUDED_COMPUTE_SECONDS,
      features: [
        "Try real secure-worker execution",
        `${privateAgentComputeHours(PRIVATE_AGENT_TRIAL_PACK_INCLUDED_COMPUTE_SECONDS)} private compute hours`,
        `Expires after ${PRIVATE_AGENT_TRIAL_PACK_DAYS} days`,
        "No profit share",
      ],
    },
    {
      id: "starter",
      name: "Starter Agent",
      price: `$${PRIVATE_AGENT_STARTER_MONTHLY_PRICE_USD}`,
      period: "/month",
      featured: true,
      badge: "Best start",
      computeSeconds: PRIVATE_AGENT_STARTER_INCLUDED_COMPUTE_SECONDS,
      features: [
        "Live secure worker",
        `${privateAgentComputeHours(PRIVATE_AGENT_STARTER_INCLUDED_COMPUTE_SECONDS)} private compute hours/month`,
        `${PRIVATE_AGENT_STARTER_ACTIVE_AGENT_LIMIT} active secure agent`,
        "Small capped live actions",
        `$${PRIVATE_AGENT_STARTER_INCLUDED_NOTIONAL_USD.toLocaleString()} filled notional/month included`,
        `${PRIVATE_AGENT_STARTER_OVERAGE_FEE_BPS} bps overage after included volume`,
        "No charge for rejected or unfilled orders",
      ],
    },
    {
      id: "private_agent",
      name: "Private Agent",
      price: `$${PRIVATE_AGENT_MONTHLY_PRICE_USD}`,
      period: "/month",
      badge: "Scale",
      computeSeconds: PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS,
      features: [
        "Live secure worker",
        `${privateAgentIncludedComputeHours()} private compute hours/month`,
        `${PRIVATE_AGENT_ACTIVE_AGENT_LIMIT} active secure agent`,
        "Higher live trading caps",
        `$${PRIVATE_AGENT_INCLUDED_NOTIONAL_USD.toLocaleString()} filled notional/month included`,
        `${PRIVATE_AGENT_OVERAGE_FEE_BPS} bps overage after included volume`,
        "Compute stops when allowance runs out",
        "No charge for rejected or unfilled orders",
      ],
    },
    {
      id: "unlimited",
      name: "Unlimited",
      price: "$29.99",
      period: "/month",
      features: [
        "Unlimited calls",
        "Unlimited emails",
        "BYOM support",
        "API access (100k/mo)",
        "Private-agent compute sold separately",
      ],
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: "Custom",
      period: "",
      features: ["Unlimited everything", "Unlimited API calls", "Custom SLA", "Priority support", "Dedicated account manager"],
    },
  ];

  return (
    <div className="space-y-4">
      {billing?.private_agent_compute && (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-[#eef1f8]">Private compute</h3>
              <p className="mt-1 text-xs text-[#8b95a8]">
                {Math.floor(billing.private_agent_compute.remaining_seconds / 3600)} of{" "}
                {Math.floor(billing.private_agent_compute.included_seconds / 3600)} hours left this period
              </p>
            </div>
            <p className="text-xs text-[#4a5568]">
              {billing.private_agent_compute.active_agent_count}/{billing.private_agent_compute.active_agent_limit} active
            </p>
          </div>
        </div>
      )}
      {billing?.private_agent_trading && (
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-[#eef1f8]">Live trading usage</h3>
              <p className="mt-1 text-xs text-[#8b95a8]">
                ${(billing.private_agent_trading.filled_notional_micro_usd / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {" of $"}
                {(billing.private_agent_trading.included_notional_micro_usd / 1_000_000).toLocaleString()}
                {" included filled notional"}
              </p>
              <p className="mt-1 text-xs text-[#4a5568]">
                {(billing.private_agent_trading.overage_fee_bps / 100).toFixed(2)}% overage · ${(billing.private_agent_trading.accrued_fee_micro_usd / 1_000_000).toFixed(2)} accrued
              </p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] ${
              billing.private_agent_trading.live_trading_allowed
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-amber-500/10 text-amber-300"
            }`}>
              {billing.private_agent_trading.live_trading_allowed ? "Live enabled" : "Limit reached"}
            </span>
          </div>
          {billing.private_agent_trading.overage_fee_bps > 0 && (
            <div className="mt-4 flex items-end gap-2">
              <label className="flex-1 text-xs text-[#8b95a8]">
                Monthly overage ceiling
                <div className="mt-1 flex items-center rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3">
                  <span className="text-[#4a5568]">$</span>
                  <input
                    value={capUsd}
                    onChange={(event) => setCapUsd(event.target.value)}
                    inputMode="decimal"
                    className="w-full bg-transparent px-2 py-2 text-[#eef1f8] outline-none"
                    aria-label="Monthly trading overage ceiling in dollars"
                  />
                </div>
              </label>
              <button
                onClick={handleSaveCap}
                disabled={savingCap}
                className="rounded-lg border border-[#2a3a50] px-4 py-2 text-xs text-[#eef1f8] disabled:opacity-50"
              >
                {savingCap ? "Saving…" : "Save ceiling"}
              </button>
            </div>
          )}
          <p className="mt-3 text-[11px] text-[#4a5568]">
            Only venue-confirmed fills count. Rejected, cancelled, and completely unfilled orders cost $0 in usage fees.
            {billing.private_agent_trading.overage_fee_bps > 0 ? " Set the ceiling to $0 to disable overages after the included allowance." : ""}
          </p>
        </div>
      )}
      {plans.map((plan) => {
        const isCurrent = billing?.tier === plan.id;
        return (
          <div
            key={plan.id}
            className={`rounded-xl border p-5 ${
              isCurrent
                ? "border-[#3da8ff] bg-[#3da8ff]/5"
                : plan.featured
                  ? "border-[#2f7fd0] bg-[#0f1520]"
                : "border-[#1e2a3a] bg-[#0f1117]"
            }`}
          >
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <h3 className="text-sm font-medium text-[#eef1f8]">
                  {plan.name}
                  {(plan.featured || plan.badge) && !isCurrent && (
                    <span className="ml-2 text-[10px] font-medium text-[#3da8ff] bg-[#3da8ff]/10 px-2 py-0.5 rounded-full">
                      {plan.badge ?? "Live"}
                    </span>
                  )}
                  {isCurrent && (
                    <span className="ml-2 text-[10px] font-medium text-[#3da8ff] bg-[#3da8ff]/10 px-2 py-0.5 rounded-full">
                      Current
                    </span>
                  )}
                </h3>
              </div>
              <p className="text-lg font-medium text-[#eef1f8]">
                {plan.price}
                <span className="text-xs text-[#4a5568]">{plan.period}</span>
              </p>
            </div>
            <ul className="space-y-1.5 mb-3">
              {plan.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-xs text-[#8b95a8]">
                  <Check className="h-3 w-3 text-[#3da8ff] shrink-0" />
                  {f}
                </li>
              ))}
              {plan.computeSeconds && (
                <li className="flex items-center gap-2 text-xs text-[#4a5568]">
                  <Check className="h-3 w-3 text-[#3da8ff] shrink-0" />
                  Includes {plan.computeSeconds.toLocaleString()} metered agent seconds
                </li>
              )}
            </ul>
            {!isCurrent && plan.id !== "free" && plan.id !== "enterprise" && (
              <button
                onClick={() => handleUpgrade(plan.id)}
                disabled={upgrading === plan.id}
                className="w-full rounded-lg bg-[#3da8ff] py-2 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
              >
                {upgrading === plan.id
                  ? "Redirecting..."
                  : plan.id === "trial_pack"
                    ? "Try secure worker"
                    : `Upgrade to ${plan.name}`}
              </button>
            )}
            {!isCurrent && plan.id === "enterprise" && (
              <a
                href="mailto:hello@ghola.xyz"
                className="block w-full rounded-lg border border-[#1e2a3a] py-2 text-center text-xs font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors"
              >
                Contact sales
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
