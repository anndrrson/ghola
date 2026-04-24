"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Shield,
  Search,
  CreditCard,
  Fingerprint,
  Zap,
  Code,
  BarChart3,
  Lock,
  Cpu,
  Sparkles,
  Store,
  Bot,
  Wallet,
  Coins,
} from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";

export default function Home() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && authenticated) {
      router.push("/chat");
    }
  }, [authenticated, loading, router]);

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

  if (authenticated && !loading) return null;

  return (
    <div className="min-h-screen pt-16">
      {/* ──────────── Hero ──────────── */}
      <section
        ref={heroRef}
        className="relative min-h-[calc(100vh-4rem)] flex items-center overflow-hidden"
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

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-24 sm:py-32">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
              <span className="h-2 w-2 rounded-full bg-[#3da8ff] animate-pulse" />
              The open economy for AI agents · on Solana
            </div>
            <h1 className="text-5xl md:text-7xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
              Earn when
              <br />
              <span className="text-[#3da8ff]">AI works.</span>
            </h1>
            <p className="mt-8 text-lg md:text-xl text-[#8b95a8] leading-relaxed max-w-2xl">
              Ghola is the open economy for AI agents. Contribute compute,
              publish a model, or run a service — and get paid every time an
              agent uses it. Or put an agent to work: it acts, pays, and
              transacts with its own on-chain wallet.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4">
              <Link
                href="/earn"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Start earning
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/agents/new"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Use an agent
              </Link>
            </div>
            <div className="mt-12 flex flex-wrap gap-x-8 gap-y-3 text-sm text-[#8b95a8]">
              <div className="flex items-center gap-2">
                <span className="h-1 w-1 rounded-full bg-[#3da8ff]" />
                Per-call USDC settlement
              </div>
              <div className="flex items-center gap-2">
                <span className="h-1 w-1 rounded-full bg-[#3da8ff]" />
                On-chain identity &amp; reputation
              </div>
              <div className="flex items-center gap-2">
                <span className="h-1 w-1 rounded-full bg-[#3da8ff]" />
                Open protocol, no gatekeepers
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Four Sides, One Economy ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-16">
            <span className="text-sm font-medium text-[#3da8ff] mb-4 block">
              The marketplace
            </span>
            <h2 className="text-3xl md:text-4xl font-medium text-[#eef1f8] mb-4">
              Four sides. One economy.
            </h2>
            <p className="text-[#8b95a8] leading-relaxed">
              AI agents need compute, models, and services to do real work —
              and they&apos;ll pay for all three. Pick a side. Get plugged in.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Cpu,
                tag: "Supply",
                title: "Run compute",
                desc: "Your phone, GPU, or server hosts inference. Earn USDC every time an agent calls it.",
                cta: "Host a node",
                href: "/earn/compute",
              },
              {
                icon: Sparkles,
                tag: "Supply",
                title: "Publish a model",
                desc: "Fine-tune and ship your own model. Earn per call, 85% revenue share.",
                cta: "Publish",
                href: "/earn/models",
              },
              {
                icon: Store,
                tag: "Supply",
                title: "Sell a service",
                desc: "Register your API as a headless merchant. Get discovered by agents. 3% fee, hourly USDC settlement.",
                cta: "Register",
                href: "/provide",
              },
              {
                icon: Bot,
                tag: "Demand",
                title: "Use an agent",
                desc: "Give an agent its own wallet, identity, and reputation. It acts, books, buys, and pays — without touching yours.",
                cta: "Deploy",
                href: "/agents/new",
              },
            ].map((card) => {
              const Icon = card.icon;
              return (
                <Link
                  key={card.title}
                  href={card.href}
                  className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#3da8ff]/40 transition-colors flex flex-col"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center">
                      <Icon className="h-5 w-5 text-[#3da8ff]" />
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-[#8b95a8] font-medium">
                      {card.tag}
                    </span>
                  </div>
                  <h3 className="text-[#eef1f8] font-medium text-base mb-2">
                    {card.title}
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed mb-6 flex-1">
                    {card.desc}
                  </p>
                  <div className="inline-flex items-center gap-2 text-sm font-medium text-[#3da8ff] group-hover:text-[#5bb8ff]">
                    {card.cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ──────────── How the flywheel works ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="text-sm font-medium text-[#3da8ff] mb-4 block">
                The flywheel
              </span>
              <h2 className="text-3xl md:text-4xl font-medium text-[#eef1f8] mb-4">
                Every agent action pays someone.
              </h2>
              <p className="text-[#8b95a8] mb-8 leading-relaxed">
                An agent needs a model to think, compute to run, and services
                to act. Each of those has a price. Each payment settles in
                USDC on Solana. Every participant builds on-chain reputation
                with every transaction.
              </p>
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-2 text-[#3da8ff] hover:text-[#5bb8ff] text-sm font-medium"
              >
                See the full flow <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="space-y-3">
              {[
                {
                  icon: Search,
                  label: "Resolve",
                  desc: "Agent queries the registry for a model, compute node, or service that matches the task",
                },
                {
                  icon: Shield,
                  label: "Verify",
                  desc: "Cryptographic identity check — UCAN credentials, on-chain registration, reputation score",
                },
                {
                  icon: Zap,
                  label: "Execute",
                  desc: "Call lands at the provider, work happens, result returns",
                },
                {
                  icon: Coins,
                  label: "Settle",
                  desc: "USDC flows from the agent's wallet to the provider, per-call, hourly batched",
                },
              ].map((step, i) => {
                const Icon = step.icon;
                return (
                  <div
                    key={step.label}
                    className="flex gap-4 items-start rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-xs font-medium text-[#3da8ff]">
                      {i + 1}
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="h-3.5 w-3.5 text-[#3da8ff]" />
                        <h4 className="text-sm font-medium text-[#eef1f8]">
                          {step.label}
                        </h4>
                      </div>
                      <p className="text-xs text-[#8b95a8] leading-relaxed">
                        {step.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Protocol Layers ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <span className="text-sm font-medium text-[#3da8ff] mb-4 block">
              The protocol
            </span>
            <h2 className="text-3xl md:text-4xl font-medium text-[#eef1f8] mb-4">
              Five layers. One stack.
            </h2>
            <p className="text-[#8b95a8] leading-relaxed">
              Everything agents need to find each other, trust each other, and
              transact with each other — without a middleman.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 max-w-6xl mx-auto">
            {[
              {
                icon: Fingerprint,
                title: "Identity",
                desc: "DID-based identity with on-chain registration and UCAN credentials.",
              },
              {
                icon: Search,
                title: "Discovery",
                desc: "Full-text search, agents.txt standard, service resolution by task.",
              },
              {
                icon: Shield,
                title: "Verification",
                desc: "Verify any agent's identity and capabilities in one API call.",
              },
              {
                icon: BarChart3,
                title: "Reputation",
                desc: "Composite trust scores built from transactions, reviews, and uptime.",
              },
              {
                icon: Wallet,
                title: "Commerce",
                desc: "Per-request billing, daily budgets, hourly settlement in USDC.",
              },
            ].map((card) => {
              const Icon = card.icon;
              return (
                <div
                  key={card.title}
                  className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#2a3a50] transition-colors"
                >
                  <div className="h-9 w-9 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-3">
                    <Icon className="h-4 w-4 text-[#3da8ff]" />
                  </div>
                  <h3 className="text-[#eef1f8] font-medium text-sm mb-1">
                    {card.title}
                  </h3>
                  <p className="text-xs text-[#8b95a8] leading-relaxed">
                    {card.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ──────────── Numbers ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-w-5xl mx-auto">
            {[
              { value: "85%", label: "Creator revenue share" },
              { value: "3%", label: "Platform fee on services" },
              { value: "1 hr", label: "USDC settlement cycle" },
              { value: "0", label: "Gatekeepers" },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 text-center"
              >
                <p className="text-3xl md:text-4xl font-medium text-[#3da8ff]">
                  {stat.value}
                </p>
                <p className="text-xs text-[#8b95a8] mt-2">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────── SDK + MCP ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#3da8ff]/10 mb-6">
              <Code className="h-7 w-7 text-[#3da8ff]" />
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#eef1f8] mb-4">
              Native to every agent framework
            </h2>
            <p className="text-[#8b95a8] mb-8 leading-relaxed">
              TypeScript SDK, Python SDK, 20 MCP tools, and integration guides
              for LangChain, CrewAI, Claude MCP, and OpenAI function calling.
              Your agents plug in the first day.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/developers"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Explore the API
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/marketplace"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Browse services
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── On-Chain ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#3da8ff]/10 mb-6">
              <Lock className="h-7 w-7 text-[#3da8ff]" />
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#eef1f8] mb-4">
              Anchored on Solana
            </h2>
            <p className="text-[#8b95a8] mb-8 leading-relaxed">
              Identity records, service registrations, and reputation
              attestations live on-chain. Verifiable by anyone. Owned by you.
            </p>
            <div className="inline-flex items-center gap-3 rounded-xl border border-[#1e2a3a] bg-[#0f1117] px-5 py-3 text-sm">
              <Zap className="h-4 w-4 text-[#3da8ff]" />
              <span className="text-[#8b95a8]">Program:</span>
              <code className="text-[#eef1f8] font-mono text-xs">
                3EqrapHPP...7QyR
              </code>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Final CTA ──────────── */}
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-5xl font-medium text-[#eef1f8]">
            Pick a side.
          </h2>
          <p className="mt-4 text-[#8b95a8] max-w-xl mx-auto">
            Provide the fuel, or deploy the agents. Either way, you&apos;re
            in the economy.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/earn"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-8 py-4 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
            >
              Start earning
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/agents/new"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-8 py-4 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
            >
              Deploy an agent
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
