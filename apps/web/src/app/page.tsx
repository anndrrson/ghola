"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { Footer } from "@/components/Footer";

export default function Home() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && authenticated) {
      router.push("/chat");
    }
  }, [authenticated, loading, router]);

  if (authenticated && !loading) return null;

  return (
    <div className="min-h-screen pt-16">
      {/* ──────────── Hero ──────────── */}
      <section className="relative flex flex-col overflow-hidden">
        {/* Subtle grid backdrop. Keep it low-contrast so the typography
            stays the focal point — the previous "busy" iteration of this
            hero loaded too much going on. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle, #14202e 1px, transparent 1px)",
            backgroundSize: "32px 32px",
            maskImage:
              "radial-gradient(ellipse 80% 60% at 50% 50%, black, transparent 75%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(1200px 600px at 78% 8%, rgba(61,168,255,0.10), transparent 60%), radial-gradient(700px 400px at 8% 92%, rgba(61,168,255,0.05), transparent 60%)",
          }}
        />

        <div className="relative">
          <div className="mx-auto w-full max-w-6xl px-6 lg:px-12 pt-24 pb-28 sm:pt-32 sm:pb-36">
            {/* Live indicator — just the pulse + "Live". The "on Solana" / chain
                detail belongs in the bottom strip and the deposit/x402 pages,
                not in the headline real estate where most visitors don't care. */}
            <div className="inline-flex items-center gap-2 mb-10 font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22c55e] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#22c55e]" />
              </span>
              Live
            </div>

            {/* Single-line privacy hero. "Off the record" is the strongest
                privacy framing English has — it's the phrase journalists,
                lawyers, and confidants reach for when something must not
                leave the room. Pairs with an end-to-end-encryption proof
                line that's true post-PR-1: the cloud is server-blind, so
                "we can't read it" is capability, not policy. */}
            <h1 className="font-display text-[clamp(3rem,9vw,7.5rem)] leading-[0.94] text-[#eef1f8] font-medium">
              Verifiably{" "}
              <span className="text-[#3da8ff]">off the record.</span>
            </h1>

            <p className="mt-10 max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
              Open, attested, sovereign confidential AI — TEE + on-device +
              on-chain accountable privacy, with a per-message cryptographic
              receipt the user can verify.
            </p>

            <div className="mt-12">
              <Link
                href="/chat"
                className="group inline-flex items-center justify-center gap-2 rounded-full bg-[#3da8ff] px-7 py-3.5 text-[15px] font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Try Private chat
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom strip — "active on network" status row, lives in its own
            band so it reads as live system state, not a feature list. */}
        <div className="relative border-t border-[#1e2a3a] bg-[#0a0b10]/60 backdrop-blur-sm">
          <div className="mx-auto max-w-6xl px-6 lg:px-12 py-5 flex flex-wrap items-center gap-x-8 gap-y-2 font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f798c]">
            <span className="text-[#8b95a8]">Active on network</span>
            <span className="text-[#2a3a50]">·</span>
            <span>End-to-end encrypted</span>
            <span className="text-[#2a3a50]">·</span>
            <span>On-device option</span>
            <span className="text-[#2a3a50]">·</span>
            <span>Verifiable receipts</span>
            <span className="text-[#2a3a50]">·</span>
            <span>Open weights</span>
          </div>
        </div>
      </section>

      {/* ──────────── Sovereignty Modes ──────────── */}
      <section className="py-28 sm:py-36">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-12">
          <div className="flex items-baseline gap-6 mb-16">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              01 — Sovereignty modes
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>

          <div className="grid lg:grid-cols-12 gap-10 lg:gap-16 items-end mb-20">
            <h2 className="lg:col-span-7 font-display text-4xl md:text-6xl leading-[1.0] text-[#eef1f8] font-medium">
              Pick where your AI{" "}
              <span className="text-[#8b95a8]">thinks.</span>
            </h2>
            <p className="lg:col-span-5 text-[#8b95a8] leading-relaxed">
              Every chat ships with a receipt. The receipt says exactly where
              the model ran and who signed off — so &quot;private&quot; means
              something you can verify, not something you have to trust.
            </p>
          </div>

          <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#1e2a3a] border-y border-[#1e2a3a]">
            {[
              {
                num: "i",
                tag: "Default",
                title: "Private",
                desc: "Encrypted to a verified provider. The relay forwards opaque bytes — we cannot decrypt your conversation.",
              },
              {
                num: "ii",
                tag: "On-device",
                title: "Local",
                desc: "Runs on your laptop via WebGPU or ghola-home. The message never leaves the machine. You sign your own receipt.",
              },
              {
                num: "iii",
                tag: "Open",
                title: "Open",
                desc: "Any provider, plaintext path, cheapest route. Labeled unverified — for tasks where privacy is not the constraint.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="p-8 lg:p-10 flex flex-col"
              >
                <div className="flex items-center justify-between mb-10">
                  <span className="font-display text-3xl text-[#3da8ff]">
                    {card.num}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f798c]">
                    {card.tag}
                  </span>
                </div>
                <h3 className="text-[#eef1f8] text-xl mb-3">{card.title}</h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed flex-1">
                  {card.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────── Flywheel ──────────── */}
      <section className="py-28 sm:py-36 bg-[#0a0b10]">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-12">
          <div className="flex items-baseline gap-6 mb-16">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              02 — How it flows
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>

          <div className="grid lg:grid-cols-12 gap-12 lg:gap-20">
            <div className="lg:col-span-5">
              <h2 className="font-display text-4xl md:text-6xl leading-[1.0] text-[#eef1f8] mb-8 font-medium">
                Every agent action{" "}
                <span className="text-[#8b95a8]">pays someone.</span>
              </h2>
              <p className="text-[#8b95a8] leading-relaxed mb-8">
                An agent needs a model to think, compute to run, and services
                to act. Each has a price. Each settles in USDT or USDC on
                Solana. Each builds reputation.
              </p>
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-2 text-sm text-[#3da8ff] hover:text-[#5bb8ff] transition-colors"
              >
                See the full flow
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            <ol className="lg:col-span-7">
              {[
                {
                  label: "Resolve",
                  desc: "Agent queries the registry for a model, compute node, or service that matches the task.",
                },
                {
                  label: "Verify",
                  desc: "Cryptographic identity check — UCAN credentials, on-chain registration, reputation score.",
                },
                {
                  label: "Execute",
                  desc: "The call lands at the provider, work happens, the result returns.",
                },
                {
                  label: "Settle",
                  desc: "USDC flows from the agent's wallet to the provider, per-call, hourly batched.",
                },
              ].map((step, i) => (
                <li
                  key={step.label}
                  className="grid grid-cols-[3rem_1fr] gap-6 py-7 border-t border-[#1e2a3a] last:border-b"
                >
                  <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f798c] pt-1.5">
                    0{i + 1}
                  </span>
                  <div>
                    <h4 className="text-lg text-[#eef1f8] mb-2">{step.label}</h4>
                    <p className="text-sm text-[#8b95a8] leading-relaxed max-w-md">
                      {step.desc}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ──────────── Numbers + On-chain ──────────── */}
      <section className="py-28 sm:py-36">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-12">
          <div className="flex items-baseline gap-6 mb-16">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              03 — The shape of it
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-[#1e2a3a] border border-[#1e2a3a] mb-20">
            {[
              { value: "85%", label: "Creator share" },
              { value: "3%", label: "Service fee" },
              { value: "1hr", label: "Settlement" },
              { value: "0", label: "Gatekeepers" },
            ].map((s) => (
              <div key={s.label} className="bg-[#08090d] p-8 lg:p-10">
                <p className="font-display text-5xl md:text-7xl text-[#eef1f8] leading-none">
                  {s.value}
                </p>
                <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f798c] mt-5">
                  {s.label}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 pt-2">
            <div>
              <p className="font-display text-3xl md:text-4xl text-[#eef1f8] mb-2 font-medium">
                Anchored <span className="text-[#8b95a8]">on Solana.</span>
              </p>
              <p className="text-sm text-[#8b95a8] max-w-md leading-relaxed">
                Identity, services, and reputation — verifiable on-chain, owned
                by you.
              </p>
            </div>
            <code className="font-mono text-xs text-[#cfd4dd] border border-[#1e2a3a] rounded-full px-4 py-2 self-start sm:self-end whitespace-nowrap">
              3EqrapHPP…7QyR
            </code>
          </div>
        </div>
      </section>

      {/* ──────────── Final CTA + footer ──────────── */}
      <section className="py-28 sm:py-40 border-t border-[#1e2a3a] relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(900px 500px at 50% 100%, rgba(61,168,255,0.12), transparent 60%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-4xl px-6 lg:px-12 text-center">
          <h2 className="font-display text-5xl md:text-8xl leading-[0.94] text-[#eef1f8] font-medium">
            Verifiably <span className="text-[#3da8ff]">off the record.</span>
          </h2>
          <p className="mt-8 text-[#8b95a8] max-w-md mx-auto leading-relaxed">
            Every message gets a receipt. Every receipt says where it ran.
            Nothing leaves a trail you can&apos;t audit.
          </p>
          <div className="mt-12 flex justify-center">
            <Link
              href="/chat"
              className="group inline-flex items-center justify-center gap-2 rounded-full bg-[#3da8ff] px-8 py-4 text-[15px] font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
            >
              Try Private chat
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
