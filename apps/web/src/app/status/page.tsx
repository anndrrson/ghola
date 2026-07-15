import Link from "next/link";

export const metadata = {
  title: "Ghola status",
  description: "Consumer trading availability and support information.",
};

export default function StatusPage() {
  return (
    <main className="min-h-screen bg-[#08090d] px-5 py-24 text-[#eef1f8] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">Service status</p>
        <h1 className="mt-4 text-4xl font-medium tracking-tight sm:text-6xl">Ghola consumer trading</h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-[#aab5c8]">
          Ghola fails closed when a venue, balance verifier, reconciliation worker, or confidential execution provider is unavailable. A queued worker wake is not an order submission.
        </p>
        <div className="mt-10 grid gap-3">
          <StatusRow label="Web application" value="Check live health" href="/api/health/live" />
          <StatusRow label="Trading readiness" value="Check readiness" href="/api/health/ready" />
          <StatusRow label="Consumer trading" value="Check public status" href="/v1/private-account/trading/status" />
        </div>
        <section className="mt-12 border-t border-[#1b2230] pt-8">
          <h2 className="text-lg font-medium">Need help with funds or an order?</h2>
          <p className="mt-3 text-sm leading-6 text-[#aab5c8]">
            Do not submit a replacement order while a receipt is pending. Email{" "}
            <a className="text-[#a8d8ff] underline underline-offset-4" href="mailto:support@ghola.xyz">support@ghola.xyz</a>{" "}
            with the receipt or commitment ID. Never send a private key, seed phrase, API secret, or sealed payload.
          </p>
          <Link className="mt-6 inline-flex text-sm font-medium text-[#a8d8ff]" href="/trade">Return to trading</Link>
        </section>
      </div>
    </main>
  );
}

function StatusRow({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <a href={href} className="flex items-center justify-between gap-4 rounded-lg border border-[#1b2230] bg-[#0b0e14] px-4 py-4 hover:border-[#33405a]">
      <span className="text-sm text-[#dce5f5]">{label}</span>
      <span className="font-mono text-xs text-[#8fbde5]">{value}</span>
    </a>
  );
}
