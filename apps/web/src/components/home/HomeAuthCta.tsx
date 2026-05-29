"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight } from "lucide-react";
import type { AuthMode } from "@/components/AuthModal";

const AuthModal = dynamic(
  () => import("@/components/AuthModal").then((mod) => mod.AuthModal),
  { ssr: false, loading: () => null },
);

export function HomeAuthCta() {
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");

  return (
    <>
      {authOpen && (
        <AuthModal
          mode={authMode}
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          onModeChange={setAuthMode}
          redirectTo="/app/account?flow=trade"
        />
      )}
      <button
        type="button"
        onClick={() => {
          setAuthMode("signup");
          setAuthOpen(true);
        }}
        className="group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#eef1f8] px-6 text-sm font-medium text-[#08090d] transition hover:bg-white"
      >
        Start trading with Ghola
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </button>
    </>
  );
}
