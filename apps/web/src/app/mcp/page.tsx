"use client";

import Link from "next/link";
import {
  ArrowRight,
  Fingerprint,
  Search,
  CreditCard,
  Lock,
  BarChart3,
  Brain,
  Code,
  Sparkles,
} from "lucide-react";

const categories = [
  {
    icon: Brain,
    title: "Identity & context",
    count: "9 tools",
    desc: "System prompt, preferences, memories, knowledge, conversation context, MCP configs, relevant context, observation.",
    tools: [
      "said_get_system_prompt",
      "said_get_preferences",
      "said_search_memories",
      "said_add_memory",
      "said_search_knowledge",
      "said_get_conversation_context",
      "said_list_mcp_configs",
      "said_get_relevant_context",
      "said_observe",
    ],
  },
  {
    icon: Search,
    title: "Discovery",
    count: "8 tools",
    desc: "Look up identities, discover businesses, fetch agents.txt, get public profiles, search and evaluate services.",
    tools: [
      "said_lookup_identity",
      "said_discover_business",
      "said_fetch_agents_txt",
      "said_get_public_profile",
      "said_request_service",
      "said_search_services",
      "said_get_service",
      "said_discover_services",
    ],
  },
  {
    icon: CreditCard,
    title: "Payments",
    count: "12 tools",
    desc: "Wallet balance, address transfers, agent payments, history, limits, x402 integration, spending status.",
    tools: [
      "said_pay_balance",
      "said_pay_address",
      "said_pay_transfer",
      "said_pay_agents",
      "said_pay_create_agent",
      "said_pay_history",
      "said_pay_limits",
      "said_spending_status",
      "said_pay_x402",
      "said_verify_x402_merchant",
      "said_call_service",
      "said_discover_and_pay",
    ],
  },
  {
    icon: Lock,
    title: "Secrets vault",
    count: "4 tools",
    desc: "Encrypted credential storage scoped per agent — get, set, list, remove.",
    tools: [
      "said_get_secret",
      "said_set_secret",
      "said_list_secrets",
      "said_remove_secret",
    ],
  },
  {
    icon: Fingerprint,
    title: "Trust & reputation",
    count: "3 tools",
    desc: "Verify agent identity, fetch trust scores, evaluate services before transacting.",
    tools: [
      "said_verify_agent",
      "said_trust_score",
      "said_evaluate_service",
    ],
  },
  {
    icon: BarChart3,
    title: "Enterprise & audit",
    count: "4 tools",
    desc: "Audit logs, treasury status, multi-sig approvals, subscription management.",
    tools: [
      "said_audit_log",
      "said_treasury_status",
      "said_request_approval",
      "said_subscribe_service",
    ],
  },
];

export default function McpPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-8">
          <span className="h-2 w-2 rounded-full bg-[#3da8ff] animate-pulse" />
          40 MCP tools · live · works with Claude, OpenAI, LangChain
        </div>
        <h1 className="text-4xl md:text-6xl font-medium tracking-tight text-[#eef1f8] leading-[1.04]">
          Drop Ghola
          <br />
          <span className="text-[#3da8ff]">into your agent.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
          Native Model Context Protocol support. 40 tools across identity,
          discovery, payments, secrets, and reputation. Plug Ghola into Claude,
          Claude Code, OpenAI, LangChain, CrewAI — anything that speaks MCP.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/developers"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
          >
            Quickstart
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/marketplace"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
          >
            Browse marketplace
          </Link>
        </div>
      </section>

      {/* Quick-add */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#3da8ff]/10 mb-5">
            <Code className="h-6 w-6 text-[#3da8ff]" />
          </div>
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Add to Claude in one step.
          </h2>
        </div>

        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] overflow-hidden">
          <div className="border-b border-[#1e2a3a] px-5 py-3 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-[#8b95a8] font-medium">
              ~/.claude/config.json
            </span>
            <span className="text-xs text-[#3da8ff] font-mono">JSON</span>
          </div>
          <pre className="p-5 overflow-x-auto text-xs text-[#eef1f8] font-mono leading-relaxed">
{`{
  "mcpServers": {
    "ghola": {
      "command": "ghola-mcp",
      "args": ["serve", "--stdio"]
    }
  }
}`}
          </pre>
        </div>

        <p className="text-sm text-[#8b95a8] text-center mt-6 leading-relaxed">
          Or remote with UCAN-scoped capabilities for delegated agent access.
          Same 40 tools, capability-bounded.
        </p>
      </section>

      {/* Tool categories */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            40 tools. Six categories.
          </h2>
          <p className="text-[#8b95a8]">
            Everything an agent needs to identify itself, find counterparts,
            transact, and remember.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {categories.map((cat) => {
            const Icon = cat.icon;
            return (
              <div
                key={cat.title}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 flex flex-col"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center">
                    <Icon className="h-5 w-5 text-[#3da8ff]" />
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-[#3da8ff] font-medium">
                    {cat.count}
                  </span>
                </div>
                <h3 className="text-[#eef1f8] font-medium mb-2">{cat.title}</h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed mb-4 flex-1">
                  {cat.desc}
                </p>
                <details className="text-xs">
                  <summary className="cursor-pointer text-[#3da8ff] hover:text-[#5bb8ff] font-medium">
                    View tools
                  </summary>
                  <ul className="mt-3 space-y-1 font-mono text-[#8b95a8]">
                    {cat.tools.map((t) => (
                      <li key={t} className="leading-relaxed">
                        {t}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            );
          })}
        </div>
      </section>

      {/* Compatibility */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 border-t border-[#1e2a3a]">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#3da8ff]/10 mb-5">
            <Sparkles className="h-6 w-6 text-[#3da8ff]" />
          </div>
          <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-3">
            Works with every framework.
          </h2>
        </div>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 max-w-3xl mx-auto">
          {[
            "Claude Desktop",
            "Claude Code",
            "OpenAI",
            "LangChain",
            "CrewAI",
            "Anthropic SDK",
            "rmcp (Rust)",
            "Custom MCP clients",
            "stdio + HTTP",
          ].map((label) => (
            <div
              key={label}
              className="rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-3 text-center text-sm text-[#eef1f8]"
            >
              {label}
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="text-2xl md:text-3xl font-medium text-[#eef1f8] mb-4">
          Native to every agent that matters.
        </h2>
        <Link
          href="/developers"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
        >
          Get the SDK
          <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
    </div>
  );
}
