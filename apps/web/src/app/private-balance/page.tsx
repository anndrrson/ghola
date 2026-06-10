import Link from "next/link";
import { ArrowRight, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { PrivateBalancePanel } from "@/components/private-balance";

const principles = [
  {
    icon: ShieldCheck,
    title: "No rail picking",
    desc: "Users choose Private Mode. Ghola handles the payment rail.",
  },
  {
    icon: Wallet,
    title: "Normal top ups",
    desc: "Fund with familiar USDC and payment methods as the rail matures.",
  },
  {
    icon: LockKeyhole,
    title: "No silent downgrade",
    desc: "If private settlement is unavailable, the private action pauses.",
  },
] as const;

export default function PrivateBalancePage() {
  return (
    <main className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      <section className="border-b border-[#151b26] px-5 py-16 sm:px-8 sm:py-24 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">
            Private Balance
          </p>
          <div className="mt-5 grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
            <div>
              <h1 className="max-w-3xl text-5xl font-medium leading-[0.98] tracking-tight text-[#f6f8ff] sm:text-7xl">
                Privacy with no setup ritual.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-[#aab5c8] sm:text-lg">
                Private Balance turns shielded stablecoin settlement into one
                switch. Users top up normally; Ghola enforces private spend
                behind the scenes.
              </p>
            </div>
            <div className="grid gap-3">
              {principles.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.title}
                    className="grid grid-cols-[2.5rem_1fr] gap-4 border-t border-[#151b26] pt-4"
                  >
                    <Icon className="mt-0.5 h-5 w-5 text-[#7e8da8]" />
                    <div>
                      <h2 className="text-sm font-medium text-[#eef1f8]">
                        {item.title}
                      </h2>
                      <p className="mt-1 text-sm leading-6 text-[#8b95a8]">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-12 sm:px-8 sm:py-16 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <PrivateBalancePanel />
        </div>
      </section>

      <section className="border-t border-[#151b26] px-5 py-12 sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-[#8b95a8]">
            Public USDC remains the fastest settlement rail. Private Mode uses
            the shielded rail only when it can preserve the privacy guarantee.
          </p>
          <Link
            href="/trade"
            className="inline-flex items-center gap-2 text-sm font-medium text-[#a8d8ff] hover:text-[#eef1f8]"
          >
            Open trading <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </main>
  );
}
