"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Shield,
  Search,
  CreditCard,
  Globe,
  Fingerprint,
  Zap,
  Code,
  BarChart3,
  Lock,
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

  // Don't block rendering for auth check — show the landing page immediately
  // Only redirect authenticated users after auth finishes loading

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

  if (authenticated && !loading) return null; // Only hide page AFTER confirming auth

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
              Cryptographic identities for AI agents · on Solana
            </div>
            <h1 className="text-5xl md:text-7xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
              The AI that
              <br />
              <span className="text-[#3da8ff]">actually uses</span>
              <br />
              your apps.
            </h1>
            <p className="mt-8 text-lg md:text-xl text-[#8b95a8] leading-relaxed max-w-2xl">
              Ghola&apos;s agent taps, types, and navigates other apps on your
              phone — and pays for what it does with its own on-chain wallet,
              not yours.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4">
              <Link
                href="/agents/new"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Create an agent
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/marketplace"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                See the marketplace
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Protocol Layers ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-medium text-[#eef1f8] mb-4 text-center">
            Five layers. One protocol.
          </h2>
          <p className="text-[#8b95a8] mb-12 text-center max-w-lg mx-auto">
            Everything agents need to do business with strangers.
          </p>
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
                icon: CreditCard,
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

      {/* ──────────── For Agents ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="text-sm font-medium text-[#3da8ff] mb-4 block">
                For AI Agents
              </span>
              <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
                Find services. Prove identity. Pay per request.
              </h2>
              <p className="text-[#8b95a8] mb-8 leading-relaxed">
                Your agent searches the registry, verifies the merchant,
                calls the API, and pays — all in a single flow.
                No accounts. No subscriptions. No checkout pages.
              </p>
              <Link
                href="/developers"
                className="inline-flex items-center gap-2 text-[#3da8ff] hover:text-[#5bb8ff] text-sm font-medium"
              >
                View developer docs <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="space-y-3">
              {[
                { icon: Search, label: "Resolve", desc: "Find services by task, price, quality, or trust score" },
                { icon: Shield, label: "Verify", desc: "Confirm merchant identity with UCAN credentials" },
                { icon: Globe, label: "Call", desc: "Hit the API endpoint with embedded auth" },
                { icon: CreditCard, label: "Pay", desc: "Per-request USDC settlement, enforced budgets" },
              ].map((step, i) => {
                const Icon = step.icon;
                return (
                  <div key={step.label} className="flex gap-4 items-start rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-xs font-medium text-[#3da8ff]">
                      {i + 1}
                    </span>
                    <div>
                      <h4 className="text-sm font-medium text-[#eef1f8]">{step.label}</h4>
                      <p className="text-xs text-[#8b95a8]">{step.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── For Merchants ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="order-2 lg:order-1 grid grid-cols-2 gap-4">
              {[
                { value: "3%", label: "Platform fee" },
                { value: "USDC", label: "Settlement currency" },
                { value: "1 hr", label: "Settlement cycle" },
                { value: "0", label: "Accounts to manage" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center">
                  <p className="text-2xl font-medium text-[#3da8ff]">{stat.value}</p>
                  <p className="text-xs text-[#8b95a8] mt-1">{stat.label}</p>
                </div>
              ))}
            </div>
            <div className="order-1 lg:order-2">
              <span className="text-sm font-medium text-[#3da8ff] mb-4 block">
                For Headless Merchants
              </span>
              <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
                Register your API. Get discovered. Get paid.
              </h2>
              <p className="text-[#8b95a8] mb-8 leading-relaxed">
                No storefront. No checkout flow. No sales team.
                Just your API, a price per call, and an endpoint.
                We handle metering, billing, and settlement.
              </p>
              <Link
                href="/provide"
                className="inline-flex items-center gap-2 text-[#3da8ff] hover:text-[#5bb8ff] text-sm font-medium"
              >
                Become a merchant <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
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
            <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
              Native to every agent framework
            </h2>
            <p className="text-[#8b95a8] mb-8 leading-relaxed">
              TypeScript SDK, Python SDK, 20 MCP tools, and integration guides
              for LangChain, CrewAI, Claude MCP, and OpenAI function calling.
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
            <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
              Anchored on Solana
            </h2>
            <p className="text-[#8b95a8] mb-8 leading-relaxed">
              Identity records, service registrations, and reputation attestations
              live on-chain. Verifiable by anyone. Owned by you.
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
          <h2 className="text-3xl md:text-4xl font-medium text-[#eef1f8]">
            Stop typing. Let your agent do it.
          </h2>
          <p className="mt-4 text-[#8b95a8] max-w-xl mx-auto">
            Opens apps. Books rides. Sends emails. Cancels subscriptions.
            Pays its own way in USDC — no credit card, no shared wallet,
            no begging the AI to stop refusing.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/agents/new"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-8 py-4 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
            >
              Create an agent
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/marketplace"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-8 py-4 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
            >
              See the marketplace
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
