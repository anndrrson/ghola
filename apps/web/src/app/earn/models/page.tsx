"use client";

import Link from "next/link";
import {
  ArrowRight,
  Sparkles,
  Upload,
  Coins,
  TrendingUp,
  Users,
  Shield,
} from "lucide-react";

const valueProps = [
  {
    icon: Coins,
    title: "85% revenue share",
    desc: "Every time an agent calls your model, 85% of the inference fee lands in your wallet. Hourly USDC settlement.",
  },
  {
    icon: Shield,
    title: "On-chain ownership",
    desc: "Your model gets a SAID identity and on-chain registration. Usage, reputation, and revenue are yours — portable forever.",
  },
  {
    icon: Users,
    title: "Agent-native audience",
    desc: "Agents discover your model via task match, price, and quality — no SEO, no ads, no algorithm gods.",
  },
  {
    icon: TrendingUp,
    title: "Reputation compounds",
    desc: "Every successful call raises your score. Higher scores win more routing. The flywheel turns itself.",
  },
];

const steps = [
  {
    n: 1,
    icon: Upload,
    title: "Bring or fine-tune a model",
    desc: "Upload a model you own, or fine-tune on your data using the creator dashboard.",
  },
  {
    n: 2,
    icon: Sparkles,
    title: "Publish to the registry",
    desc: "Set your price per 1M tokens, tag your model's domain, and go live.",
  },
  {
    n: 3,
    icon: Users,
    title: "Agents find you",
    desc: "The router matches agent tasks to your model based on specialty, cost, and reputation.",
  },
  {
    n: 4,
    icon: Coins,
    title: "Earn per call",
    desc: "USDC settles hourly. Watch your revenue dashboard. Ship improvements. Keep earning.",
  },
];

export default function EarnModelsPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
          <Sparkles className="h-3.5 w-3.5 text-[#3da8ff]" />
          Publish a model · earn per call
        </div>
        <h1 className="font-display text-4xl md:text-6xl font-medium text-[#eef1f8] leading-[1.04]">
          Your model,
          <br />
          <span className="text-[#3da8ff]">on salary.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
          Ship a fine-tune you&apos;re proud of. Get paid every time an agent
          calls it. No gatekeepers, no platform politics — just the model,
          the agent, and the wallet in between.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/models/creator"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
          >
            Open the creator dashboard
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/models"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
          >
            Browse published models
          </Link>
        </div>
      </section>

      {/* Value props */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="font-display text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            The creator economy, for AI.
          </h2>
          <p className="text-[#8b95a8]">
            What Substack did for writers and Patreon did for artists — Ghola
            does for model builders.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {valueProps.map((vp) => {
            const Icon = vp.icon;
            return (
              <div
                key={vp.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6"
              >
                <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
                  <Icon className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <h3 className="text-[#eef1f8] font-medium mb-2">{vp.title}</h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  {vp.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Steps */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="font-display text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            From weights to wallet.
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {steps.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.n}
                className="flex gap-4 items-start rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-sm font-medium text-[#3da8ff]">
                  {s.n}
                </span>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className="h-3.5 w-3.5 text-[#3da8ff]" />
                    <h4 className="text-sm font-medium text-[#eef1f8]">
                      {s.title}
                    </h4>
                  </div>
                  <p className="text-xs text-[#8b95a8] leading-relaxed">
                    {s.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="font-display text-2xl md:text-3xl font-medium text-[#eef1f8] mb-4">
          Publish your first model.
        </h2>
        <Link
          href="/models/creator"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
        >
          Open the creator dashboard
          <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
    </div>
  );
}
