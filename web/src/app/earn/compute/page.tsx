"use client";

import Link from "next/link";
import {
  ArrowRight,
  Cpu,
  Smartphone,
  Server,
  Zap,
  Coins,
  Shield,
} from "lucide-react";

const hardware = [
  {
    icon: Smartphone,
    title: "Phones",
    desc: "Android devices with Ghola installed can run small-model inference when idle. Best for low-latency edge jobs.",
    spec: "~4–8 GB RAM · on-device models",
  },
  {
    icon: Cpu,
    title: "Consumer GPUs",
    desc: "Desktops with a 3090/4090/5090 or Apple Silicon Max/Ultra. Great for mid-size models and fine-tuning inference.",
    spec: "24+ GB VRAM · 7B–70B models",
  },
  {
    icon: Server,
    title: "Data-center hardware",
    desc: "H100/H200 clusters, MI300X, anything you&apos;d rent on Lambda or Vast. Serve frontier models to the network.",
    spec: "80+ GB VRAM · 100B+ models",
  },
];

const steps = [
  {
    n: 1,
    title: "Install the Ghola node",
    desc: "One command on Linux/macOS/Windows. For phones, the Ghola app handles it.",
  },
  {
    n: 2,
    title: "Register on-chain",
    desc: "Your node gets a SAID identity. Agents discover you via registry + model match.",
  },
  {
    n: 3,
    title: "Set pricing",
    desc: "Price per 1M tokens or per call. The router matches agents by price, latency, and reputation.",
  },
  {
    n: 4,
    title: "Serve and earn",
    desc: "Agents route calls to you. USDC settles hourly to your wallet. 85% to you, 15% protocol.",
  },
];

export default function EarnComputePage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
          <Cpu className="h-3.5 w-3.5 text-[#3da8ff]" />
          Run compute · earn USDC
        </div>
        <h1 className="text-4xl md:text-6xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
          Your hardware,
          <br />
          <span className="text-[#3da8ff]">on the job.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
          Host inference for the agent economy. Phones, GPUs, or clusters —
          the Ghola router pays you every time an agent picks your node.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/signup?intent=node_operator"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
          >
            Start a node
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/developers"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
          >
            Read the docs
          </Link>
        </div>
      </section>

      {/* Hardware tiers */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Any hardware. Any scale.
          </h2>
          <p className="text-[#8b95a8]">
            Big or small, the router finds work for it.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3 max-w-5xl mx-auto">
          {hardware.map((h) => {
            const Icon = h.icon;
            return (
              <div
                key={h.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6"
              >
                <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
                  <Icon className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <h3 className="text-[#eef1f8] font-medium mb-2">{h.title}</h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed mb-4">
                  {h.desc}
                </p>
                <div className="text-[11px] uppercase tracking-wider text-[#3da8ff] font-mono">
                  {h.spec}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Steps */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Four steps to live.
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {steps.map((s) => (
            <div
              key={s.n}
              className="flex gap-4 items-start rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-sm font-medium text-[#3da8ff]">
                {s.n}
              </span>
              <div>
                <h4 className="text-sm font-medium text-[#eef1f8] mb-1">
                  {s.title}
                </h4>
                <p className="text-xs text-[#8b95a8] leading-relaxed">
                  {s.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Economics strip */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Coins, value: "85%", label: "Operator revenue" },
            { icon: Zap, value: "1 hr", label: "Settlement cycle" },
            { icon: Shield, value: "USDC", label: "Paid in stables" },
            { icon: Cpu, value: "24/7", label: "Router coverage" },
          ].map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center"
              >
                <Icon className="h-4 w-4 text-[#3da8ff] mx-auto mb-2" />
                <p className="text-2xl font-medium text-[#eef1f8]">{stat.value}</p>
                <p className="text-[11px] text-[#8b95a8] mt-1 uppercase tracking-wider">
                  {stat.label}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-4">
          Ready to route?
        </h2>
        <Link
          href="/signup?intent=node_operator"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
        >
          Start a node
          <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
    </div>
  );
}
