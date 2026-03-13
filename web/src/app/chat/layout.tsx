"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { authenticated, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/identity/login");
    }
  }, [authenticated, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#08090d]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <div className="h-screen bg-[#08090d] text-[#eef1f8] overflow-hidden">
      {children}
    </div>
  );
}
