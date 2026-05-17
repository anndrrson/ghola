"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Key, Code, BarChart3, Zap, Cpu, Wrench } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";

export default function DevelopersPage() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/signin");
    }
  }, [authenticated, loading, router]);

  if (loading || !authenticated) return null;

  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <div className="mx-auto max-w-4xl px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-medium tracking-tight text-[#eef1f8]">
            Build with <span className="text-[#3da8ff]">ghola</span>
          </h1>
          <p className="mt-4 text-lg text-[#8b95a8] max-w-2xl mx-auto">
            Access ghola&apos;s AI capabilities through an OpenAI-compatible API.
            Make phone calls, send emails, and chat — all programmatically.
          </p>
        </div>

        {/* Quick Actions */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
          <Link
            href="/developers/keys"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-6 py-3 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
          >
            <Key className="h-4 w-4" />
            Get API Key
          </Link>
          <Link
            href="/developers/docs"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-6 py-3 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors"
          >
            <Code className="h-4 w-4" />
            Read the Docs
          </Link>
        </div>

        {/* Feature Cards */}
        <div className="grid gap-6 sm:grid-cols-3 mb-16">
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#2a3a50] transition-colors">
            <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
              <Zap className="h-5 w-5 text-[#3da8ff]" />
            </div>
            <h3 className="text-[#eef1f8] font-medium mb-1.5">OpenAI Compatible</h3>
            <p className="text-sm text-[#8b95a8] leading-relaxed">
              Drop-in replacement for the OpenAI API. Use any OpenAI SDK or library — just change the base URL.
            </p>
          </div>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#2a3a50] transition-colors">
            <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
              <Wrench className="h-5 w-5 text-[#3da8ff]" />
            </div>
            <h3 className="text-[#eef1f8] font-medium mb-1.5">Real-World Actions</h3>
            <p className="text-sm text-[#8b95a8] leading-relaxed">
              Beyond chat: trigger phone calls, send emails, and manage calendars through the same API.
            </p>
          </div>
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#2a3a50] transition-colors">
            <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
              <Cpu className="h-5 w-5 text-[#3da8ff]" />
            </div>
            <h3 className="text-[#eef1f8] font-medium mb-1.5">Bring Your Own Model</h3>
            <p className="text-sm text-[#8b95a8] leading-relaxed">
              Use Claude, GPT-4, Gemini, Llama, or any OpenAI-compatible provider. Your keys, your choice.
            </p>
          </div>
        </div>

        {/* Code Example */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] overflow-hidden mb-16">
          <div className="border-b border-[#1e2a3a] px-4 py-2.5 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[#1e2a3a]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#1e2a3a]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#1e2a3a]" />
            </div>
            <span className="text-xs text-[#4a5568] ml-2">Quick start</span>
          </div>
          <pre className="p-4 text-sm text-[#8b95a8] overflow-x-auto">
            <code>{`curl https://ghola.xyz/v1/chat/completions \\
  -H "Authorization: Bearer sk-ghola-your-key-here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'`}</code>
          </pre>
        </div>

        {/* Merchant API Banner */}
        <Link
          href="/developers/merchant"
          className="group block rounded-xl border border-[#3da8ff]/30 bg-[#3da8ff]/5 p-5 hover:border-[#3da8ff]/50 transition-colors mb-8"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#3da8ff] mb-1.5">
                NEW
              </span>
              <h3 className="text-sm font-medium text-[#eef1f8] mb-1">Merchant API — Headless Commerce</h3>
              <p className="text-xs text-[#8b95a8]">Register your API as a headless merchant. Verify agents. Get paid per request via x402.</p>
            </div>
            <ArrowRight className="h-4 w-4 text-[#3da8ff] shrink-0 ml-4" />
          </div>
        </Link>

        {/* Navigation Cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Link
            href="/developers/keys"
            className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#2a3a50] transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-[#eef1f8] mb-1">API Keys</h3>
                <p className="text-xs text-[#4a5568]">Create and manage keys</p>
              </div>
              <ArrowRight className="h-4 w-4 text-[#4a5568] group-hover:text-[#3da8ff] transition-colors" />
            </div>
          </Link>
          <Link
            href="/developers/docs"
            className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#2a3a50] transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-[#eef1f8] mb-1">Documentation</h3>
                <p className="text-xs text-[#4a5568]">Endpoints and examples</p>
              </div>
              <ArrowRight className="h-4 w-4 text-[#4a5568] group-hover:text-[#3da8ff] transition-colors" />
            </div>
          </Link>
          <Link
            href="/developers/usage"
            className="group rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 hover:border-[#2a3a50] transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-[#eef1f8] mb-1">Usage</h3>
                <p className="text-xs text-[#4a5568]">Monitor API calls</p>
              </div>
              <ArrowRight className="h-4 w-4 text-[#4a5568] group-hover:text-[#3da8ff] transition-colors" />
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
