"use client";

import Link from "next/link";
import {
  Globe,
  Shield,
  CreditCard,
  ArrowRight,
  Zap,
  Search,
  DollarSign,
  Settings,
} from "lucide-react";

const valueProps = [
  {
    icon: Globe,
    title: "Registry + Discovery",
    desc: "List your API in the SAID service registry. Agents find you via full-text search, category filters, and the agents.txt standard.",
  },
  {
    icon: Shield,
    title: "Agent Verification",
    desc: "Verify agent identity and capabilities with a single API call. UCAN-based auth brokering \u2014 no implementation needed on your side.",
  },
  {
    icon: CreditCard,
    title: "Billing-as-a-Service",
    desc: "We meter usage, enforce budgets, and settle payments. You get a revenue dashboard. 3% platform fee.",
  },
];

const steps = [
  {
    icon: Settings,
    title: "Register your API",
    desc: "Set base URL, endpoints, auth type",
  },
  {
    icon: DollarSign,
    title: "Set pricing",
    desc: "Per-request, per-minute, or per-token in USDC",
  },
  {
    icon: Search,
    title: "Get discovered",
    desc: "Agents find you via search, resolution, or agents.txt",
  },
  {
    icon: Zap,
    title: "Get paid",
    desc: "Hourly settlement batches, revenue dashboard",
  },
];

export default function ProvidePage() {
  return (
    <div className="min-h-screen bg-[#08090d]">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 pt-32 pb-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-[#eef1f8] sm:text-5xl">
          Build a Headless Merchant
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-[#8b95a8]">
          Register your API, set per-request pricing, and let AI agents discover
          and pay you automatically.
        </p>
      </section>

      {/* Value Props */}
      <section className="mx-auto max-w-5xl px-4 pb-20">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {valueProps.map((vp) => {
            const Icon = vp.icon;
            return (
              <div
                key={vp.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 transition-colors hover:bg-[#161822]"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#3da8ff]/10">
                  <Icon className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-[#eef1f8]">
                  {vp.title}
                </h3>
                <p className="text-sm leading-relaxed text-[#8b95a8]">
                  {vp.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* How it Works */}
      <section className="mx-auto max-w-4xl px-4 pb-20">
        <h2 className="mb-10 text-center text-2xl font-bold text-[#eef1f8]">
          How it Works
        </h2>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="relative text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-[#1e2a3a] bg-[#0f1117] text-lg font-bold text-[#3da8ff]">
                  {i + 1}
                </div>
                <div className="mb-2 flex items-center justify-center gap-2">
                  <Icon className="h-4 w-4 text-[#3da8ff]" />
                  <h3 className="font-semibold text-[#eef1f8]">
                    {step.title}
                  </h3>
                </div>
                <p className="text-sm text-[#8b95a8]">{step.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* CTAs */}
      <section className="mx-auto max-w-md px-4 pb-32 text-center">
        <Link
          href="/merchant/register"
          className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] transition-colors hover:bg-[#5bb8ff]"
        >
          Register Your Service <ArrowRight className="h-4 w-4" />
        </Link>
        <div className="mt-4">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-1 text-sm text-[#8b95a8] transition-colors hover:text-[#eef1f8]"
          >
            Browse the Marketplace <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>
    </div>
  );
}
