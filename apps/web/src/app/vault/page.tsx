"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  ArrowRight,
  FileText,
  Brain,
  Settings,
  Key,
  Fingerprint,
  Database,
  Check,
} from "lucide-react";

export default function VaultPage() {
  const heroRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="min-h-screen pt-16">
      {/* Hero */}
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
          <div className="max-w-3xl">
            <h1 className="text-5xl md:text-7xl font-medium tracking-tight text-[#eef1f8] leading-[1.08]">
              One vault for
              <br />
              all your agents.
            </h1>
            <p className="mt-8 text-lg md:text-xl text-[#8b95a8] leading-relaxed max-w-2xl">
              API keys, system prompts, memory, and preferences — stored once,
              available to every agent in every environment. Stop copy-pasting
              configs.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4">
              <Link
                href="/identity/register"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Get Started
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="https://github.com/anndrrson/said"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Read the Docs
              </a>
            </div>
          </div>

          {/* Code snippet */}
          <div className="mt-16 max-w-xl rounded-xl border border-[#1e2a3a] bg-[#0a0b10] overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e2a3a]">
              <div className="h-2.5 w-2.5 rounded-full bg-[#1e2a3a]" />
              <div className="h-2.5 w-2.5 rounded-full bg-[#1e2a3a]" />
              <div className="h-2.5 w-2.5 rounded-full bg-[#1e2a3a]" />
              <span className="ml-2 text-xs text-[#4a5568] font-mono">
                mcp tool call
              </span>
            </div>
            <pre className="p-5 text-sm font-mono leading-relaxed overflow-x-auto">
              <code>
                <span className="text-[#8b95a8]">{"{"}</span>
                {"\n"}
                <span className="text-[#eef1f8]">{"  "}&quot;tool&quot;</span>
                <span className="text-[#8b95a8]">: </span>
                <span className="text-[#3da8ff]">&quot;said_get_system_prompt&quot;</span>
                <span className="text-[#8b95a8]">,</span>
                {"\n"}
                <span className="text-[#eef1f8]">{"  "}&quot;result&quot;</span>
                <span className="text-[#8b95a8]">: </span>
                <span className="text-[#3da8ff]">&quot;You are a concise assistant...&quot;</span>
                {"\n"}
                <span className="text-[#8b95a8]">{"}"}</span>
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* Problem Statement */}
      <section className="bg-[#0f1117] border-y border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10">
          <div className="grid gap-6 sm:grid-cols-3">
            <p className="font-mono text-sm text-[#4a5568]">
              New tool? Pass another API key. New sandbox? Pass it again.
            </p>
            <p className="font-mono text-sm text-[#4a5568]">
              Rotate a key? Update every agent, every environment, manually.
            </p>
            <p className="font-mono text-sm text-[#4a5568]">
              Your agents forget you between sessions and providers.
            </p>
          </div>
        </div>
      </section>

      {/* What's in the vault */}
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
            What&apos;s in the vault
          </h2>
          <p className="text-[#8b95a8] mb-12 max-w-lg">
            Everything your AI agents need to know about you, in one portable place.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: Key, title: "Credentials", desc: "API keys and secrets in one place. Scoped per agent, rotation built in." },
              { icon: FileText, title: "System Prompts", desc: "Portable instructions that follow you across every provider." },
              { icon: Brain, title: "Memory", desc: "Persistent context across sessions. Your agents remember." },
              { icon: Settings, title: "Preferences", desc: "Style, tone, format — set once, applied everywhere." },
              { icon: Fingerprint, title: "Verified Identity", desc: "Tamper-proof identity that works across every provider." },
              { icon: Database, title: "Knowledge Base", desc: "Your docs, searchable by any connected agent." },
            ].map((card) => {
              const Icon = card.icon;
              return (
                <div
                  key={card.title}
                  className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#2a3a50] transition-colors"
                >
                  <Icon className="h-6 w-6 text-[#3da8ff] mb-4" />
                  <h3 className="text-[#eef1f8] font-medium mb-1.5">{card.title}</h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed">{card.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-start">
            <div>
              <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">How it works</h2>
              <p className="text-[#8b95a8] mb-8 leading-relaxed">
                ghola runs as an MCP server — a sidecar your AI tools connect to locally.
                Your data never leaves your machine unless you choose cloud sync.
              </p>
              <ol className="space-y-6">
                {[
                  { title: "Add ghola to your MCP config", desc: "One JSON block in Claude, Cursor, or any MCP client." },
                  { title: "Agents pull what they need", desc: "API keys, prompts, memory, preferences — fetched on demand, not hard-coded." },
                  { title: "Update once, everywhere", desc: "Rotate a key or change a prompt — every agent in every environment picks it up instantly." },
                ].map((step, i) => (
                  <li key={i} className="flex gap-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#3da8ff]/10 text-sm font-medium text-[#3da8ff]">
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-medium text-[#eef1f8]">{step.title}</p>
                      <p className="text-sm text-[#8b95a8] mt-1">{step.desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0a0b10] overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e2a3a]">
                <div className="h-2.5 w-2.5 rounded-full bg-[#1e2a3a]" />
                <div className="h-2.5 w-2.5 rounded-full bg-[#1e2a3a]" />
                <div className="h-2.5 w-2.5 rounded-full bg-[#1e2a3a]" />
                <span className="ml-2 text-xs text-[#4a5568] font-mono">claude_desktop_config.json</span>
              </div>
              <pre className="p-5 text-sm font-mono leading-relaxed overflow-x-auto">
                <code>
                  <span className="text-[#8b95a8]">{"{"}</span>
                  {"\n"}
                  <span className="text-[#eef1f8]">{"  "}&quot;mcpServers&quot;</span>
                  <span className="text-[#8b95a8]">: {"{"}</span>
                  {"\n"}
                  <span className="text-[#eef1f8]">{"    "}&quot;ghola&quot;</span>
                  <span className="text-[#8b95a8]">: {"{"}</span>
                  {"\n"}
                  <span className="text-[#eef1f8]">{"      "}&quot;command&quot;</span>
                  <span className="text-[#8b95a8]">: </span>
                  <span className="text-[#3da8ff]">&quot;said&quot;</span>
                  <span className="text-[#8b95a8]">,</span>
                  {"\n"}
                  <span className="text-[#eef1f8]">{"      "}&quot;args&quot;</span>
                  <span className="text-[#8b95a8]">: [</span>
                  <span className="text-[#3da8ff]">&quot;serve&quot;</span>
                  <span className="text-[#8b95a8]">]</span>
                  {"\n"}
                  <span className="text-[#8b95a8]">{"    }"}</span>
                  {"\n"}
                  <span className="text-[#8b95a8]">{"  }"}</span>
                  {"\n"}
                  <span className="text-[#8b95a8]">{"}"}</span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-medium text-[#eef1f8] mb-4 text-center">Pricing</h2>
          <p className="text-[#8b95a8] mb-12 text-center max-w-lg mx-auto">
            Start free. Pay only when you scale.
          </p>
          <div className="grid gap-6 sm:grid-cols-3 max-w-4xl mx-auto">
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
              <h3 className="text-lg font-medium text-[#eef1f8]">Free</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">$0<span className="text-base text-[#4a5568]">/forever</span></p>
              <ul className="mt-6 space-y-3">
                {["Unlimited local vault", "1,000 cloud API calls/day", "Verified identity", "agents.txt generation", "14 MCP tools"].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-[#8b95a8]">
                    <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />{f}
                  </li>
                ))}
              </ul>
              <Link href="/identity/register" className="mt-8 block w-full rounded-xl border border-[#1e2a3a] py-2.5 text-center text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all">
                Get Started
              </Link>
            </div>
            <div className="rounded-xl border border-[#3da8ff] bg-[#0f1117] p-6 relative">
              <span className="absolute -top-3 left-6 rounded-full bg-[#3da8ff] px-3 py-0.5 text-xs font-medium text-[#08090d]">Recommended</span>
              <h3 className="text-lg font-medium text-[#eef1f8]">Pay as you grow</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">$0.001<span className="text-base text-[#4a5568]">/resolution</span></p>
              <p className="mt-1 text-xs text-[#4a5568]">beyond free tier, metered monthly</p>
              <ul className="mt-6 space-y-3">
                {["Everything in Free", "Unlimited cloud API calls", "No commitment, cancel anytime", "Metered billing via Stripe", "10K calls/day ≈ $9/mo"].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-[#8b95a8]">
                    <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />{f}
                  </li>
                ))}
              </ul>
              <Link href="/identity/register" className="mt-8 block w-full rounded-xl bg-[#3da8ff] py-2.5 text-center text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all">
                Start Free
              </Link>
            </div>
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
              <h3 className="text-lg font-medium text-[#eef1f8]">Get Verified</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">$29<span className="text-base text-[#4a5568]"> one-time</span></p>
              <p className="mt-1 text-sm text-[#8b95a8]">+ $99/yr verified badge</p>
              <ul className="mt-6 space-y-3">
                {["Domain verification", "Verified badge for AI agents", "Trust signals in agents.txt", "Tamper-proof attestation", "Priority in discovery"].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-[#8b95a8]">
                    <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />{f}
                  </li>
                ))}
              </ul>
              <Link href="/identity/register" className="mt-8 block w-full rounded-xl bg-[#eef1f8] py-2.5 text-center text-sm font-medium text-[#08090d] hover:bg-[#d0d5e0] active:scale-[0.98] transition-all">
                Apply for Verification
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Strip */}
      <section className="border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
          <p className="text-center text-xs uppercase tracking-widest text-[#4a5568] mb-6">Works with</p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-sm text-[#4a5568]">
            <span>Claude</span><span>ChatGPT</span><span>Cursor</span><span>Windsurf</span>
            <span>Any MCP Client</span>
            <span className="text-[#8b95a8]">Open protocol</span>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-medium text-[#eef1f8]">Stop managing configs. Start building agents.</h2>
          <p className="mt-4 text-[#8b95a8]">Set up in 60 seconds. Free forever for local use.</p>
          <Link
            href="/identity/register"
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-8 py-4 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
          >
            Create Your Vault
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
