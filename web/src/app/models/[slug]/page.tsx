"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { getModel, getBalance } from "@/lib/api";
import type { Model } from "@/lib/types";
import { useWalletAuth } from "@/lib/wallet-provider";
import ChatInterface from "@/components/ChatInterface";
import { MessageSquare, Star, Clock, DollarSign } from "lucide-react";
import Link from "next/link";

export default function ModelDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { authenticated } = useWalletAuth();
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
        <div className="h-96 animate-pulse rounded-xl bg-gray-900" />
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-bold">Model not found</h1>
        <Link href="/models" className="text-coral-400 hover:text-coral-300">
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
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-coral-500 to-said-500 text-lg font-bold text-white">
                {model.creator_name?.[0]?.toUpperCase() || "?"}
              </div>
              <div>
                <h1 className="text-xl font-bold">{model.name}</h1>
                <p className="text-sm text-gray-400">{model.creator_name}</p>
              </div>
            </div>
            <span className="mb-4 inline-block rounded-full bg-coral-500/10 px-3 py-1 text-xs font-medium text-coral-400">
              {model.category}
            </span>
            <p className="mb-6 text-sm text-gray-400">{model.description}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-gray-800 p-3 text-center">
                <DollarSign className="mx-auto mb-1 h-4 w-4 text-coral-400" />
                <p className="text-lg font-bold">
                  ${model.price_per_query.toFixed(2)}
                </p>
                <p className="text-xs text-gray-500">per query</p>
              </div>
              <div className="rounded-lg bg-gray-800 p-3 text-center">
                <MessageSquare className="mx-auto mb-1 h-4 w-4 text-coral-400" />
                <p className="text-lg font-bold">
                  {model.total_queries.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500">queries</p>
              </div>
              <div className="rounded-lg bg-gray-800 p-3 text-center">
                <Clock className="mx-auto mb-1 h-4 w-4 text-gray-400" />
                <p className="text-sm font-medium">
                  {new Date(model.created_at).toLocaleDateString()}
                </p>
                <p className="text-xs text-gray-500">created</p>
              </div>
            </div>
          </div>
          {authenticated && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-center">
              <p className="text-sm text-gray-400">Your Balance</p>
              <p className="text-2xl font-bold text-white">
                ${balance !== null ? balance.toFixed(2) : "--"}
              </p>
              <Link
                href="/models/account"
                className="mt-2 inline-block text-xs text-coral-400 hover:text-coral-300"
              >
                Add funds
              </Link>
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="flex h-[calc(100vh-8rem)] flex-col rounded-xl border border-gray-800 bg-gray-900">
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
                <p className="mb-2 text-gray-400">
                  Connect your wallet to start chatting
                </p>
                <p className="text-xs text-gray-600">
                  Each message costs ${model.price_per_query.toFixed(2)}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
