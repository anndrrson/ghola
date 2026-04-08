"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getAgent } from "@/lib/api";
import type { AgentDetail } from "@/lib/types";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { Loader2 } from "lucide-react";

export default function AgentDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { authenticated, loading: authLoading } = useAuth();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!authenticated) {
      router.push(`/identity/login?redirect=/agents/${params.id}`);
      return;
    }
    if (!params.id) return;
    getAgent(params.id)
      .then((a) => {
        setAgent(a);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.id, authenticated, authLoading, router]);

  if (authLoading || loading) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <Loader2 className="h-8 w-8 animate-spin text-[#3da8ff]" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="min-h-screen pt-24 px-4">
        <div className="mx-auto max-w-2xl text-center py-20">
          <h1 className="text-2xl font-medium text-[#eef1f8] mb-3">
            Agent not found
          </h1>
          <p className="text-[#8b95a8] mb-6">
            {error || "This agent doesn't exist or you don't have access to it."}
          </p>
          <button
            onClick={() => router.push("/agents")}
            className="rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            Back to my agents
          </button>
        </div>
      </div>
    );
  }

  return <AgentSidebar agent={agent}>{children}</AgentSidebar>;
}
