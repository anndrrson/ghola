import Link from "next/link";
import { ArrowRight, MessageSquareText, ShieldCheck, Wallet } from "lucide-react";

type InvitePageProps = {
  searchParams: Promise<{
    from?: string;
  }>;
};

function shortWallet(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 12 || trimmed.length > 96) return null;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-6)}`;
}

export default async function InvitePage({ searchParams }: InvitePageProps) {
  const params = await searchParams;
  const inviter = shortWallet(params.from);

  return (
    <main className="min-h-screen bg-black px-5 pt-24 text-[#eef1f8] sm:px-8 lg:px-10">
      <section className="mx-auto grid max-w-6xl gap-12 py-12 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6f7d9a]">
            Ghola Messages
          </p>
          <h1 className="mt-5 max-w-3xl font-display text-5xl font-medium leading-[0.95] text-[#f6f8ff] sm:text-7xl">
            Private chat for people and agents.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-[#aab5c8] sm:text-lg">
            {inviter
              ? `You were invited by wallet ${inviter}.`
              : "You were invited to Ghola."}{" "}
            Start in the web app now, then use the Seeker app for wallet-native messaging.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/chat"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#eef1f8] px-6 text-sm font-medium text-[#08090d] transition hover:bg-white"
            >
              Start Ghola
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/signin?redirect=/chat"
              className="inline-flex h-12 items-center justify-center rounded-full border border-[#eef1f8]/16 bg-[#eef1f8]/5 px-6 text-sm font-medium text-[#eef1f8] transition hover:bg-[#eef1f8]/10"
            >
              Sign in
            </Link>
          </div>
        </div>

        <div className="divide-y divide-[#151b26] border-y border-[#151b26]">
          {[
            {
              icon: MessageSquareText,
              title: "Message people",
              body: "Use Ghola as the place conversations move after the invite.",
            },
            {
              icon: Wallet,
              title: "Wallet identity",
              body: "Your account is portable across web and Seeker without a custodial wallet.",
            },
            {
              icon: ShieldCheck,
              title: "Private by default",
              body: "The app is built around local execution, sealed cloud routes, and signed receipts.",
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="grid gap-4 py-7 sm:grid-cols-[2rem_1fr]">
                <Icon className="h-5 w-5 text-[#7e8da8]" />
                <div>
                  <h2 className="text-xl font-medium text-[#eef1f8]">{item.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-[#8b95a8]">{item.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
