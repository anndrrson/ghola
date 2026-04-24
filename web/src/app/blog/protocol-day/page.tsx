"use client";

import Link from "next/link";
import { ArrowRight, ArrowLeft, Calendar } from "lucide-react";

export default function ProtocolDayPost() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <article className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 pt-24 pb-20">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] mb-12"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>

        <div className="flex items-center gap-3 text-xs text-[#8b95a8] mb-6">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#3da8ff]/10 px-3 py-1 text-[#3da8ff] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-[#3da8ff] animate-pulse" />
            Protocol Day
          </span>
          <span className="flex items-center gap-1.5">
            <Calendar className="h-3 w-3" />
            April 14, 2026
          </span>
        </div>

        <h1 className="text-4xl md:text-5xl font-medium tracking-tight text-[#eef1f8] leading-[1.1] mb-6">
          Ghola is now <span className="text-[#3da8ff]">x402-compliant</span>,
          MCP-live, and ERC-8004 bridge-speced.
        </h1>

        <p className="text-xl text-[#8b95a8] leading-relaxed mb-12">
          Three protocol commitments, shipped today. The agent economy needs
          open standards more than it needs another walled garden — so
          here&apos;s ours, written down and live in production.
        </p>

        <div className="prose prose-invert max-w-none">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mt-12 mb-4">
            1. x402 — live on Solana mainnet
          </h2>
          <p className="text-[#8b95a8] leading-relaxed mb-4">
            The Ghola gateway now returns spec-compliant{" "}
            <code className="text-[#3da8ff] text-sm">HTTP 402 Payment Required</code>{" "}
            challenges on every paid merchant route. Hit any merchant unpaid;
            you get the standard{" "}
            <code className="text-[#3da8ff] text-sm">accepts</code> body —{" "}
            <code className="text-[#3da8ff] text-sm">scheme</code>,{" "}
            <code className="text-[#3da8ff] text-sm">network</code>,{" "}
            <code className="text-[#3da8ff] text-sm">payTo</code>,{" "}
            <code className="text-[#3da8ff] text-sm">asset</code>,{" "}
            <code className="text-[#3da8ff] text-sm">maxAmountRequired</code>.
          </p>
          <p className="text-[#8b95a8] leading-relaxed mb-4">
            Sign a USDC transfer, base64-encode the proof, retry with{" "}
            <code className="text-[#3da8ff] text-sm">x402-Payment</code>. The
            gateway verifies on-chain, charges per call, settles in USDC —
            with refund-on-failure semantics enforced via{" "}
            <code className="text-[#3da8ff] text-sm">X-Payment-Refund</code>.
          </p>
          <p className="text-[#8b95a8] leading-relaxed mb-6">
            Any standard x402 client (Coinbase Agent Kit, custom rolls)
            works. No Ghola SDK required.{" "}
            <Link
              href="/x402"
              className="text-[#3da8ff] hover:text-[#5bb8ff]"
            >
              Try it →
            </Link>
          </p>

          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mt-12 mb-4">
            2. MCP — 40 tools, live today
          </h2>
          <p className="text-[#8b95a8] leading-relaxed mb-4">
            Ghola exposes 40 Model Context Protocol tools across six
            categories: identity &amp; context, discovery, payments, secrets
            vault, trust &amp; reputation, and enterprise audit. Add a
            three-line block to <code className="text-[#3da8ff] text-sm">~/.claude/config.json</code>{" "}
            and your agent has on-chain identity, USDC payments, x402
            verification, and the entire merchant marketplace as native
            tools.
          </p>
          <p className="text-[#8b95a8] leading-relaxed mb-6">
            Built on Anthropic&apos;s rmcp 0.15. Stdio for local agents,
            HTTP+UCAN for remote with capability scoping.{" "}
            <Link
              href="/mcp"
              className="text-[#3da8ff] hover:text-[#5bb8ff]"
            >
              See all 40 tools →
            </Link>
          </p>

          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mt-12 mb-4">
            3. ERC-8004 — bridge spec published
          </h2>
          <p className="text-[#8b95a8] leading-relaxed mb-4">
            The Trustless Agents standard on Ethereum (ERC-8004) defines
            three registries — identity, reputation, validation — that
            mirror what Ghola already does on Solana via SAID. Today we
            publish the canonical mapping: how a single agent can have one
            identity that resolves natively on both chains, without forcing
            anyone onto the other&apos;s rails.
          </p>
          <p className="text-[#8b95a8] leading-relaxed mb-6">
            Spec is descriptive v0.1; reference bridge oracle is the next
            build.{" "}
            <a
              href="https://github.com/anndrrson/ghola/blob/main/spec/erc-8004-bridge.md"
              className="text-[#3da8ff] hover:text-[#5bb8ff]"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the spec →
            </a>
          </p>

          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mt-12 mb-4">
            Why ship all three at once
          </h2>
          <p className="text-[#8b95a8] leading-relaxed mb-4">
            The agent economy is a coordination problem. Identity, payments,
            and discovery have to interoperate, or every team has to
            re-invent the same primitives. We&apos;d rather lose a little
            lock-in and win a lot of compatibility.
          </p>
          <p className="text-[#8b95a8] leading-relaxed mb-4">
            x402 makes our merchants discoverable to every standard agent.
            MCP makes our identity, payment, and discovery primitives
            available to every standard framework. The ERC-8004 bridge spec
            makes Ghola identities resolvable from the Ethereum side without
            us needing to be on Ethereum.
          </p>
          <p className="text-[#8b95a8] leading-relaxed mb-12">
            One protocol, four pillars (identity, assistant, headless
            merchants, compute marketplace), three open standards. Built on
            Solana, open to everyone.
          </p>

          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8 my-12">
            <h3 className="text-xl font-medium text-[#eef1f8] mb-3">
              Try it now
            </h3>
            <p className="text-sm text-[#8b95a8] mb-6 leading-relaxed">
              Use a merchant via x402, add the MCP server to your agent, or
              read the bridge spec.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/x402"
                className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-5 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff]"
              >
                x402 quickstart
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/mcp"
                className="inline-flex items-center gap-2 rounded-lg border border-[#1e2a3a] px-5 py-2.5 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50]"
              >
                MCP tools
              </Link>
              <a
                href="https://github.com/anndrrson/ghola/blob/main/spec/erc-8004-bridge.md"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-[#1e2a3a] px-5 py-2.5 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50]"
              >
                Bridge spec
              </a>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
