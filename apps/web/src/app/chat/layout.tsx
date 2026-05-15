"use client";

import { useThumperAuth } from "@/lib/thumper-auth-context";

// Tier 1A front door: anonymous visitors can reach a working Local-mode
// chat without signing in. The auth gate moves *inside* the page —
// modes that require an identity (Private, history persistence, on-chain
// receipt writes) prompt sign-in at the point of use rather than
// blocking access to the surface entirely.
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { loading } = useThumperAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#08090d]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#08090d] text-[#eef1f8] overflow-hidden">
      {children}
    </div>
  );
}
