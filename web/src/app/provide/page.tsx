"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { createProviderKey, getMyProvider } from "@/lib/thumper-api";
import {
  Download,
  Terminal,
  Cpu,
  DollarSign,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  Monitor,
  HardDrive,
  Wifi,
  Shield,
  Clock,
  Layers,
  Zap,
} from "lucide-react";

// ── Shared components ──────────────────────────────────────────────

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

function CodeBlock({
  code,
  highlight,
}: {
  code: string;
  highlight?: boolean;
}) {
  return (
    <div className="relative">
      <pre
        className={`rounded-lg bg-[#08090d] border border-[#1e2a3a] p-4 pr-12 text-sm font-mono overflow-x-auto whitespace-pre ${
          highlight ? "text-[#3da8ff] shadow-[0_0_20px_rgba(61,168,255,0.08)]" : "text-[#8b95a8]"
        }`}
      >
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

function FAQItem({
  question,
  answer,
}: {
  question: string;
  answer: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-[#1e2a3a] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-4 text-left cursor-pointer"
      >
        <span className="text-[#eef1f8] font-medium">{question}</span>
        <ChevronDown
          className={`w-5 h-5 text-[#8b95a8] transition-transform flex-shrink-0 ml-4 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <p className="text-sm text-[#8b95a8] pb-4 leading-relaxed">
          {answer}
        </p>
      )}
    </div>
  );
}

// ── Landing View (unauthenticated) ─────────────────────────────────

function LandingView() {
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!heroRef.current) return;
      const rect = heroRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 20;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * 20;
      heroRef.current.style.setProperty("--parallax-x", `${x}px`);
      heroRef.current.style.setProperty("--parallax-y", `${y}px`);
    }
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <div className="min-h-screen bg-[#08090d] pt-24 pb-16">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        {/* Hero */}
        <section
          ref={heroRef}
          className="relative text-center pb-20 overflow-hidden"
          style={
            {
              "--parallax-x": "0px",
              "--parallax-y": "0px",
            } as React.CSSProperties
          }
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle, #1e2a3a 1px, transparent 1px)",
              backgroundSize: "32px 32px",
              transform: "translate(var(--parallax-x), var(--parallax-y))",
              transition: "transform 0.15s ease-out",
            }}
          />
          <div className="relative">
            <div className="inline-flex items-center gap-2 rounded-full bg-[#3da8ff]/10 px-4 py-1.5 text-sm text-[#3da8ff] mb-6">
              <Zap className="w-4 h-4" />
              Decentralized AI Inference
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-[#eef1f8] mb-5 tracking-tight">
              Turn your idle GPU into income
            </h1>
            <p className="text-lg text-[#8b95a8] max-w-2xl mx-auto leading-relaxed">
              Ghola users pay for AI chat. Your GPU serves the inference. You earn
              USDC for every request. No middlemen, no cloud bills&mdash;just your
              hardware working for you.
            </p>
            <div className="mt-10 max-w-lg mx-auto">
              <div className="relative rounded-xl bg-[#0f1117] border border-[#3da8ff]/20 p-6 shadow-[0_0_30px_rgba(61,168,255,0.06)]">
                <p className="text-xs text-[#4a5568] uppercase tracking-wider mb-3 font-medium">2 commands. That&apos;s it.</p>
                <div className="space-y-2">
                  <div className="relative">
                    <pre className="rounded-lg bg-[#08090d] border border-[#1e2a3a] p-3 text-sm font-mono text-[#3da8ff] overflow-x-auto">
                      <span className="text-[#4a5568]">$ </span>curl -fsSL https://ghola.xyz/install.sh | sh
                    </pre>
                    <CopyButton text="curl -fsSL https://ghola.xyz/install.sh | sh" />
                  </div>
                  <div className="relative">
                    <pre className="rounded-lg bg-[#08090d] border border-[#1e2a3a] p-3 text-sm font-mono text-[#3da8ff] overflow-x-auto">
                      <span className="text-[#4a5568]">$ </span>ghola up
                    </pre>
                    <CopyButton text="ghola up" />
                  </div>
                </div>
                <p className="text-xs text-[#4a5568] mt-3 leading-relaxed">
                  Installs the CLI, checks for Ollama, auto-pulls a model, signs you up, and starts earning.
                </p>
              </div>
            </div>
            <div className="mt-8">
              <Link
                href="/signin?redirect=/provide"
                className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-8 py-3 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Start Earning
                <ChevronRight className="w-5 h-5" />
              </Link>
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="py-20 border-t border-[#1e2a3a]">
          <h2 className="text-2xl font-bold text-[#eef1f8] text-center mb-10">
            How it works
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: Download,
                title: "Install Ollama",
                desc: "Free, open-source local AI server. One command install on Linux or macOS.",
              },
              {
                icon: Layers,
                title: "Pull a model",
                desc: "Download a model like Llama 3.2. It runs entirely on your GPU.",
              },
              {
                icon: Terminal,
                title: "Run one command",
                desc: "Start the Ghola provider CLI. It auto-connects to the network.",
              },
              {
                icon: DollarSign,
                title: "Get paid",
                desc: "Earn USDC for every inference request your GPU serves.",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#2a3a50] transition-colors"
              >
                <div className="w-10 h-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
                  <item.icon className="w-5 h-5 text-[#3da8ff]" />
                </div>
                <h3 className="text-base font-semibold text-[#eef1f8] mb-2">
                  {item.title}
                </h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Earnings */}
        <section className="py-20 border-t border-[#1e2a3a]">
          <h2 className="text-2xl font-bold text-[#eef1f8] text-center mb-10">
            Provider economics
          </h2>
          <div className="grid sm:grid-cols-3 gap-5">
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center hover:border-[#2a3a50] transition-colors">
              <p className="text-3xl font-bold text-[#eef1f8] mb-1">85%</p>
              <p className="text-sm text-[#8b95a8]">
                Revenue goes to you. Ghola takes a 15% platform fee.
              </p>
            </div>
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center hover:border-[#2a3a50] transition-colors">
              <p className="text-sm font-mono text-[#3da8ff] mb-1">
                per 1K tokens
              </p>
              <p className="text-sm text-[#8b95a8]">
                <span className="text-[#eef1f8]">Input:</span> 10 &micro;USDC
                &nbsp;&middot;&nbsp;{" "}
                <span className="text-[#eef1f8]">Output:</span> 30 &micro;USDC
              </p>
              <p className="text-xs text-[#4a5568] mt-2">
                Early network rates &mdash; scale with demand
              </p>
            </div>
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center hover:border-[#2a3a50] transition-colors">
              <p className="text-3xl font-bold text-[#eef1f8] mb-1">$0</p>
              <p className="text-sm text-[#8b95a8]">
                No signup fees. No monthly cost. Earn from day one.
              </p>
            </div>
          </div>
        </section>

        {/* Requirements */}
        <section className="py-20 border-t border-[#1e2a3a]">
          <h2 className="text-2xl font-bold text-[#eef1f8] text-center mb-10">
            Requirements
          </h2>
          <div className="grid sm:grid-cols-2 gap-5 max-w-2xl mx-auto">
            {[
              {
                icon: Monitor,
                label: "Operating System",
                value: "Linux or macOS",
              },
              {
                icon: HardDrive,
                label: "GPU",
                value: "NVIDIA with 8 GB+ VRAM, or Apple Silicon",
              },
              {
                icon: Cpu,
                label: "Software",
                value: "Ollama (free) + Ghola CLI (free)",
              },
              {
                icon: Wifi,
                label: "Internet",
                value: "Stable connection \u2014 no specific bandwidth required",
              },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-start gap-4 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#2a3a50] transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <item.icon className="w-4 h-4 text-[#3da8ff]" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[#eef1f8]">
                    {item.label}
                  </p>
                  <p className="text-sm text-[#8b95a8]">{item.value}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="py-20 border-t border-[#1e2a3a]">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-[#eef1f8] text-center mb-10">
              FAQ
            </h2>
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] px-6 hover:border-[#2a3a50] transition-colors">
              <FAQItem
                question="Is my data safe?"
                answer="Yes. All inference runs locally on your machine. User prompts are encrypted in transit and never stored on your hardware. You process the request, return the result, and the data is gone."
              />
              <FAQItem
                question="How do I get paid?"
                answer="Earnings accrue in USDC and are tracked in your provider dashboard. Withdraw anytime to your wallet address."
              />
              <FAQItem
                question="Can I stop anytime?"
                answer="Yes. Just stop the CLI process. There are no commitments, no lock-in periods, and no penalties for going offline."
              />
              <FAQItem
                question="What models are supported?"
                answer="Any model that Ollama supports: Llama, Mistral, Gemma, Phi, Qwen, and many more. The CLI auto-discovers all models you have pulled locally."
              />
            </div>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="py-20 border-t border-[#1e2a3a]">
          <div className="text-center">
            <Link
              href="/signin?redirect=/provide"
              className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-8 py-3 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
            >
              Start Earning
              <ChevronRight className="w-5 h-5" />
            </Link>
            <p className="mt-4 text-sm text-[#8b95a8]">
              Already have an account?{" "}
              <Link
                href="/signin?redirect=/provide"
                className="text-[#3da8ff] hover:text-[#eef1f8] transition-colors"
              >
                Sign in
              </Link>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Dashboard View (authenticated) ─────────────────────────────────

interface ProviderStatus {
  id: string;
  display_name: string;
  status: string;
  models: string[];
  total_requests: number;
  total_earnings_micro: number;
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
        setError(
          err instanceof Error ? err.message : "Failed to create provider key"
        );
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
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

  const installCommand = "curl -fsSL https://ghola.xyz/install.sh | sh";
  const providerCommand = "ghola up";

  return (
    <div className="min-h-screen bg-[#08090d] pt-24 pb-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-bold text-[#eef1f8] mb-2">
          GPU Provider Setup
        </h1>
        <p className="text-[#8b95a8] mb-8">
          Follow these four steps to start earning with your GPU.
        </p>

        {/* Provider Status (if already registered) */}
        {provider && (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 mb-8 hover:border-[#2a3a50] transition-colors">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <div
                  className={`w-3 h-3 rounded-full ${
                    provider.status === "online"
                      ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.4)] animate-pulse"
                      : "bg-[#4a5568]"
                  }`}
                />
                <span className="text-[#eef1f8] font-medium">
                  {provider.display_name}
                </span>
                <span className="text-sm text-[#8b95a8] capitalize">
                  {provider.status}
                </span>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div className="text-[#8b95a8]">
                  <span className="text-[#eef1f8] font-medium">
                    {provider.total_requests}
                  </span>{" "}
                  requests
                </div>
                <div className="text-[#8b95a8]">
                  <DollarSign className="w-4 h-4 inline" />
                  <span className="text-[#eef1f8] font-medium">
                    {(provider.total_earnings_micro / 1_000_000).toFixed(4)}
                  </span>{" "}
                  USDC
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

        {/* Step 1: Install Ollama */}
        <StepCard
          step={1}
          title="Install Ollama"
          description="Ollama is a free, open-source tool that runs AI models locally on your machine."
        >
          <p className="text-sm text-[#8b95a8] mb-3">Linux / macOS:</p>
          <CodeBlock code="curl -fsSL https://ollama.ai/install.sh | sh" />
          <p className="text-xs text-[#4a5568] mt-3">
            Or download manually from{" "}
            <a
              href="https://ollama.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#3da8ff] hover:underline"
            >
              ollama.ai
            </a>
          </p>
        </StepCard>

        {/* Step 2: Pull a model */}
        <StepCard
          step={2}
          title="Pull a model"
          description="Download at least one model. This will use your GPU's VRAM."
        >
          <CodeBlock code="ollama pull llama3.2" />
          <p className="text-xs text-[#4a5568] mt-3">
            You can pull multiple models &mdash; the CLI auto-discovers all of
            them. Try <code className="text-[#8b95a8]">mistral</code>,{" "}
            <code className="text-[#8b95a8]">gemma2</code>, or{" "}
            <code className="text-[#8b95a8]">phi3</code>.
          </p>
        </StepCard>

        {/* Step 3: Install Ghola CLI */}
        <StepCard
          step={3}
          title="Install Ghola CLI"
          description="The CLI connects your machine to the Ghola network."
        >
          <CodeBlock code={installCommand} />
          <p className="text-xs text-[#4a5568] mt-3">
            Downloads a pre-built binary, or falls back to building from source
            with Rust.
          </p>
        </StepCard>

        {/* Step 4: Start providing */}
        <StepCard
          step={4}
          title="Start providing"
          description="One command does everything: checks Ollama, pulls a model if needed, authenticates you, and connects to the network."
          last
        >
          <CodeBlock code={providerCommand} highlight />
          <div className="mt-4 rounded-lg bg-[#3da8ff]/5 border border-[#3da8ff]/10 p-3">
            <p className="text-xs text-[#8b95a8]">
              Already logged in from this browser &mdash; <code className="text-[#3da8ff]">ghola up</code> will detect your auth automatically.
            </p>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-[#161822] p-3">
              <Shield className="w-4 h-4 text-[#3da8ff] mx-auto mb-1" />
              <p className="text-xs text-[#8b95a8]">
                Auto-authenticates via browser
              </p>
            </div>
            <div className="rounded-lg bg-[#161822] p-3">
              <Clock className="w-4 h-4 text-[#3da8ff] mx-auto mb-1" />
              <p className="text-xs text-[#8b95a8]">
                Runs until you stop it. No lock-in
              </p>
            </div>
            <div className="rounded-lg bg-[#161822] p-3">
              <Layers className="w-4 h-4 text-[#3da8ff] mx-auto mb-1" />
              <p className="text-xs text-[#8b95a8]">
                All local models are auto-discovered
              </p>
            </div>
          </div>
        </StepCard>

        {/* FAQ */}
        <div className="mt-12">
          <h2 className="text-lg font-semibold text-[#eef1f8] mb-4">FAQ</h2>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] px-6">
            <FAQItem
              question="Is my data safe?"
              answer="Yes. All inference runs locally on your machine. User prompts are encrypted in transit and never stored on your hardware."
            />
            <FAQItem
              question="How do I get paid?"
              answer="Earnings accrue in USDC and are tracked above. You keep 85% of all inference revenue. Withdraw anytime to your wallet."
            />
            <FAQItem
              question="Can I stop anytime?"
              answer="Yes. Just stop the CLI process. No commitments, no penalties."
            />
            <FAQItem
              question="What models are supported?"
              answer="Any model Ollama supports: Llama, Mistral, Gemma, Phi, Qwen, and more. The CLI auto-discovers everything you've pulled."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StepCard({
  step,
  title,
  description,
  children,
  last,
}: {
  step: number;
  title: string;
  description: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`relative ${last ? "mb-0" : "mb-6"}`}>
      {/* Step number + connector line */}
      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-[#3da8ff]/10 text-[#3da8ff] font-bold text-sm flex items-center justify-center flex-shrink-0">
            {step}
          </div>
          {!last && (
            <div className="w-px h-full bg-[#1e2a3a] mt-2 min-h-[2rem]" />
          )}
        </div>
        <div className="flex-1 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 mb-2 hover:border-[#2a3a50] transition-colors">
          <h3 className="text-base font-semibold text-[#eef1f8] mb-1">
            {title}
          </h3>
          <p className="text-sm text-[#8b95a8] mb-4">{description}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────

export default function ProvidePage() {
  const { authenticated, loading } = useThumperAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#08090d] pt-24 flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  return authenticated ? <DashboardView /> : <LandingView />;
}
