"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Cpu, LockKeyhole, ReceiptText } from "lucide-react";
import dynamic from "next/dynamic";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { mark } from "@/lib/perf-marks";

const PixelField = dynamic(
  () => import("@/components/pixel-field").then((m) => m.PixelField),
  { ssr: false, loading: () => null },
);

const modes = [
  {
    icon: LockKeyhole,
    title: "Private",
    meta: "sealed relay",
    desc: "Encrypted to a verified provider key before it leaves your browser.",
  },
  {
    icon: Cpu,
    title: "Local",
    meta: "on device",
    desc: "Runs through WebGPU or ghola-home when the prompt should stay put.",
  },
  {
    icon: ReceiptText,
    title: "Receipt",
    meta: "signed proof",
    desc: "Each reply exposes mode, provider identity, and prompt/output hashes.",
  },
] as const;

export default function Home() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && authenticated) {
      router.push("/chat");
    }
  }, [authenticated, loading, router]);

  useEffect(() => {
    mark("hero-rendered");
  }, []);

  if (authenticated && !loading) return null;

  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "ghola",
    url: "https://ghola.xyz",
    description:
      "The most private AI. Runs locally or end-to-end encrypted in the cloud.",
    logo: "https://ghola.xyz/icon-512.png",
  };

  return (
    <div className="min-h-screen bg-black pt-16 text-[#eef1f8]">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
      />

      <section className="relative min-h-[calc(100svh-4rem)] overflow-hidden border-b border-[#151b26]">
        <div className="absolute inset-0 bg-black" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.78]">
          <PixelField
            color="#aebad3"
            pixelSize={4}
            patternScale={2.9}
            patternDensity={1.68}
            pixelJitter={0.02}
            edgeFade={0.01}
            centerDepletion={0}
            speed={1.05}
            seed={81}
          />
        </div>
        <div className="pointer-events-none absolute inset-0 opacity-[0.42]">
          <PixelField
            color="#467fb2"
            pixelSize={6}
            patternScale={3.8}
            patternDensity={1.46}
            pixelJitter={0.03}
            edgeFade={0.01}
            centerDepletion={0}
            speed={0.82}
            seed={137}
          />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.1) 52%, rgba(0,0,0,0.84) 100%)",
          }}
        />

        <div className="relative mx-auto flex min-h-[calc(100svh-4rem)] max-w-7xl flex-col justify-center px-5 py-20 text-center sm:px-8 lg:px-10">
          <p className="mx-auto mb-7 font-mono text-[10px] uppercase tracking-[0.28em] text-[#6f7d9a]">
            Private AI / Local First / Signed Receipts
          </p>

          <h1 className="mx-auto max-w-6xl font-display text-[clamp(4.5rem,13vw,12rem)] font-medium leading-[0.86] text-[#f6f8ff]">
            The most private AI.
          </h1>
          <p className="mx-auto mt-8 max-w-3xl text-lg leading-7 text-[#aab5c8] sm:text-2xl sm:leading-8">
            Runs on your device, or end-to-end encrypted in the cloud. Every
            answer tells you where it ran.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/chat"
              className="group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#eef1f8] px-6 text-sm font-medium text-[#08090d] transition hover:bg-white"
            >
              Try Ghola
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/security"
              className="inline-flex h-12 items-center justify-center rounded-full border border-[#eef1f8]/16 bg-[#eef1f8]/5 px-6 text-sm font-medium text-[#eef1f8] backdrop-blur transition hover:bg-[#eef1f8]/10"
            >
              Security model
            </Link>
          </div>
        </div>
      </section>

      <section className="bg-black px-5 py-20 sm:px-8 sm:py-28 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr] lg:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#6f7d9a]">
                01 / Modes
              </p>
              <h2 className="mt-4 max-w-xl font-display text-4xl font-medium leading-[1] text-[#eef1f8] sm:text-6xl">
                Privacy is visible in the interface.
              </h2>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-[#8b95a8] sm:text-base">
              Ghola makes the trust boundary explicit before inference starts.
              Local means local. Private means sealed. Receipts make the route
              auditable after the answer arrives.
            </p>
          </div>

          <div className="mt-12 divide-y divide-[#151b26] border-y border-[#151b26]">
            {modes.map((mode) => {
              const Icon = mode.icon;
              return (
                <div
                  key={mode.title}
                  className="grid gap-5 py-7 sm:grid-cols-[10rem_1fr_auto] sm:items-center sm:gap-8 sm:py-8"
                >
                  <div className="flex items-center gap-3">
                    <Icon className="h-5 w-5 text-[#7e8da8]" />
                    <h3 className="text-xl font-medium text-[#eef1f8]">
                      {mode.title}
                    </h3>
                  </div>
                  <p className="max-w-2xl text-sm leading-6 text-[#8b95a8]">
                    {mode.desc}
                  </p>
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#5f6c81]">
                    {mode.meta}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
