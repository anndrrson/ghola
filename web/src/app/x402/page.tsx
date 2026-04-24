"use client";

import Link from "next/link";
import {
  ArrowRight,
  Code,
  Coins,
  Shield,
  Zap,
  CheckCircle2,
  Server,
} from "lucide-react";

const features = [
  {
    icon: CheckCircle2,
    title: "Spec-compliant 402 challenges",
    desc: "Hit any paid Ghola merchant unpaid; you get an HTTP 402 with the standard accepts body — scheme, network, payTo, asset, amount, the works.",
  },
  {
    icon: Coins,
    title: "Solana mainnet USDC",
    desc: "Settlement happens in USDC on Solana, verified on-chain by the gateway before the upstream call is made.",
  },
  {
    icon: Shield,
    title: "Replay-protected",
    desc: "Every payment signature is consumed exactly once across the gateway. Burn it twice, get rejected.",
  },
  {
    icon: Zap,
    title: "Refund on upstream failure",
    desc: "If the merchant's origin times out or 5xxs, the gateway returns 504 with X-Payment-Refund. Your client voids the inbound payment automatically.",
  },
];

export default function X402Page() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
          <span className="h-2 w-2 rounded-full bg-[#3da8ff] animate-pulse" />
          x402-compliant · Solana mainnet · Live
        </div>
        <h1 className="text-4xl md:text-6xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
          Ghola speaks
          <br />
          <span className="text-[#3da8ff]">x402.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
          Any standard x402 client can discover, pay, and call Ghola merchants
          — no Ghola-specific SDK required. The gateway returns spec-compliant
          402 challenges and verifies USDC payments on-chain.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/marketplace"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
          >
            Browse merchants
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/developers"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
          >
            Developer docs
          </Link>
        </div>
      </section>

      {/* Try it */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#3da8ff]/10 mb-5">
            <Code className="h-6 w-6 text-[#3da8ff]" />
          </div>
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Try the challenge.
          </h2>
          <p className="text-[#8b95a8]">
            Hit any paid Ghola merchant unpaid. You&apos;ll see a spec-shaped
            402.
          </p>
        </div>

        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] overflow-hidden">
          <div className="border-b border-[#1e2a3a] px-5 py-3 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-[#8b95a8] font-medium">
              Request
            </span>
            <span className="text-xs text-[#3da8ff] font-mono">curl</span>
          </div>
          <pre className="p-5 overflow-x-auto text-xs text-[#eef1f8] font-mono leading-relaxed">
{`curl -i https://ghola-gateway.onrender.com/m/<merchant-slug>/`}
          </pre>
        </div>

        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] overflow-hidden mt-4">
          <div className="border-b border-[#1e2a3a] px-5 py-3 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-[#8b95a8] font-medium">
              Response
            </span>
            <span className="text-xs text-[#3da8ff] font-mono">
              HTTP/1.1 402 Payment Required
            </span>
          </div>
          <pre className="p-5 overflow-x-auto text-xs text-[#eef1f8] font-mono leading-relaxed">
{`{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana:mainnet",
      "maxAmountRequired": "1000",
      "resource": "https://ghola-gateway.onrender.com/m/<slug>/",
      "description": "Ghola merchant: <slug>",
      "mimeType": "application/json",
      "payTo": "<escrow-wallet-address>",
      "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": {
        "merchant_slug": "<slug>",
        "platform_fee_bps": 300
      }
    }
  ]
}`}
          </pre>
        </div>

        <p className="text-sm text-[#8b95a8] text-center mt-6 leading-relaxed">
          Your client signs a USDC transfer to <code className="text-[#3da8ff] text-xs">payTo</code>,
          base64-encodes the proof, and retries with{" "}
          <code className="text-[#3da8ff] text-xs">x402-Payment</code>. The
          gateway verifies on-chain, then forwards your call.
        </p>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Production-grade x402.
          </h2>
          <p className="text-[#8b95a8]">
            Not a demo. The gateway is live, on mainnet, settling real USDC.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {features.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6"
              >
                <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
                  <Icon className="h-5 w-5 text-[#3da8ff]" />
                </div>
                <h3 className="text-[#eef1f8] font-medium mb-2">{f.title}</h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  {f.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* For builders */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8">
            <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
              <Server className="h-5 w-5 text-[#3da8ff]" />
            </div>
            <h3 className="text-xl font-medium text-[#eef1f8] mb-3">
              Selling? Register your API.
            </h3>
            <p className="text-sm text-[#8b95a8] leading-relaxed mb-6">
              Set a price, point to your origin, and let any x402 client in
              the world discover and pay you. We handle metering, settlement,
              and refunds on upstream failure.
            </p>
            <Link
              href="/provide"
              className="inline-flex items-center gap-2 text-[#3da8ff] hover:text-[#5bb8ff] text-sm font-medium"
            >
              Become a merchant <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8">
            <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
              <Code className="h-5 w-5 text-[#3da8ff]" />
            </div>
            <h3 className="text-xl font-medium text-[#eef1f8] mb-3">
              Building agents? Just speak x402.
            </h3>
            <p className="text-sm text-[#8b95a8] leading-relaxed mb-6">
              No Ghola SDK required. Any x402 client (Coinbase Agent Kit,
              Anthropic-compatible, custom) can hit our gateway, parse the
              challenge, sign the USDC transfer, and retry.
            </p>
            <Link
              href="/developers"
              className="inline-flex items-center gap-2 text-[#3da8ff] hover:text-[#5bb8ff] text-sm font-medium"
            >
              Read the docs <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-4">
          Open standards, on-chain settlement.
        </h2>
        <p className="text-[#8b95a8] max-w-xl mx-auto mb-8">
          x402 + Solana + USDC. The agent commerce stack, no walled gardens.
        </p>
        <Link
          href="/marketplace"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
        >
          Browse merchants
          <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
    </div>
  );
}
