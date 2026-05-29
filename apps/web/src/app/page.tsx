import { EyeOff, Layers3, LockKeyhole, ReceiptText } from "lucide-react";
import { HomeAuthCta } from "@/components/home/HomeAuthCta";
import { HomePixelBackdrop } from "@/components/home/HomePixelBackdrop";
import { HomeSignedInRedirect } from "@/components/home/HomeSignedInRedirect";

const modes = [
  {
    icon: LockKeyhole,
    title: "Private account",
    desc: "Your wallet funds Ghola. Apps and venues do not get your main wallet by default.",
  },
  {
    icon: EyeOff,
    title: "Preview",
    desc: "Every action is checked for chain, platform, operator, solver, timing, and amount exposure.",
  },
  {
    icon: Layers3,
    title: "Anonymity",
    desc: "Ghola waits for cohorts, batches, buckets, shielded rails, or blocks when anonymity is too weak.",
  },
  {
    icon: ReceiptText,
    title: "Receipt",
    desc: "Receipts say what was hidden, what was visible, and whether execution was full, degraded, or blocked.",
  },
] as const;

const orgSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "ghola",
  url: "https://ghola.xyz",
  description:
    "Private execution accounts for onchain finance with anonymity previews and auditable privacy receipts.",
  logo: "https://ghola.xyz/icon-512.png",
};

export default function Home() {
  return (
    <div className="min-h-screen bg-black pt-16 text-[#eef1f8]">
      <HomeSignedInRedirect />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
      />

      <section className="relative min-h-[calc(82svh-4rem)] overflow-hidden border-b border-[#151b26]">
        <div className="absolute inset-0 bg-black" />
        <HomePixelBackdrop />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.1) 52%, rgba(0,0,0,0.84) 100%)",
          }}
        />

        <div className="relative mx-auto flex min-h-[calc(82svh-4rem)] max-w-7xl flex-col justify-center px-5 py-12 text-center sm:px-8 lg:px-10">
          <h1 className="mx-auto max-w-6xl font-display text-[clamp(3.8rem,10.5vw,8.5rem)] font-medium leading-[0.9] text-[#f6f8ff]">
            Private Mode for onchain finance.
          </h1>
          <p className="mx-auto mt-7 max-w-3xl text-lg leading-7 text-[#aab5c8] sm:text-2xl sm:leading-8">
            Use crypto apps without exposing your wallet. Ghola checks what
            leaks before anything moves.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <HomeAuthCta />
          </div>
        </div>
      </section>

      <section className="bg-black px-5 pb-20 pt-10 sm:px-8 sm:pb-28 sm:pt-12 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr] lg:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#6f7d9a]">
                01 / How it works
              </p>
              <h2 className="mt-4 max-w-xl font-display text-4xl font-medium leading-[1] text-[#eef1f8] sm:text-6xl">
                Before you send, see who can see your wallet.
              </h2>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-[#8b95a8] sm:text-base">
              Ghola shows what leaks. If too much is visible, the action waits
              or stops.
            </p>
          </div>

          <div className="mt-12 divide-y divide-[#151b26] border-y border-[#151b26]">
            {modes.map((mode) => {
              const Icon = mode.icon;
              return (
                <div
                  key={mode.title}
                  className="grid gap-5 py-7 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-8 sm:py-8"
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
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
