"use client";

import Link from "next/link";
import {
  ArrowRight,
  Cpu,
  Sparkles,
  Store,
  Coins,
  Shield,
  Zap,
} from "lucide-react";

const sides = [
  {
    icon: Cpu,
    title: "Run compute",
    tag: "For device & node operators",
    desc: "Host inference on your phone, GPU, or server. Earn USDC every time an agent routes a call through your node.",
    bullets: [
      "Phones, consumer GPUs, and data-center hardware all supported",
      "Pricing set by node — Ghola matches agents by price, latency, and reputation",
      "85% of per-call revenue to the operator, 15% protocol fee",
    ],
    cta: "Host a node",
    href: "/earn/compute",
  },
  {
    icon: Sparkles,
    title: "Publish a model",
    tag: "For AI creators",
    desc: "Fine-tune and ship a model under your name. Agents find it, call it, and pay per inference — you earn per call.",
    bullets: [
      "Fine-tune from your data or bring a model you own",
      "Your model gets an on-chain identity and reputation score",
      "85% revenue share, hourly USDC settlement",
    ],
    cta: "Publish a model",
    href: "/models/creator",
  },
  {
    icon: Store,
    title: "Sell a service",
    tag: "For API operators & businesses",
    desc: "Register your API as a headless merchant. Agents discover you, verify you, and pay per call — no checkout, no accounts.",
    bullets: [
      "Per-request, per-minute, or per-token pricing in USDC",
      "We handle metering, auth, and settlement — you get a revenue dashboard",
      "3% platform fee, hourly settlement",
    ],
    cta: "Register a service",
    href: "/provide",
  },
];

const principles = [
  {
    icon: Coins,
    title: "USDC settlement",
    desc: "Every transaction settles in USDC on Solana, per-call, hourly batched.",
  },
  {
    icon: Shield,
    title: "On-chain reputation",
    desc: "Every call builds your score. No gatekeepers can take it from you.",
  },
  {
    icon: Zap,
    title: "Open protocol",
    desc: "Built on SAID. Anyone can plug in, anyone can fork, no walled gardens.",
  },
];

export default function EarnPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
          <span className="h-2 w-2 rounded-full bg-[#3da8ff] animate-pulse" />
          The supply side of the agent economy
        </div>
        <h1 className="text-4xl md:text-6xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
          Get paid when
          <br />
          <span className="text-[#3da8ff]">AI gets to work.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
          Agents need compute, models, and services to act in the real world.
          Supply one — and earn every time they use it.
        </p>
      </section>

      {/* Three sides */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-16">
        <div className="grid gap-6 lg:grid-cols-3">
          {sides.map((side) => {
            const Icon = side.icon;
            return (
              <div
                key={side.title}
                className="rounded-2xl border border-[#1e2a3a] bg-[#0f1117] p-8 flex flex-col"
              >
                <div className="h-12 w-12 rounded-xl bg-[#3da8ff]/10 flex items-center justify-center mb-5">
                  <Icon className="h-6 w-6 text-[#3da8ff]" />
                </div>
                <span className="text-[11px] uppercase tracking-wider text-[#8b95a8] font-medium mb-2">
                  {side.tag}
                </span>
                <h2 className="text-xl font-medium text-[#eef1f8] mb-3">
                  {side.title}
                </h2>
                <p className="text-sm text-[#8b95a8] leading-relaxed mb-6">
                  {side.desc}
                </p>
                <ul className="space-y-2 mb-8 flex-1">
                  {side.bullets.map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-2 text-xs text-[#8b95a8] leading-relaxed"
                    >
                      <span className="mt-1.5 h-1 w-1 rounded-full bg-[#3da8ff] shrink-0" />
                      {b}
                    </li>
                  ))}
                </ul>
                <Link
                  href={side.href}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-5 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
                >
                  {side.cta}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      {/* Principles */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Same rules. Every side.
          </h2>
          <p className="text-[#8b95a8]">
            Whatever you supply, you get the same economic primitives.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3 max-w-5xl mx-auto">
          {principles.map((p) => {
            const Icon = p.icon;
            return (
              <div
                key={p.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6"
              >
                <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
                  <Icon className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <h3 className="text-[#eef1f8] font-medium mb-2">{p.title}</h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
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
          Not sure where to start?
        </h2>
        <p className="text-[#8b95a8] max-w-xl mx-auto mb-8">
          Start with what you already have. Phone in your pocket? Run compute.
          A model you&apos;ve fine-tuned? Publish it. An API? Register it.
        </p>
        <Link
          href="/how-it-works"
          className="inline-flex items-center gap-2 text-[#3da8ff] hover:text-[#5bb8ff] text-sm font-medium"
        >
          See how the full flywheel works
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </section>
    </div>
  );
}
