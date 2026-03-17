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
              Ghola users pay for AI chat. Your GPU serves the inference. You
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
                desc: "Start the Ghola provider CLI. It auto-connects to the network.",
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
                  Revenue goes to you. Ghola takes a 15% platform fee.
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
                value: "Ollama (free) + Ghola CLI (free)",
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
        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.05] backdrop-blur-sm p-6 max-w-md">
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
        <h1 className="text-3xl font-medium text-[#eef1f8] mb-2 tracking-tight">
          GPU Provider Setup
        </h1>
        <p className="text-[#8b95a8] mb-8">
          Follow these four steps to start earning with your GPU.
        </p>

        {/* Provider Status (if already registered) */}
        {provider && (
          <GlassCard className="p-6 mb-8">
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
                    className="rounded-lg bg-white/[0.04] border border-white/[0.06] px-2.5 py-1 text-xs text-[#8b95a8] font-mono"
                  >
                    {m}
                  </span>
                ))}
              </div>
            )}
          </GlassCard>
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
              className="text-[#3da8ff] hover:text-[#5bb8ff] transition-colors"
            >
              ollama.ai
              <ArrowUpRight className="w-3 h-3 inline ml-0.5" />
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

        {/* FAQ */}
        <div className="mt-12">
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
