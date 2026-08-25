import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, LockKeyhole, ShieldCheck, type LucideIcon } from "lucide-react";
import { PrivateAccountCockpit, type PrivateAccountInitialFlow } from "@/components/private-account/PrivateAccountCockpit";
import { headers } from "next/headers";
import { resolveGholaProductEnvironment } from "@/lib/product-environment";
import { CarryAccountSetup } from "@/components/carry/CarryAccountSetup";
import { safeHyperliquidSetupReturn } from "@/lib/hyperliquid-trade-return";
import { privateAccountInitialFlow } from "@/lib/private-account-entry";

export default async function GholaAccountPage({
  searchParams,
}: {
  searchParams?: Promise<{
    flow?: string | string[];
    setup?: string | string[];
    source?: string | string[];
    return_to?: string | string[];
  }>;
}) {
  const requestHeaders = await headers();
  const { hyperliquidNetwork } = resolveGholaProductEnvironment({
    host: requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
    configuredEnvironment: process.env.GHOLA_PRODUCT_ENVIRONMENT,
    configuredHyperliquidNetwork: process.env.GHOLA_HYPERLIQUID_PILOT_NETWORK,
  });
  const params = await searchParams;
  const flow = Array.isArray(params?.flow) ? params.flow[0] : params?.flow;
  const source = Array.isArray(params?.source) ? params.source[0] : params?.source;
  const setup = Array.isArray(params?.setup) ? params.setup[0] : params?.setup;
  const returnTo = Array.isArray(params?.return_to) ? params.return_to[0] : params?.return_to;
  const initialIosReturnTo =
    source === "ios" && returnTo === "ghola://trading/setup-complete"
      ? returnTo
      : null;
  const focusedSetup = setup === "hyperliquid";
  const focusedCarrySetup = setup === "carry";
  const initialFlow: PrivateAccountInitialFlow = privateAccountInitialFlow({ flow, setup });
  const terminalFlow =
    initialFlow === "trade" || initialFlow === "hyperliquid-live" || initialFlow === "phoenix-live" ||
    initialFlow === "jupiter-live" || initialFlow === "coinbase";
  if (terminalFlow) {
    const product =
      initialFlow === "hyperliquid-live" ? "perps" :
      initialFlow === "jupiter-live" ? "swap" :
      "spot";
    const venue =
      initialFlow === "hyperliquid-live" ? "hyperliquid" :
      initialFlow === "jupiter-live" ? "jupiter" :
      initialFlow === "phoenix-live" || initialFlow === "trade" ? "phoenix" :
      "coinbase_advanced";
    const query = new URLSearchParams({ product, venue });
    if (source) query.set("source", source);
    if (returnTo) query.set("return_to", returnTo);
    redirect(`/trade?${query.toString()}`);
  }
  return (
    <main className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      {!terminalFlow && !focusedSetup && !focusedCarrySetup && (
        <section className="border-b border-[#151b26] px-4 py-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">
                  Private Agent Console
                </p>
                <h1 className="mt-2 max-w-3xl text-2xl font-medium leading-tight text-[#f6f8ff] sm:text-4xl">
                  Private Mode
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[#aab5c8] sm:text-base">
                  Choose what you want to do. Ghola checks what can be seen before anything moves.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[520px]">
                <TopSignal icon={LockKeyhole} label="1" value="Choose action" />
                <TopSignal icon={Activity} label="2" value="Check privacy" />
                <TopSignal icon={ShieldCheck} label="3" value="Approve or wait" />
              </div>
            </div>
          </div>
        </section>
      )}
      {terminalFlow && (
        <section className="border-b border-[#151b26] bg-[#08090d] px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">
                Scoped venue access
              </p>
              <h1 className="mt-1 text-xl font-medium text-[#f6f8ff] sm:text-2xl">
                Advanced venue access
              </h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-[#aab5c8]">
                Explicit venue-key and authority flows stay available for operators and advanced users.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <FlowLink href="/account?flow=hyperliquid-live" label="Hyperliquid API wallet" />
              <FlowLink href="/account?flow=coinbase" label="Coinbase key" />
              <FlowLink href="/account?flow=phoenix-live" label="Phoenix authority" />
            </div>
          </div>
        </section>
      )}

      <section className={terminalFlow || focusedSetup || focusedCarrySetup ? "px-0 py-0" : "px-4 py-5 sm:px-6 lg:px-8"}>
        {focusedCarrySetup ? <CarryAccountSetup returnTo={returnTo} /> : (
          <PrivateAccountCockpit
            initialFlow={initialFlow}
            initialSetupVenue={setup === "hyperliquid" ? "hyperliquid" : null}
            initialReturnTo={safeHyperliquidSetupReturn(returnTo) ? returnTo : null}
            initialHyperliquidMarket={null}
            initialIosReturnTo={initialIosReturnTo}
            hyperliquidNetwork={hyperliquidNetwork}
          />
        )}
      </section>
    </main>
  );
}

function FlowLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center rounded-md border border-[#2b3547] bg-[#0f1117] px-3 text-sm font-medium text-[#dce6f4] transition hover:border-[#475569] hover:text-white"
    >
      {label}
    </Link>
  );
}

function TopSignal({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 border border-[#1e2a3a] bg-[#0f1117] px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-[#a8d8ff]" />
      <div className="min-w-0">
        <p className="text-[11px] text-[#6f7d9a]">{label}</p>
        <p className="truncate text-sm font-medium text-[#eef1f8]">{value}</p>
      </div>
    </div>
  );
}
