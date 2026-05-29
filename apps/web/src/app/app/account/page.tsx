import { LockKeyhole, ShieldCheck, TimerReset, type LucideIcon } from "lucide-react";
import { PrivateAccountCockpit } from "@/components/private-account/PrivateAccountCockpit";

export default function GholaAccountPage() {
  return (
    <main className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      <section className="border-b border-[#151b26] px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f7d9a]">
                Ghola Account
              </p>
              <h1 className="mt-2 max-w-3xl text-2xl font-medium leading-tight text-[#f6f8ff] sm:text-4xl">
                Private Mode
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#aab5c8] sm:text-base">
                Choose what you want to do. Ghola checks what can be seen
                before anything moves.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[520px]">
              <TopSignal icon={LockKeyhole} label="1" value="Choose action" />
              <TopSignal icon={TimerReset} label="2" value="Check privacy" />
              <TopSignal icon={ShieldCheck} label="3" value="Approve or wait" />
            </div>
          </div>
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6 lg:px-8">
        <PrivateAccountCockpit />
      </section>
    </main>
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
