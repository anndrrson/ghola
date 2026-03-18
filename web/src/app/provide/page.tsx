"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { createProviderKey, getMyProvider, getComputeStats, getRecentJobs, getComputeProviders, getComputeModels, withdrawProviderEarnings, getProviderPayouts } from "@/lib/thumper-api";
import type { ComputeProviderInfo, ComputeDailyStats, ComputeRecentJob, PayoutsResponse } from "@/lib/thumper-types";
import {
  Download,
  Terminal,
  Cpu,
  DollarSign,
  Copy,
  Check,
  ChevronDown,
  Monitor,
  HardDrive,
  Wifi,
  Shield,
  Clock,
  Layers,
  Zap,
  ArrowRight,
  ArrowUpRight,
  TrendingUp,
  Activity,
  BarChart3,
  Wallet,
  Globe,
} from "lucide-react";

// ── Scroll reveal hook ───────────────────────────────────────────────

function useReveal(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, visible };
}

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, visible } = useReveal();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(28px)",
        transition: `opacity 0.7s cubic-bezier(0.16,1,0.3,1) ${delay}s, transform 0.7s cubic-bezier(0.16,1,0.3,1) ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}

// ── Shared components ────────────────────────────────────────────────

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
      className="absolute top-3 right-3 p-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] hover:border-white/[0.12] transition-all cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-4 h-4 text-green-400" />
      ) : (
        <Copy className="w-4 h-4 text-[#4a5568]" />
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
    <div className="relative group">
      <pre
        className={`rounded-xl bg-[#05060a] border p-4 pr-12 text-sm font-mono overflow-x-auto whitespace-pre transition-all duration-300 ${
          highlight
            ? "text-[#3da8ff] border-[#3da8ff]/20 shadow-[0_0_30px_rgba(61,168,255,0.08)] group-hover:shadow-[0_0_40px_rgba(61,168,255,0.12)]"
            : "text-[#8b95a8] border-white/[0.06] group-hover:border-white/[0.1]"
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
    <div className="border-b border-white/[0.06] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-left cursor-pointer group"
      >
        <span className="text-[#eef1f8] font-medium group-hover:text-white transition-colors">
          {question}
        </span>
        <ChevronDown
          className={`w-5 h-5 text-[#4a5568] transition-transform duration-300 flex-shrink-0 ml-4 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div
        className="grid transition-all duration-300 ease-out"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
        }}
      >
        <div className="overflow-hidden">
          <p className="text-sm text-[#8b95a8] pb-5 leading-relaxed">
            {answer}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Glass card wrapper ───────────────────────────────────────────────

function GlassCard({
  children,
  className = "",
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm ${
        hover
          ? "hover:border-white/[0.12] hover:bg-white/[0.04] hover:shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
          : ""
      } transition-all duration-300 ${className}`}
    >
      {children}
    </div>
  );
}

// ── Landing View (unauthenticated) ──────────────────────────────────

function LandingView() {
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!heroRef.current) return;
      const rect = heroRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 24;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * 24;
      heroRef.current.style.setProperty("--parallax-x", `${x}px`);
      heroRef.current.style.setProperty("--parallax-y", `${y}px`);
    }
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <div className="min-h-screen bg-[#08090d]">
      {/* ──────────── Hero ──────────── */}
      <section
        ref={heroRef}
        className="relative min-h-[calc(100vh-4rem)] flex items-center overflow-hidden pt-16"
        style={
          {
            "--parallax-x": "0px",
            "--parallax-y": "0px",
          } as React.CSSProperties
        }
      >
        {/* Animated gradient mesh */}
        <div className="absolute inset-0 overflow-hidden">
          <div
            className="absolute w-[700px] h-[700px] rounded-full opacity-[0.07]"
            style={{
              background:
                "radial-gradient(circle, #3da8ff 0%, transparent 70%)",
              top: "5%",
              left: "15%",
              animation: "float-slow 20s ease-in-out infinite",
            }}
          />
          <div
            className="absolute w-[500px] h-[500px] rounded-full opacity-[0.04]"
            style={{
              background:
                "radial-gradient(circle, #5bb8ff 0%, transparent 70%)",
              bottom: "10%",
              right: "10%",
              animation: "float-slow-reverse 25s ease-in-out infinite",
            }}
          />
          <div
            className="absolute w-[300px] h-[300px] rounded-full opacity-[0.03]"
            style={{
              background:
                "radial-gradient(circle, #93cbff 0%, transparent 70%)",
              top: "40%",
              right: "30%",
              animation: "float-slow 18s ease-in-out infinite 5s",
            }}
          />
        </div>

        {/* Noise texture overlay */}
        <div
          className="absolute inset-0 opacity-[0.015] pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundSize: "128px 128px",
          }}
        />

        {/* Parallax dot grid */}
        <div
          className="absolute inset-[-20px] pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(61,168,255,0.12) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
            transform: "translate(var(--parallax-x), var(--parallax-y))",
            transition: "transform 0.15s ease-out",
          }}
        />

        {/* Radial vignette */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 40%, #08090d 80%)",
          }}
        />

        <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-24">
          <div className="max-w-3xl mx-auto">
            {/* Badge */}
            <div
              className="flex justify-center mb-8"
              style={{
                opacity: 0,
                animation: "fade-in-up 0.7s cubic-bezier(0.16,1,0.3,1) 0.1s forwards",
              }}
            >
              <div className="inline-flex items-center gap-2 rounded-full border border-[#3da8ff]/20 bg-[#3da8ff]/[0.06] px-4 py-1.5 text-sm text-[#3da8ff]">
                <Zap className="w-3.5 h-3.5" />
                Decentralized AI Inference
              </div>
            </div>

            {/* Title */}
            <h1
              className="text-5xl sm:text-6xl md:text-7xl font-medium tracking-tight text-[#eef1f8] text-center leading-[1.08]"
              style={{
                opacity: 0,
                animation: "fade-in-up 0.7s cubic-bezier(0.16,1,0.3,1) 0.2s forwards",
              }}
            >
              Turn your idle GPU
              <br />
              into{" "}
              <span className="text-[#3da8ff]">income</span>
            </h1>

            {/* Subtitle */}
            <p
              className="mt-6 text-lg md:text-xl text-[#8b95a8] text-center max-w-2xl mx-auto leading-relaxed"
              style={{
                opacity: 0,
                animation: "fade-in-up 0.7s cubic-bezier(0.16,1,0.3,1) 0.35s forwards",
              }}
            >
              ghola users pay for AI chat. Your GPU serves the inference. You
              earn USDC for every request. No middlemen, no cloud
              bills&mdash;just your hardware working for you.
            </p>

            {/* Terminal box */}
            <div
              className="mt-12 max-w-lg mx-auto"
              style={{
                opacity: 0,
                animation: "fade-in-up 0.7s cubic-bezier(0.16,1,0.3,1) 0.5s forwards",
              }}
            >
              <div className="relative rounded-2xl bg-[#05060a]/80 border border-white/[0.06] p-6 shadow-[0_0_60px_rgba(61,168,255,0.06)] backdrop-blur-sm">
                {/* Terminal header dots */}
                <div className="flex items-center gap-1.5 mb-4">
                  <div className="w-2.5 h-2.5 rounded-full bg-white/[0.08]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-white/[0.08]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-white/[0.08]" />
                  <span className="ml-2 text-[10px] text-white/[0.15] font-mono uppercase tracking-widest">
                    terminal
                  </span>
                </div>
                <div className="space-y-2">
                  <div className="relative">
                    <pre className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3 text-sm font-mono text-[#3da8ff] overflow-x-auto">
                      <span className="text-[#4a5568] select-none">$ </span>
                      curl -fsSL https://ghola.xyz/install.sh | sh
                    </pre>
                    <CopyButton text="curl -fsSL https://ghola.xyz/install.sh | sh" />
                  </div>
                  <div className="relative">
                    <pre className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3 text-sm font-mono text-[#3da8ff] overflow-x-auto">
                      <span className="text-[#4a5568] select-none">$ </span>
                      ghola up
                      <span
                        className="inline-block w-2 h-4 bg-[#3da8ff] ml-1 align-middle"
                        style={{ animation: "terminal-blink 1.2s step-end infinite" }}
                      />
                    </pre>
                    <CopyButton text="ghola up" />
                  </div>
                </div>
                <p className="text-xs text-[#4a5568] mt-4 leading-relaxed font-mono">
                  <span className="text-[#4a5568] select-none">// </span>
                  installs CLI, checks Ollama, auto-pulls model, starts earning
                </p>
              </div>
            </div>

            {/* CTAs */}
            <div
              className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
              style={{
                opacity: 0,
                animation: "fade-in-up 0.7s cubic-bezier(0.16,1,0.3,1) 0.65s forwards",
              }}
            >
              <Link
                href="/signin?redirect=/provide"
                className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all shadow-[0_0_24px_rgba(61,168,255,0.2)]"
              >
                Start Earning
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="#how-it-works"
                className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-white/[0.2] active:scale-[0.98] transition-all"
              >
                Learn more
              </Link>
            </div>

            {/* Comment-style footer */}
            <p
              className="mt-16 text-center text-xs font-mono text-white/[0.15]"
              style={{
                opacity: 0,
                animation: "fade-in-up 0.7s cubic-bezier(0.16,1,0.3,1) 0.8s forwards",
              }}
            >
              // powered by distributed GPUs worldwide
            </p>
          </div>
        </div>
      </section>

      {/* ──────────── How It Works ──────────── */}
      <section id="how-it-works" className="py-24 sm:py-32 border-t border-white/[0.04]">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-medium text-[#eef1f8] text-center mb-4">
              How it works
            </h2>
            <p className="text-[#4a5568] text-center mb-14 font-mono text-sm">
              // four steps to your first payout
            </p>
          </Reveal>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: Download,
                title: "Install Ollama",
                desc: "Free, open-source local AI server. One command install on Linux or macOS.",
                num: "01",
              },
              {
                icon: Layers,
                title: "Pull a model",
                desc: "Download a model like Llama 3.2. It runs entirely on your GPU.",
                num: "02",
              },
              {
                icon: Terminal,
                title: "Run one command",
                desc: "Start the ghola provider CLI. It auto-connects to the network.",
                num: "03",
              },
              {
                icon: DollarSign,
                title: "Get paid",
                desc: "Earn USDC for every inference request your GPU serves.",
                num: "04",
              },
            ].map((item, i) => (
              <Reveal key={item.title} delay={0.1 + i * 0.1}>
                <GlassCard className="p-6 h-full">
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-10 h-10 rounded-xl bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] flex items-center justify-center">
                      <item.icon className="w-5 h-5 text-[#3da8ff]" />
                    </div>
                    <span className="text-xs font-mono text-white/[0.1]">
                      {item.num}
                    </span>
                  </div>
                  <h3 className="text-base font-medium text-[#eef1f8] mb-2">
                    {item.title}
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed">
                    {item.desc}
                  </p>
                </GlassCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────── Provider Economics ──────────── */}
      <section className="py-24 sm:py-32 border-t border-white/[0.04] relative">
        {/* Subtle background glow for this section */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.03]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 0%, #3da8ff 0%, transparent 60%)",
          }}
        />
        <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-medium text-[#eef1f8] text-center mb-4">
              Provider economics
            </h2>
            <p className="text-[#4a5568] text-center mb-14 font-mono text-sm">
              // your GPU, your revenue
            </p>
          </Reveal>
          <div className="grid sm:grid-cols-3 gap-5">
            <Reveal delay={0.1}>
              <GlassCard className="p-8 text-center h-full">
                <p className="text-5xl font-medium text-[#eef1f8] mb-2 tracking-tight">
                  85%
                </p>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  Revenue goes to you. ghola takes a 15% platform fee.
                </p>
              </GlassCard>
            </Reveal>
            <Reveal delay={0.2}>
              <GlassCard className="p-8 text-center h-full border-[#3da8ff]/10 shadow-[0_0_40px_rgba(61,168,255,0.04)]">
                <p className="text-sm font-mono text-[#3da8ff] mb-3">
                  per 1K tokens
                </p>
                <div className="flex items-center justify-center gap-4 text-sm">
                  <div>
                    <span className="text-[#eef1f8] font-medium">10</span>
                    <span className="text-[#4a5568] ml-1">&micro;USDC in</span>
                  </div>
                  <span className="text-white/[0.1]">/</span>
                  <div>
                    <span className="text-[#eef1f8] font-medium">30</span>
                    <span className="text-[#4a5568] ml-1">&micro;USDC out</span>
                  </div>
                </div>
                <p className="text-xs text-[#4a5568] mt-3 font-mono">
                  // early network rates
                </p>
              </GlassCard>
            </Reveal>
            <Reveal delay={0.3}>
              <GlassCard className="p-8 text-center h-full">
                <p className="text-5xl font-medium text-[#eef1f8] mb-2 tracking-tight">
                  $0
                </p>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  No signup fees. No monthly cost. Earn from day one.
                </p>
              </GlassCard>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ──────────── Requirements ──────────── */}
      <section className="py-24 sm:py-32 border-t border-white/[0.04]">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-medium text-[#eef1f8] text-center mb-4">
              Requirements
            </h2>
            <p className="text-[#4a5568] text-center mb-14 font-mono text-sm">
              // what you need to get started
            </p>
          </Reveal>
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
                value: "Ollama (free) + ghola CLI (free)",
              },
              {
                icon: Wifi,
                label: "Internet",
                value: "Stable connection \u2014 no specific bandwidth required",
              },
            ].map((item, i) => (
              <Reveal key={item.label} delay={0.1 + i * 0.08}>
                <GlassCard className="p-5 h-full">
                  <div className="flex items-start gap-4">
                    <div className="w-9 h-9 rounded-xl bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] flex items-center justify-center flex-shrink-0 mt-0.5">
                      <item.icon className="w-4 h-4 text-[#3da8ff]" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#eef1f8]">
                        {item.label}
                      </p>
                      <p className="text-sm text-[#8b95a8] mt-0.5">
                        {item.value}
                      </p>
                    </div>
                  </div>
                </GlassCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────── FAQ ──────────── */}
      <section className="py-24 sm:py-32 border-t border-white/[0.04]">
        <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <h2 className="text-3xl font-medium text-[#eef1f8] text-center mb-14">
              FAQ
            </h2>
          </Reveal>
          <Reveal delay={0.15}>
            <GlassCard className="px-6 sm:px-8" hover={false}>
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
            </GlassCard>
          </Reveal>
        </div>
      </section>

      {/* ──────────── Bottom CTA ──────────── */}
      <section className="py-24 sm:py-32 relative">
        {/* Background glow */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.04]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 100%, #3da8ff 0%, transparent 50%)",
          }}
        />
        <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
          <Reveal>
            <h2 className="text-3xl sm:text-4xl font-medium text-[#eef1f8] mb-4">
              Your GPU is waiting
            </h2>
            <p className="text-[#8b95a8] mb-10 max-w-md mx-auto">
              Two commands. No signup fees. Start earning USDC today.
            </p>
            <Link
              href="/signin?redirect=/provide"
              className="inline-flex items-center gap-2 rounded-xl bg-[#3da8ff] px-8 py-4 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all shadow-[0_0_32px_rgba(61,168,255,0.2)]"
            >
              Start Earning
              <ArrowRight className="w-4 h-4" />
            </Link>
            <p className="mt-6 text-sm text-[#4a5568]">
              Already have an account?{" "}
              <Link
                href="/signin?redirect=/provide"
                className="text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
              >
                Sign in
                <ArrowUpRight className="w-3 h-3 inline ml-0.5" />
              </Link>
            </p>
          </Reveal>
        </div>
      </section>
    </div>
  );
}

// ── Dashboard View (authenticated) ──────────────────────────────────

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function DashboardView() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<ComputeProviderInfo | null>(null);
  const [dailyStats, setDailyStats] = useState<ComputeDailyStats[]>([]);
  const [recentJobs, setRecentJobs] = useState<ComputeRecentJob[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [networkProviderCount, setNetworkProviderCount] = useState(0);
  const [networkModelCount, setNetworkModelCount] = useState(0);
  const [payoutsData, setPayoutsData] = useState<PayoutsResponse | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [withdrawSuccess, setWithdrawSuccess] = useState<{ signature: string; explorer_url: string } | null>(null);

  // Initial data load
  useEffect(() => {
    async function init() {
      try {
        // Ensure provider key exists (idempotent)
        await createProviderKey().catch(() => {});

        const [prov, stats, jobs, providers, modelsResp, payouts] = await Promise.all([
          getMyProvider().catch(() => null),
          getComputeStats(30).catch(() => []),
          getRecentJobs(20).catch(() => []),
          getComputeProviders().catch(() => []),
          getComputeModels().catch(() => ({ models: [] })),
          getProviderPayouts(10).catch(() => null),
        ]);
        if (prov) setProvider(prov);
        setDailyStats(stats);
        setRecentJobs(jobs);
        setNetworkProviderCount(providers.length);
        setNetworkModelCount(modelsResp.models?.length ?? 0);
        if (payouts) setPayoutsData(payouts);

        // Auto-expand setup if no provider or offline
        if (!prov || prov.status !== "online") setSetupOpen(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Poll provider status every 10s
  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const p = await getMyProvider();
        if (!cancelled && p) setProvider(p);
      } catch { /* ignore */ }
    }, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Refresh stats and recent jobs every 60s
  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const [stats, jobs] = await Promise.all([
          getComputeStats(30).catch(() => [] as ComputeDailyStats[]),
          getRecentJobs(20).catch(() => [] as ComputeRecentJob[]),
        ]);
        if (!cancelled) {
          setDailyStats(stats);
          setRecentJobs(jobs);
        }
      } catch { /* ignore */ }
    }, 60000);
    return () => { cancelled = true; clearInterval(interval); };
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
        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.05] backdrop-blur-sm p-6 max-w-md">
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  const totalEarned = provider ? provider.total_earned_usdc / 1_000_000 : 0;
  const totalWithdrawn = provider ? (provider.total_withdrawn_usdc ?? 0) / 1_000_000 : 0;
  const availableBalance = totalEarned - totalWithdrawn;
  const todayStats = dailyStats.length > 0 ? dailyStats[0] : null;
  const todayEarned = todayStats ? todayStats.earned_usdc / 1_000_000 : 0;
  const todayRequests = todayStats ? todayStats.requests_total : 0;
  const todayLatency = todayStats ? todayStats.avg_latency_ms : 0;

  // Success rate from all stats
  const totalSuccess = dailyStats.reduce((s, d) => s + d.requests_success, 0);
  const totalReqs = dailyStats.reduce((s, d) => s + d.requests_total, 0);
  const successRate = totalReqs > 0 ? (totalSuccess / totalReqs) * 100 : 100;

  // Chart data
  const chartData = [...dailyStats].reverse(); // oldest first for chart
  const maxEarned = Math.max(...chartData.map(d => d.earned_usdc), 1);

  // Parse models from provider (it's a JSON value from the backend)
  const models: { model_id: string; price_per_1k_input: number; price_per_1k_output: number }[] =
    provider?.models && Array.isArray(provider.models) ? provider.models : [];

  return (
    <div className="min-h-screen bg-[#08090d] pt-24 pb-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        {/* Provider Status Bar */}
        {provider && (
          <GlassCard className="p-4 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={`w-3 h-3 rounded-full ${
                    provider.status === "online"
                      ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.4)] animate-pulse"
                      : "bg-[#4a5568]"
                  }`}
                />
                <span className="text-[#eef1f8] font-medium">{provider.display_name}</span>
                <span className="text-sm text-[#8b95a8] capitalize">{provider.status}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#4a5568]">
                {provider.last_heartbeat_at && (
                  <span>Last active: {timeAgo(provider.last_heartbeat_at)}</span>
                )}
                {provider.reputation_score > 0 && (
                  <span className="ml-2">Rep: {provider.reputation_score.toFixed(2)}</span>
                )}
              </div>
            </div>
          </GlassCard>
        )}

        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <GlassCard className="p-5">
            <div className="flex items-start justify-between mb-3">
              <p className="text-sm text-[#8b95a8]">Total Earned</p>
              <div className="w-8 h-8 rounded-lg bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-[#3da8ff]" />
              </div>
            </div>
            <p className="text-2xl font-medium text-[#eef1f8] tracking-tight">
              {totalEarned.toFixed(4)}
            </p>
            <p className="text-xs text-[#4a5568] mt-1">USDC</p>
          </GlassCard>

          <GlassCard className="p-5">
            <div className="flex items-start justify-between mb-3">
              <p className="text-sm text-[#8b95a8]">Today</p>
              <div className="w-8 h-8 rounded-lg bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-[#3da8ff]" />
              </div>
            </div>
            <p className="text-2xl font-medium text-[#eef1f8] tracking-tight">
              {todayEarned.toFixed(4)}
            </p>
            <p className="text-xs text-[#4a5568] mt-1">USDC today</p>
          </GlassCard>

          <GlassCard className="p-5">
            <div className="flex items-start justify-between mb-3">
              <p className="text-sm text-[#8b95a8]">Requests Today</p>
              <div className="w-8 h-8 rounded-lg bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] flex items-center justify-center">
                <Activity className="w-4 h-4 text-[#3da8ff]" />
              </div>
            </div>
            <p className="text-2xl font-medium text-[#eef1f8] tracking-tight">
              {todayRequests.toLocaleString()}
            </p>
            <p className="text-xs text-[#4a5568] mt-1">inference requests</p>
          </GlassCard>

          <GlassCard className="p-5">
            <div className="flex items-start justify-between mb-3">
              <p className="text-sm text-[#8b95a8]">Avg Latency</p>
              <div className="w-8 h-8 rounded-lg bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] flex items-center justify-center">
                <Clock className="w-4 h-4 text-[#3da8ff]" />
              </div>
            </div>
            <p className="text-2xl font-medium text-[#eef1f8] tracking-tight">
              {todayLatency > 0 ? `${Math.round(todayLatency)}` : "--"}
            </p>
            <p className="text-xs text-[#4a5568] mt-1">ms</p>
          </GlassCard>
        </div>

        {/* Earnings Chart + Model Breakdown */}
        <div className="grid lg:grid-cols-3 gap-4 mb-6">
          {/* Earnings Chart */}
          <GlassCard className="p-6 lg:col-span-2" hover={false}>
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-5 h-5 text-[#8b95a8]" />
              <h2 className="text-base font-medium text-[#eef1f8]">
                Earnings &mdash; Last 30 Days
              </h2>
            </div>
            {chartData.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-sm text-[#4a5568]">
                No data yet. Start serving inference to see earnings.
              </div>
            ) : (
              <>
                <div className="flex items-end gap-[3px] h-40">
                  {chartData.map((day) => {
                    const heightPct = (day.earned_usdc / maxEarned) * 100;
                    return (
                      <div
                        key={day.stat_date}
                        className="flex-1 min-w-0 group relative"
                        style={{ height: "100%" }}
                      >
                        <div
                          className="absolute bottom-0 left-0 right-0 rounded-t bg-[#3da8ff]/70 hover:bg-[#3da8ff] transition-colors cursor-default"
                          style={{ height: `${Math.max(heightPct, 2)}%` }}
                          title={`${day.stat_date}: $${(day.earned_usdc / 1_000_000).toFixed(4)} USDC, ${day.requests_total} requests`}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between mt-2 text-xs text-[#4a5568]">
                  <span>{chartData[0]?.stat_date || ""}</span>
                  <span>{chartData[chartData.length - 1]?.stat_date || ""}</span>
                </div>
              </>
            )}
          </GlassCard>

          {/* Model Breakdown + Success Rate */}
          <GlassCard className="p-6" hover={false}>
            <h2 className="text-base font-medium text-[#eef1f8] mb-4">Models</h2>
            {models.length === 0 ? (
              <p className="text-sm text-[#4a5568]">No models registered.</p>
            ) : (
              <div className="space-y-3 mb-6">
                {models.map((m) => (
                  <div key={m.model_id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <span className="text-sm font-mono text-[#eef1f8] truncate max-w-[140px]">
                        {m.model_id}
                      </span>
                    </div>
                    <span className="text-xs text-[#4a5568]">
                      {m.price_per_1k_input}/{m.price_per_1k_output}
                    </span>
                  </div>
                ))}
                <p className="text-xs text-[#4a5568] mt-1">price per 1K tokens (in/out)</p>
              </div>
            )}

            {/* Success Rate */}
            <div className="border-t border-white/[0.06] pt-4">
              <p className="text-sm text-[#8b95a8] mb-3">Success Rate</p>
              <div className="flex items-center gap-3">
                <div
                  className="w-14 h-14 rounded-full flex-shrink-0"
                  style={{
                    background: `conic-gradient(#3da8ff ${successRate * 3.6}deg, rgba(255,255,255,0.04) 0deg)`,
                  }}
                >
                  <div className="w-full h-full rounded-full bg-[#08090d] m-auto flex items-center justify-center" style={{ width: "calc(100% - 6px)", height: "calc(100% - 6px)", margin: "3px" }}>
                    <span className="text-sm font-medium text-[#eef1f8]">
                      {successRate.toFixed(0)}%
                    </span>
                  </div>
                </div>
                <div className="text-xs text-[#4a5568]">
                  {totalSuccess} / {totalReqs} requests
                </div>
              </div>
            </div>
          </GlassCard>
        </div>

        {/* Recent Jobs */}
        <GlassCard className="p-6 mb-6" hover={false}>
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="w-5 h-5 text-[#8b95a8]" />
            <h2 className="text-base font-medium text-[#eef1f8]">Recent Jobs</h2>
          </div>
          {recentJobs.length === 0 ? (
            <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-6 py-10 text-center">
              <Cpu className="mx-auto h-10 w-10 text-[#4a5568] mb-3" />
              <p className="text-sm text-[#8b95a8]">No jobs served yet.</p>
              <p className="text-xs text-[#4a5568] mt-1">Jobs will appear here once your GPU serves inference requests.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] text-left">
                    <th className="pb-3 font-medium text-[#8b95a8]">Model</th>
                    <th className="pb-3 font-medium text-[#8b95a8]">Status</th>
                    <th className="pb-3 font-medium text-[#8b95a8] text-right">Tokens</th>
                    <th className="pb-3 font-medium text-[#8b95a8] text-right">Latency</th>
                    <th className="pb-3 font-medium text-[#8b95a8] text-right">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((job) => (
                    <tr key={job.id} className="border-b border-white/[0.03]">
                      <td className="py-3 text-[#eef1f8] font-mono text-xs">
                        {job.model_id}
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                            job.status === "completed"
                              ? "bg-green-400/10 text-green-400"
                              : job.status === "failed"
                              ? "bg-red-400/10 text-red-400"
                              : "bg-yellow-400/10 text-yellow-400"
                          }`}
                        >
                          <div className={`w-1.5 h-1.5 rounded-full ${
                            job.status === "completed" ? "bg-green-400" :
                            job.status === "failed" ? "bg-red-400" : "bg-yellow-400"
                          }`} />
                          {job.status}
                        </span>
                      </td>
                      <td className="py-3 text-[#8b95a8] text-right font-mono text-xs">
                        {job.input_tokens != null && job.output_tokens != null
                          ? `${job.input_tokens + job.output_tokens}`
                          : "--"}
                      </td>
                      <td className="py-3 text-[#8b95a8] text-right text-xs">
                        {job.latency_ms != null ? `${job.latency_ms}ms` : "--"}
                      </td>
                      <td className="py-3 text-[#4a5568] text-right text-xs">
                        {timeAgo(job.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>

        {/* Network Status */}
        <GlassCard className="p-6 mb-6" hover={false}>
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-[#8b95a8]" />
            <h2 className="text-base font-medium text-[#eef1f8]">Network Status</h2>
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="text-sm text-[#8b95a8]">
              <span className="text-[#eef1f8] font-medium">{networkProviderCount}</span>{" "}
              {networkProviderCount === 1 ? "provider" : "providers"} online
            </div>
            <span className="text-[#4a5568]">&middot;</span>
            <div className="text-sm text-[#8b95a8]">
              <span className="text-[#eef1f8] font-medium">{networkModelCount}</span>{" "}
              {networkModelCount === 1 ? "model" : "models"} available
            </div>
          </div>
          {provider?.status === "online" && (
            <div className="mt-3 flex items-center gap-2 text-xs text-green-400">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              You are contributing to the network
            </div>
          )}
        </GlassCard>

        {/* Payouts */}
        <GlassCard className="p-6 mb-6" hover={false}>
          <div className="flex items-center gap-2 mb-4">
            <Wallet className="w-5 h-5 text-[#8b95a8]" />
            <h2 className="text-base font-medium text-[#eef1f8]">Payouts</h2>
          </div>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-[#8b95a8]">Earned</span>
              <span className="text-sm font-medium text-[#eef1f8] font-mono">
                ${totalEarned.toFixed(4)} <span className="text-xs text-[#4a5568]">USDC</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-[#8b95a8]">Withdrawn</span>
              <span className="text-sm font-medium text-[#eef1f8] font-mono">
                ${totalWithdrawn.toFixed(4)} <span className="text-xs text-[#4a5568]">USDC</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-[#8b95a8]">Available</span>
              <span className="text-lg font-medium text-[#3da8ff] font-mono">
                ${availableBalance.toFixed(4)} <span className="text-xs text-[#4a5568]">USDC</span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[#8b95a8]">Wallet</span>
              {provider?.wallet_address ? (
                <span className="text-sm text-[#eef1f8] font-mono">
                  {provider.wallet_address.slice(0, 4)}...{provider.wallet_address.slice(-4)}
                </span>
              ) : (
                <span className="text-sm text-[#4a5568]">No wallet address</span>
              )}
            </div>
            <div className="pt-2 border-t border-white/[0.06]">
              <button
                disabled={availableBalance < 1.0 || !provider?.wallet_address || withdrawing}
                onClick={async () => {
                  setWithdrawing(true);
                  setWithdrawError("");
                  setWithdrawSuccess(null);
                  try {
                    const res = await withdrawProviderEarnings();
                    setWithdrawSuccess({ signature: res.signature, explorer_url: res.explorer_url });
                    // Refresh provider + payouts data
                    const [prov, payouts] = await Promise.all([
                      getMyProvider().catch(() => null),
                      getProviderPayouts(10).catch(() => null),
                    ]);
                    if (prov) setProvider(prov);
                    if (payouts) setPayoutsData(payouts);
                  } catch (err) {
                    setWithdrawError(err instanceof Error ? err.message : "Withdrawal failed");
                  } finally {
                    setWithdrawing(false);
                  }
                }}
                className={`rounded-xl px-4 py-2 text-sm transition-colors ${
                  availableBalance >= 1.0 && provider?.wallet_address && !withdrawing
                    ? "bg-[#3da8ff]/10 border border-[#3da8ff]/30 text-[#3da8ff] hover:bg-[#3da8ff]/20 cursor-pointer"
                    : "bg-white/[0.04] border border-white/[0.06] text-[#4a5568] cursor-not-allowed"
                }`}
              >
                {withdrawing ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3 w-3 animate-spin rounded-full border border-[#3da8ff] border-t-transparent" />
                    Withdrawing...
                  </span>
                ) : (
                  `Withdraw $${availableBalance.toFixed(2)}`
                )}
              </button>
              {!provider?.wallet_address && (
                <p className="text-xs text-[#4a5568] mt-2">
                  Set a wallet address on your provider profile to withdraw.
                </p>
              )}
              {availableBalance < 1.0 && provider?.wallet_address && (
                <p className="text-xs text-[#4a5568] mt-2">
                  Minimum withdrawal is $1.00 USDC.
                </p>
              )}
              {withdrawSuccess && (
                <div className="mt-3 p-3 rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20">
                  <p className="text-xs text-emerald-400 mb-1">Withdrawal confirmed</p>
                  <a
                    href={withdrawSuccess.explorer_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[#3da8ff] font-mono hover:underline break-all"
                  >
                    {withdrawSuccess.signature.slice(0, 20)}...
                  </a>
                </div>
              )}
              {withdrawError && (
                <p className="text-xs text-red-400 mt-2">{withdrawError}</p>
              )}
            </div>
          </div>

          {/* Payout History */}
          {payoutsData && payoutsData.payouts.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/[0.06]">
              <h3 className="text-sm font-medium text-[#8b95a8] mb-3">History</h3>
              <div className="space-y-2">
                {payoutsData.payouts.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <span className="text-[#8b95a8]">
                      {new Date(p.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    <span className="text-[#eef1f8] font-mono">
                      ${(p.amount_usdc / 1_000_000).toFixed(2)}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      p.status === "confirmed"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : p.status === "failed"
                        ? "bg-red-500/10 text-red-400"
                        : "bg-yellow-500/10 text-yellow-400"
                    }`}>
                      {p.status}
                    </span>
                    {p.signature ? (
                      <a
                        href={`https://explorer.solana.com/tx/${p.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#3da8ff] hover:underline"
                      >
                        view
                      </a>
                    ) : (
                      <span className="text-[#4a5568]">-</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </GlassCard>

        {/* Setup Steps — Collapsible Accordion */}
        <GlassCard className="mb-6" hover={false}>
          <button
            onClick={() => setSetupOpen(!setupOpen)}
            className="w-full flex items-center justify-between p-5 cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-[#3da8ff]" />
              <span className="text-base font-medium text-[#eef1f8]">Setup Guide</span>
              {provider?.status === "online" && (
                <span className="text-xs text-green-400 bg-green-400/10 rounded-full px-2 py-0.5">
                  Completed
                </span>
              )}
            </div>
            <ChevronDown
              className={`w-5 h-5 text-[#4a5568] transition-transform duration-300 ${
                setupOpen ? "rotate-180" : ""
              }`}
            />
          </button>
          <div
            className="grid transition-all duration-300 ease-out"
            style={{
              gridTemplateRows: setupOpen ? "1fr" : "0fr",
              opacity: setupOpen ? 1 : 0,
            }}
          >
            <div className="overflow-hidden">
              <div className="px-5 pb-5">
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
                      className="text-[#3da8ff] hover:text-[#5bb8ff] transition-colors"
                    >
                      ollama.ai
                      <ArrowUpRight className="w-3 h-3 inline ml-0.5" />
                    </a>
                  </p>
                </StepCard>

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

                <StepCard
                  step={3}
                  title="Install ghola CLI"
                  description="The CLI connects your machine to the ghola network."
                >
                  <CodeBlock code="curl -fsSL https://ghola.xyz/install.sh | sh" />
                  <p className="text-xs text-[#4a5568] mt-3">
                    Downloads a pre-built binary, or falls back to building from source with Rust.
                  </p>
                </StepCard>

                <StepCard
                  step={4}
                  title="Start providing"
                  description="One command does everything: checks Ollama, pulls a model if needed, authenticates you, and connects to the network."
                  last
                >
                  <CodeBlock code="ghola up" highlight />
                  <div className="mt-4 rounded-xl bg-[#3da8ff]/[0.04] border border-[#3da8ff]/[0.08] p-3">
                    <p className="text-xs text-[#8b95a8]">
                      Already logged in from this browser &mdash;{" "}
                      <code className="text-[#3da8ff]">ghola up</code> will detect your
                      auth automatically.
                    </p>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                    {[
                      { icon: Shield, label: "Auto-authenticates via browser" },
                      { icon: Clock, label: "Runs until you stop it. No lock-in" },
                      { icon: Layers, label: "All local models are auto-discovered" },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3"
                      >
                        <item.icon className="w-4 h-4 text-[#3da8ff] mx-auto mb-1.5" />
                        <p className="text-xs text-[#8b95a8]">{item.label}</p>
                      </div>
                    ))}
                  </div>
                </StepCard>
              </div>
            </div>
          </div>
        </GlassCard>

        {/* FAQ */}
        <div>
          <h2 className="text-lg font-medium text-[#eef1f8] mb-4">FAQ</h2>
          <GlassCard className="px-6" hover={false}>
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
          </GlassCard>
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
      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-[#3da8ff]/[0.08] border border-[#3da8ff]/[0.1] text-[#3da8ff] font-medium text-sm flex items-center justify-center flex-shrink-0">
            {step}
          </div>
          {!last && (
            <div className="w-px h-full bg-white/[0.06] mt-2 min-h-[2rem]" />
          )}
        </div>
        <GlassCard className="flex-1 p-6 mb-2">
          <h3 className="text-base font-medium text-[#eef1f8] mb-1">
            {title}
          </h3>
          <p className="text-sm text-[#8b95a8] mb-4">{description}</p>
          {children}
        </GlassCard>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

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
