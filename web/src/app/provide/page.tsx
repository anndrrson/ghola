"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  createProviderKey,
  getComputeProviders,
  getComputeModels,
  getMyProvider,
} from "@/lib/thumper-api";
import { Server, Cpu, DollarSign, Copy, Check, ChevronRight, Zap } from "lucide-react";

interface ProviderStatus {
  id: string;
  display_name: string;
  status: string;
  models: string[];
  total_requests: number;
  total_earnings_micro: number;
}

interface NetworkStats {
  providerCount: number;
  modelCount: number;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute top-3 right-3 p-1.5 rounded-md bg-[#161822] hover:bg-[#1c1f2e] transition-colors cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-4 h-4 text-green-400" />
      ) : (
        <Copy className="w-4 h-4 text-[#8b95a8]" />
      )}
    </button>
  );
}

function LandingView({ stats }: { stats: NetworkStats }) {
  return (
    <div className="min-h-screen bg-[#08090d] pt-24 pb-16">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        {/* Hero */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 rounded-full bg-[#3da8ff]/10 px-4 py-1.5 text-sm text-[#3da8ff] mb-6">
            <Zap className="w-4 h-4" />
            GPU Compute Network
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-[#eef1f8] mb-4 tracking-tight">
            Earn with your GPU
          </h1>
          <p className="text-lg text-[#8b95a8] max-w-2xl mx-auto">
            Join the Ghola compute network. Share your GPU power, earn USDC.
            Anyone with Ollama running can start providing in under 2 minutes.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-16 max-w-md mx-auto">
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
            <Server className="w-6 h-6 text-[#3da8ff] mx-auto mb-2" />
            <p className="text-2xl font-bold text-[#eef1f8]">{stats.providerCount}</p>
            <p className="text-sm text-[#8b95a8]">Providers Online</p>
          </div>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center">
            <Cpu className="w-6 h-6 text-[#3da8ff] mx-auto mb-2" />
            <p className="text-2xl font-bold text-[#eef1f8]">{stats.modelCount}</p>
            <p className="text-sm text-[#8b95a8]">Models Available</p>
          </div>
        </div>

        {/* 3-step visual */}
        <div className="grid sm:grid-cols-3 gap-6 mb-16">
          {[
            { step: "1", title: "Sign Up", desc: "Create a free Ghola account in seconds" },
            { step: "2", title: "Install", desc: "Install Ollama and the Ghola CLI" },
            { step: "3", title: "Run", desc: "Paste one command and your GPU is live" },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center"
            >
              <div className="w-10 h-10 rounded-full bg-[#3da8ff]/10 text-[#3da8ff] font-bold text-lg flex items-center justify-center mx-auto mb-4">
                {item.step}
              </div>
              <h3 className="text-lg font-semibold text-[#eef1f8] mb-2">{item.title}</h3>
              <p className="text-sm text-[#8b95a8]">{item.desc}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="text-center">
          <Link
            href="/signin?redirect=/provide"
            className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-8 py-3 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
          >
            Get Started
            <ChevronRight className="w-5 h-5" />
          </Link>
          <p className="mt-4 text-sm text-[#8b95a8]">
            Already have an account?{" "}
            <Link href="/signin?redirect=/provide" className="text-[#3da8ff] hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function DashboardView() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<ProviderStatus | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const keyRes = await createProviderKey();
        setApiKey(keyRes.key);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create provider key");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Poll provider status
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const p = await getMyProvider();
        if (!cancelled && p) setProvider(p);
      } catch {
        // ignore
      }
    }
    poll();
    const interval = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d] pt-24 flex items-center justify-center">
        <div className="text-[#8b95a8]">Setting up your provider key...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#08090d] pt-24 flex items-center justify-center">
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 max-w-md">
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  const installCommand = `# 1. Install Ollama (if you haven't)
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.2

# 2. Install Ghola CLI
cargo install thumper-cli --git https://github.com/anndrrson/thumper

# 3. Start providing
thumper gpu-serve --token ${apiKey}`;

  const quickCommand = `thumper gpu-serve --token ${apiKey}`;

  return (
    <div className="min-h-screen bg-[#08090d] pt-24 pb-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-[#eef1f8] mb-2">GPU Provider Setup</h1>
        <p className="text-[#8b95a8] mb-8">
          Follow the steps below to start earning with your GPU.
        </p>

        {/* Status */}
        {provider && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`w-3 h-3 rounded-full ${
                    provider.status === "online"
                      ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.4)]"
                      : "bg-[#4a5568]"
                  }`}
                />
                <span className="text-[#eef1f8] font-medium">{provider.display_name}</span>
                <span className="text-sm text-[#8b95a8] capitalize">{provider.status}</span>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div className="text-[#8b95a8]">
                  <span className="text-[#eef1f8] font-medium">{provider.total_requests}</span> requests
                </div>
                <div className="text-[#8b95a8]">
                  <DollarSign className="w-4 h-4 inline" />
                  <span className="text-[#eef1f8] font-medium">
                    {(provider.total_earnings_micro / 1_000_000).toFixed(4)}
                  </span>
                </div>
              </div>
            </div>
            {provider.models.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {provider.models.map((m) => (
                  <span
                    key={m}
                    className="rounded-md bg-[#161822] px-2 py-1 text-xs text-[#8b95a8] font-mono"
                  >
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Full setup instructions */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 mb-6">
          <h2 className="text-lg font-semibold text-[#eef1f8] mb-4">Setup Instructions</h2>
          <div className="relative">
            <pre className="rounded-lg bg-[#08090d] border border-[#1e2a3a] p-4 pr-12 text-sm text-[#8b95a8] font-mono overflow-x-auto whitespace-pre">
              {installCommand}
            </pre>
            <CopyButton text={installCommand} />
          </div>
        </div>

        {/* Quick command */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 mb-6">
          <h2 className="text-lg font-semibold text-[#eef1f8] mb-2">Quick Start</h2>
          <p className="text-sm text-[#8b95a8] mb-4">
            Already have Ollama and the CLI? Just run:
          </p>
          <div className="relative">
            <pre className="rounded-lg bg-[#08090d] border border-[#1e2a3a] p-4 pr-12 text-sm text-[#3da8ff] font-mono overflow-x-auto whitespace-pre">
              {quickCommand}
            </pre>
            <CopyButton text={quickCommand} />
          </div>
        </div>

        {/* API Key info */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <h2 className="text-lg font-semibold text-[#eef1f8] mb-2">Your API Key</h2>
          <p className="text-sm text-[#8b95a8] mb-4">
            This key is scoped to compute operations only. Keep it safe — it won&apos;t be shown again.
          </p>
          <div className="relative">
            <code className="block rounded-lg bg-[#08090d] border border-[#1e2a3a] p-4 pr-12 text-sm text-[#eef1f8] font-mono break-all">
              {apiKey}
            </code>
            <CopyButton text={apiKey || ""} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProvidePage() {
  const { authenticated, loading } = useThumperAuth();
  const [stats, setStats] = useState<NetworkStats>({ providerCount: 0, modelCount: 0 });

  useEffect(() => {
    async function fetchStats() {
      try {
        const [providers, models] = await Promise.all([
          getComputeProviders().catch(() => ({ providers: [] })),
          getComputeModels().catch(() => ({ models: [] })),
        ]);
        setStats({
          providerCount: providers.providers?.length || 0,
          modelCount: models.models?.length || 0,
        });
      } catch {
        // ignore
      }
    }
    fetchStats();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d] pt-24 flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  if (authenticated) {
    return <DashboardView />;
  }

  return <LandingView stats={stats} />;
}
