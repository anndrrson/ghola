"use client";

import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { LockKeyhole } from "lucide-react";
import type { AuthMode } from "@/components/AuthModal";
import { useThumperAuth } from "@/lib/thumper-auth-context";

const AuthModal = dynamic(
  () => import("@/components/AuthModal").then((mod) => mod.AuthModal),
  { ssr: false, loading: () => null },
);

export function RequireThumperAuth({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  const auth = useThumperAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");

  if (auth.authenticated) return <>{children}</>;

  return (
    <main className="min-h-screen bg-[#08090d] pt-16 text-[#eef1f8]">
      {authOpen && (
        <AuthModal
          mode={authMode}
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          onModeChange={setAuthMode}
        />
      )}
      <section className="px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-4 border border-[#1e2a3a] bg-[#0f1117] p-5 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-[#243347] bg-[#08090d]">
                <LockKeyhole className="h-5 w-5 text-[#a8d8ff]" />
              </div>
              <div>
                <h1 className="text-lg font-medium text-[#eef1f8]">{title}</h1>
                <p className="mt-1 text-sm text-[#8b95a8]">{detail}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setAuthMode("signin");
                setAuthOpen(true);
              }}
              disabled={auth.loading}
              className="inline-flex h-11 items-center justify-center bg-[#eef1f8] px-5 text-sm font-medium text-[#08090d] disabled:cursor-wait disabled:opacity-60"
            >
              {auth.loading ? "Checking" : "Sign in"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
