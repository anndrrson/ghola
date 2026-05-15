"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";

export default function Home() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && authenticated) {
      router.push("/chat");
    }
  }, [authenticated, loading, router]);

  if (authenticated && !loading) return null;

  // Organization schema for the homepage. Tells Google what the site
  // represents at a brand level — feeds knowledge panel, brand sitelinks,
  // and the "About this result" panel without needing rich-snippet
  // markup on every page.
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "ghola",
    url: "https://ghola.xyz",
    description:
      "The most private AI. Runs on your device, or end-to-end encrypted in the cloud.",
    logo: "https://ghola.xyz/icon-512.png",
  };

  return (
    <div className="min-h-screen pt-16">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
      />
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
          <div className="mx-auto w-full max-w-6xl px-6 lg:px-12 pt-24 pb-20 sm:pt-32 sm:pb-24">
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

            {/* Superlative claim — privacy is the moat (per Yahya's
                a16z thesis), so we lay claim to the title rather than
                hedge. Two-sentence subtitle names both sovereignty
                modes the user can actually pick (local + private),
                ladders into the modes section below. */}
            <h1 className="font-display text-[clamp(3rem,9vw,7.5rem)] leading-[0.94] text-[#eef1f8] font-medium">
              The <span className="text-[#3da8ff]">most private</span> AI.
            </h1>

            <p className="mt-10 max-w-xl text-lg text-[#8b95a8] leading-relaxed">
              Runs on your device. Or end-to-end encrypted in the cloud.
            </p>

            <div className="mt-12 flex flex-wrap items-center gap-4">
              <Link
                href="/chat"
                className="group inline-flex items-center justify-center gap-2 rounded-full bg-[#3da8ff] px-7 py-3.5 text-[15px] font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Try Ghola
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/security"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[#1e2a3a] px-7 py-3.5 text-[15px] font-medium text-[#eef1f8] hover:border-[#2a3a50] hover:bg-[#0f141c] transition-all"
              >
                How it works
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom credentials strip — three a16z-thesis primitives:
            attested (TEE stack), on-chain (receipts/settlement),
            open weights (open AI thesis). Cold visitors read it as a
            feature list; pattern-matchers see the moat. */}
        <div className="relative border-t border-[#1e2a3a] bg-[#0a0b10]/60 backdrop-blur-sm">
          <div className="mx-auto max-w-6xl px-6 lg:px-12 py-5 flex flex-wrap items-center gap-x-8 gap-y-2 font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f798c]">
            <span>Attested</span>
            <span className="text-[#2a3a50]">·</span>
            <span>On-chain</span>
            <span className="text-[#2a3a50]">·</span>
            <span>Open weights</span>
          </div>
        </div>
      </section>

      {/* ──────────── Pillars ────────────
          Three a16z-thesis primitives stated as features: confidential
          (data privacy), sovereign (wallet identity), payable (agent
          settlement). Telegram-style — adjective label, one human
          sentence of proof. Reads as feature breadth for normies;
          pattern-matches to the AI×crypto thesis for partners. */}
      <section className="pt-20 pb-28 sm:pt-24 sm:pb-36">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-12">
          <div className="flex items-baseline gap-6 mb-16">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              01 — The stack
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>

          <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#1e2a3a] border-y border-[#1e2a3a]">
            {[
              {
                label: "Confidential",
                desc: "Every input is encrypted before leaving your machine — or you can run locally so nothing leaves at all.",
              },
              {
                label: "Sovereign",
                desc: "You sign in with your wallet, so there's no account or email for anyone to compromise.",
              },
              {
                label: "Payable",
                desc: "Agents pay per call in USDC, so they can use the API without ever signing up.",
              },
            ].map((pillar) => (
              <div
                key={pillar.label}
                className="p-8 lg:p-10"
              >
                <h3 className="font-display text-2xl text-[#eef1f8] mb-4">
                  {pillar.label}
                </h3>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  {pillar.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────── Sovereignty Modes ──────────── */}
      <section className="py-28 sm:py-36">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-12">
          <div className="flex items-baseline gap-6 mb-16">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              02 — Sovereignty modes
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
              03 — How it flows
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>

          <div className="grid lg:grid-cols-12 gap-12 lg:gap-20">
            <div className="lg:col-span-5">
              <h2 className="font-display text-4xl md:text-6xl leading-[1.0] text-[#eef1f8] mb-8 font-medium">
                How a private chat{" "}
                <span className="text-[#8b95a8]">actually works.</span>
              </h2>
              <p className="text-[#8b95a8] leading-relaxed">
                Four steps. The mode you pick decides which transport
                runs them, but the shape is the same: you stay in control
                from the keystroke to the audit trail.
              </p>
            </div>

            <ol className="lg:col-span-7">
              {[
                {
                  label: "Pick a mode",
                  desc: "Private, Local, or Open. The choice sits in the chat header and rides into every message that follows.",
                },
                {
                  label: "Encrypt or stay home",
                  desc: "Private seals the message to a verified provider key. Local never sends it anywhere — it runs on your machine via ghola-home.",
                },
                {
                  label: "Run the model",
                  desc: "Inference happens inside the attested enclave (Private), on your hardware (Local), or at any open provider (Open). You always know which.",
                },
                {
                  label: "Get a receipt",
                  desc: "Every assistant message ships with a signed receipt naming the mode, the provider, and the hashes of your prompt and the response. Verify it from the badge.",
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
            Private by <span className="text-[#3da8ff]">proof.</span>
          </h2>
          <p className="mt-8 text-[#8b95a8] max-w-md mx-auto leading-relaxed">
            Encrypted in transit. Signed on arrival. Verify any reply
            from the badge.
          </p>
          <div className="mt-12 flex justify-center">
            <Link
              href="/chat"
              className="group inline-flex items-center justify-center gap-2 rounded-full bg-[#3da8ff] px-8 py-4 text-[15px] font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
            >
              Try Ghola
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
