"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { getModel, getBalance } from "@/lib/api";
import type { Model } from "@/lib/types";
import { useWalletAuth } from "@/lib/wallet-provider";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import ChatInterface from "@/components/ChatInterface";
import { MessageSquare, Star, Clock, DollarSign, ShieldCheck } from "lucide-react";
import Link from "next/link";

export default function ModelDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { authenticated } = useWalletAuth();
  const thumperAuth = useThumperAuth();
  const [model, setModel] = useState<Model | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchBalance = useCallback(() => {
    if (authenticated) {
      getBalance()
        .then((b) => setBalance(b.balance))
        .catch(() => setBalance(null));
    }
  }, [authenticated]);

  useEffect(() => {
    getModel(slug)
      .then(setModel)
      .catch(() => setError("Model not found"))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="h-96 animate-pulse rounded-xl bg-[#0f1117]" />
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-bold">Model not found</h1>
        <Link href="/models" className="text-[#D4A04A] hover:text-[#D4A04A]">
          Back to browse
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        {/* Model Info */}
        <div className="space-y-4">
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#D4A04A] to-[#3da8ff] text-lg font-bold text-[#eef1f8]">
                {model.creator_name?.[0]?.toUpperCase() || "?"}
              </div>
              <div>
                <h1 className="text-xl font-bold">{model.name}</h1>
                <p className="text-sm text-[#8b95a8]">{model.creator_name}</p>
                {model.creator_verified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#3da8ff]/10 px-2 py-0.5 text-xs font-medium text-[#3da8ff]">
                    <ShieldCheck className="h-3 w-3" />
                    Verified Identity
                  </span>
                )}
              </div>
            </div>
            <span className="mb-4 inline-block rounded-full bg-[#D4A04A]/10 px-3 py-1 text-xs font-medium text-[#D4A04A]">
              {model.category}
            </span>
            <p className="mb-6 text-sm text-[#8b95a8]">{model.description}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-[#161822] p-3 text-center">
                <DollarSign className="mx-auto mb-1 h-4 w-4 text-[#D4A04A]" />
                <p className="text-lg font-bold">
                  ${model.price_per_query.toFixed(2)}
                </p>
                <p className="text-xs text-[#4a5568]">per query</p>
              </div>
              <div className="rounded-lg bg-[#161822] p-3 text-center">
                <MessageSquare className="mx-auto mb-1 h-4 w-4 text-[#D4A04A]" />
                <p className="text-lg font-bold">
                  {model.total_queries.toLocaleString()}
                </p>
                <p className="text-xs text-[#4a5568]">queries</p>
              </div>
              <div className="rounded-lg bg-[#161822] p-3 text-center">
                <Clock className="mx-auto mb-1 h-4 w-4 text-[#8b95a8]" />
                <p className="text-sm font-medium">
                  {new Date(model.created_at).toLocaleDateString()}
                </p>
                <p className="text-xs text-[#4a5568]">created</p>
              </div>
            </div>
          </div>
          {authenticated && (
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4 text-center">
              <p className="text-sm text-[#8b95a8]">Your Balance</p>
              <p className="text-2xl font-bold text-[#eef1f8]">
                ${balance !== null ? balance.toFixed(2) : "--"}
              </p>
              <Link
                href="/models/account"
                className="mt-2 inline-block text-xs text-[#D4A04A] hover:text-[#D4A04A]"
              >
                Add funds
              </Link>
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="flex h-[calc(100vh-8rem)] flex-col rounded-xl border border-[#1e2a3a] bg-[#0f1117]">
          {authenticated ? (
            <ChatInterface
              slug={slug}
              pricePerQuery={model.price_per_query}
              balance={balance}
              onBalanceUpdate={fetchBalance}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                {thumperAuth.authenticated ? (
                  <>
                    <p className="mb-2 text-[#8b95a8]">
                      Setting up your wallet...
                    </p>
                    <p className="text-xs text-[#4a5568]">
                      This should only take a moment
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-[#8b95a8]">
                      Sign in to start chatting
                    </p>
                    <p className="text-xs text-[#4a5568] mb-4">
                      Each message costs ${model.price_per_query.toFixed(2)}
                    </p>
                    <Link
                      href="/signup"
                      className="rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
                    >
                      Get started free
                    </Link>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
