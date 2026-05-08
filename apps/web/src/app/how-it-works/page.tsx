"use client";

import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Search,
  Shield,
  Zap,
  Coins,
  Fingerprint,
  BarChart3,
  CreditCard,
  Cpu,
  Sparkles,
  Store,
} from "lucide-react";

const flow = [
  {
    n: 1,
    icon: Bot,
    title: "Agent receives a task",
    desc: "A user asks their agent to do something — book a flight, summarize a legal doc, run a research pass — or another agent delegates it.",
  },
  {
    n: 2,
    icon: Search,
    title: "Agent resolves providers",
    desc: "The Ghola registry returns matching compute nodes, models, and services, ranked by task fit, price, latency, and reputation.",
  },
  {
    n: 3,
    icon: Shield,
    title: "Identities verified",
    desc: "Both sides check each other's SAID credentials, on-chain registration, and reputation scores before committing.",
  },
  {
    n: 4,
    icon: Zap,
    title: "Work executes",
    desc: "The agent routes its call. Compute spins up, the model thinks, the service acts. The result returns over the same auth channel.",
  },
  {
    n: 5,
    icon: Coins,
    title: "USDC settles",
    desc: "Per-call metering triggers settlement. USDC moves from the agent's wallet to the provider's wallet, batched hourly on Solana.",
  },
  {
    n: 6,
    icon: BarChart3,
    title: "Reputation updates",
    desc: "A successful call bumps everyone's score on-chain. Failed calls don't. Reputation compounds, routing gets smarter, bad actors lose volume.",
  },
];

const suppliers = [
  {
    icon: Cpu,
    name: "Compute operators",
    earn: "Per-call inference fees (85%)",
    spec: "Phones, consumer GPUs, data-center hardware",
  },
  {
    icon: Sparkles,
    name: "Model creators",
    earn: "Per-call model royalty (85%)",
    spec: "Fine-tunes, specialty models, frontier weights",
  },
  {
    icon: Store,
    name: "Service merchants",
    earn: "Per-call API revenue (97%)",
    spec: "Any API registered in the SAID registry",
  },
];

const demand = [
  {
    icon: Bot,
    name: "Consumer agents",
    spend: "Whatever they need to finish the job",
    spec: "Personal assistants, research agents, task bots",
  },
  {
    icon: Fingerprint,
    name: "Autonomous services",
    spend: "Whatever their budget allows",
    spec: "Agents that schedule, negotiate, buy, trade",
  },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
          <Zap className="h-3.5 w-3.5 text-[#3da8ff]" />
          The flywheel
        </div>
        <h1 className="text-4xl md:text-6xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
          How the agent
          <br />
          <span className="text-[#3da8ff]">economy turns.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
          Every agent action pays someone. Here&apos;s the full loop — from
          the moment an agent gets a task to the second the USDC settles.
        </p>
      </section>

      {/* Six-step flow */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 pb-16">
        <div className="space-y-3">
          {flow.map((step) => {
            const Icon = step.icon;
            return (
              <div
                key={step.n}
                className="flex gap-5 items-start rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6"
              >
                <div className="flex flex-col items-center gap-2 shrink-0">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-sm font-medium text-[#3da8ff]">
                    {step.n}
                  </span>
                  <Icon className="h-4 w-4 text-[#3da8ff]" />
                </div>
                <div>
                  <h3 className="text-[#eef1f8] font-medium mb-2">
                    {step.title}
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed">
                    {step.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Who earns / who spends */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <span className="text-sm font-medium text-[#3da8ff] mb-3 block">
              Supply side
            </span>
            <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-6">
              Who earns
            </h2>
            <div className="space-y-3">
              {suppliers.map((s) => {
                const Icon = s.icon;
                return (
                  <div
                    key={s.name}
                    className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
                  >
                    <div className="flex items-start gap-4">
                      <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center shrink-0">
                        <Icon className="h-5 w-5 text-[#3da8ff]" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[#eef1f8] font-medium mb-1">
                          {s.name}
                        </h4>
                        <p className="text-xs text-[#3da8ff] font-mono mb-2">
                          {s.earn}
                        </p>
                        <p className="text-xs text-[#8b95a8] leading-relaxed">
                          {s.spec}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <span className="text-sm font-medium text-[#3da8ff] mb-3 block">
              Demand side
            </span>
            <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-6">
              Who spends
            </h2>
            <div className="space-y-3">
              {demand.map((d) => {
                const Icon = d.icon;
                return (
                  <div
                    key={d.name}
                    className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
                  >
                    <div className="flex items-start gap-4">
                      <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center shrink-0">
                        <Icon className="h-5 w-5 text-[#3da8ff]" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-[#eef1f8] font-medium mb-1">
                          {d.name}
                        </h4>
                        <p className="text-xs text-[#3da8ff] font-mono mb-2">
                          {d.spend}
                        </p>
                        <p className="text-xs text-[#8b95a8] leading-relaxed">
                          {d.spec}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Primitives */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            The primitives underneath.
          </h2>
          <p className="text-[#8b95a8]">
            What every Ghola participant inherits from the protocol.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Fingerprint,
              title: "SAID identity",
              desc: "Cryptographic identity with on-chain registration.",
            },
            {
              icon: Shield,
              title: "UCAN delegation",
              desc: "Delegate scoped permissions without sharing keys.",
            },
            {
              icon: BarChart3,
              title: "Reputation",
              desc: "Composite scores built from transactions and attestations.",
            },
            {
              icon: CreditCard,
              title: "USDC settlement",
              desc: "Per-call billing, hourly batched, fully on-chain.",
            },
          ].map((p) => {
            const Icon = p.icon;
            return (
              <div
                key={p.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
              >
                <div className="h-9 w-9 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-3">
                  <Icon className="h-4 w-4 text-[#3da8ff]" />
                </div>
                <h3 className="text-[#eef1f8] font-medium text-sm mb-1">
                  {p.title}
                </h3>
                <p className="text-xs text-[#8b95a8] leading-relaxed">
                  {p.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-4">
          Pick your side of the flywheel.
        </h2>
        <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
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
            Deploy an agent
          </Link>
        </div>
      </section>
    </div>
  );
}
