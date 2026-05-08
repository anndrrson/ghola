"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { createProviderKey } from "@/lib/thumper-api";
import { GholaLogo } from "@/components/GholaLogo";

function CliAuthContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { authenticated, loading } = useThumperAuth();
  const [status, setStatus] = useState("Authorizing CLI...");
  const [error, setError] = useState("");
  const callbackPort = searchParams.get("callback_port");

  useEffect(() => {
    if (loading) return;

    if (!authenticated) {
      const params = new URLSearchParams();
      params.set("redirect", "/auth/cli");
      if (callbackPort) params.set("callback_port", callbackPort);
      router.replace(`/signin?${params.toString()}`);
      return;
    }

    if (!callbackPort) {
      setError("Missing callback_port parameter. Please retry from the CLI.");
      return;
    }

    async function authorize() {
      try {
        setStatus("Creating provider key...");
        const keyRes = await createProviderKey();

        setStatus("Sending key to CLI...");
        window.location.href = `http://localhost:${callbackPort}/callback?token=${encodeURIComponent(keyRes.key)}`;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create provider key");
      }
    }

    authorize();
  }, [authenticated, loading, callbackPort, router]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#08090d]">
      <div className="text-center">
        <GholaLogo size={40} className="text-[#eef1f8] mx-auto mb-4" />
        {error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6 max-w-md">
            <p className="text-red-400 mb-2">{error}</p>
            <p className="text-sm text-[#8b95a8]">
              Close this tab and try running <code className="text-[#3da8ff]">ghola login</code> again.
            </p>
          </div>
        ) : (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent mx-auto mb-4" />
            <p className="text-[#8b95a8]">{status}</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function CliAuthPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#08090d]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
        </div>
      }
    >
      <CliAuthContent />
    </Suspense>
  );
}
