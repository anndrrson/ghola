"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getModel,
  getBalance,
  getModelUsage,
  type Model,
  type UsageInfo,
} from "@/lib/api";
import { useAuth } from "@/lib/wallet-provider";
import ChatInterface from "@/components/ChatInterface";
import ConversationSidebar from "@/components/ConversationSidebar";
import StarRating from "@/components/StarRating";
import ReviewSection from "@/components/ReviewSection";
import {
  MessageSquare,
  Clock,
  DollarSign,
  Code2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Zap,
} from "lucide-react";
import Link from "next/link";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";

export default function ModelDetailClient({ slug }: { slug: string }) {
  const { authenticated } = useAuth();
  const [model, setModel] = useState<Model | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [apiPanelOpen, setApiPanelOpen] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  const fetchBalance = useCallback(() => {
    if (authenticated) {
      getBalance()
        // Sum across stablecoins (USDT + USDC, both 1:1 USD).
        .then((b) => setBalance(b.balances.reduce((s, x) => s + x.balance, 0)))
        .catch(() => setBalance(null));
    }
  }, [authenticated]);

  const fetchUsage = useCallback(() => {
    if (authenticated) {
      getModelUsage(slug)
        .then(setUsage)
        .catch(() => setUsage(null));
    }
  }, [authenticated, slug]);

  useEffect(() => {
    getModel(slug)
      .then(setModel)
      .catch(() => setError("Model not found"))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const handleBalanceUpdate = useCallback(() => {
    fetchBalance();
    fetchUsage();
  }, [fetchBalance, fetchUsage]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  const handleSessionChange = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  const copyToClipboard = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedSnippet(key);
      setTimeout(() => setCopiedSnippet(null), 2000);
    });
  }, []);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          <div className="space-y-4">
            <div className="h-72 animate-pulse rounded-lg bg-[#141414]" />
            <div className="h-24 animate-pulse rounded-lg bg-[#141414]" />
          </div>
          <div className="h-[calc(100vh-8rem)] animate-pulse rounded-lg bg-[#141414]" />
        </div>
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-medium">Model not found</h1>
        <Link href="/models" className="text-[#a1a1a1] hover:text-[#fafafa] transition-colors">
          Back to browse
        </Link>
      </div>
    );
  }

  const priceDisplay =
    model.free_queries_per_day && model.free_queries_per_day > 0
      ? `${model.free_queries_per_day} free/day`
      : `$${model.price_per_query.toFixed(2)}/query`;

  const endpointUrl = `${API_BASE}/chat/${slug}/message`;

  const curlSnippet = `curl -X POST "${endpointUrl}" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello!"}'`;

  const pythonSnippet = `import requests

response = requests.post(
    "${endpointUrl}",
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json",
    },
    json={"message": "Hello!"},
    stream=True,
)

for line in response.iter_lines():
    if line:
        print(line.decode())`;

  const jsSnippet = `const response = await fetch("${endpointUrl}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ message: "Hello!" }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        {/* Left column */}
        <div className="space-y-4">
          {/* Model info card */}
          <div className="bg-[#141414] border border-[#262626] rounded-lg p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#222] text-lg font-medium text-[#fafafa]">
                {model.creator_name?.[0]?.toUpperCase() || "?"}
              </div>
              <div>
                <h1 className="text-xl font-medium">{model.name}</h1>
                <p className="text-sm text-[#a1a1a1]">
                  {model.creator_slug ? (
                    <Link
                      href={`/creators/${model.creator_slug}`}
                      className="hover:text-[#fafafa] transition-colors"
                    >
                      {model.creator_name}
                    </Link>
                  ) : (
                    model.creator_name
                  )}
                </p>
              </div>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              {model.category && (
                <span className="rounded-full bg-[#222] px-3 py-1 text-xs font-medium text-[#a1a1a1] border border-[#333]">
                  {model.category}
                </span>
              )}
              {model.free_queries_per_day && model.free_queries_per_day > 0 && (
                <span className="rounded-full bg-[#00E5A0]/10 px-3 py-1 text-xs font-medium text-[#00E5A0] border border-[#00E5A0]/20">
                  {model.free_queries_per_day} free/day
                </span>
              )}
            </div>

            {model.review_count > 0 && (
              <div className="mb-4 flex items-center gap-2">
                <StarRating rating={model.avg_rating} size="sm" />
                <span className="text-sm text-[#a1a1a1]">
                  {model.avg_rating.toFixed(1)}
                </span>
                <span className="text-xs text-[#666]">
                  ({model.review_count}{" "}
                  {model.review_count === 1 ? "review" : "reviews"})
                </span>
              </div>
            )}

            <p className="mb-6 text-sm text-[#a1a1a1]">{model.description}</p>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-[#1a1a1a] p-3 text-center">
                <DollarSign className="mx-auto mb-1 h-4 w-4 text-[#a1a1a1]" />
                <p className="text-lg font-medium">{priceDisplay}</p>
                <p className="text-xs text-[#666]">pricing</p>
              </div>
              <div className="rounded-lg bg-[#1a1a1a] p-3 text-center">
                <MessageSquare className="mx-auto mb-1 h-4 w-4 text-[#a1a1a1]" />
                <p className="text-lg font-medium">
                  {model.total_queries.toLocaleString()}
                </p>
                <p className="text-xs text-[#666]">queries</p>
              </div>
              <div className="rounded-lg bg-[#1a1a1a] p-3 text-center">
                <Clock className="mx-auto mb-1 h-4 w-4 text-[#a1a1a1]" />
                <p className="text-sm font-medium">
                  {new Date(model.created_at).toLocaleDateString()}
                </p>
                <p className="text-xs text-[#666]">created</p>
              </div>
              {model.tags && model.tags.length > 0 && (
                <div className="rounded-lg bg-[#1a1a1a] p-3 text-center">
                  <p className="text-xs text-[#a1a1a1] leading-relaxed">
                    {model.tags.slice(0, 3).join(", ")}
                  </p>
                  <p className="mt-1 text-xs text-[#666]">tags</p>
                </div>
              )}
            </div>
          </div>

          {/* Balance card */}
          {authenticated && (
            <div className="bg-[#141414] border border-[#262626] rounded-lg p-4 text-center">
              <p className="text-sm text-[#a1a1a1]">Your Balance</p>
              <p className="text-2xl font-medium text-[#00E5A0]">
                ${balance !== null ? balance.toFixed(2) : "--"}
              </p>
              <Link
                href="/account"
                className="mt-2 inline-block text-xs text-[#a1a1a1] hover:text-[#fafafa] transition-colors"
              >
                Add funds
              </Link>
            </div>
          )}

          {/* Free tier usage */}
          {authenticated && usage && usage.is_free && (
            <div className="bg-[#141414] border border-[#262626] rounded-lg p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-[#00E5A0]" />
                  <span className="text-sm font-medium text-[#a1a1a1]">
                    Free Usage
                  </span>
                </div>
                <span className="text-xs text-[#666]">
                  {usage.used}/{usage.limit} today
                </span>
              </div>
              <div className="h-2 rounded-full bg-[#1a1a1a]">
                <div
                  className={`h-2 rounded-full transition-all ${
                    usage.used >= usage.limit
                      ? "bg-[#ef4444]"
                      : usage.used >= usage.limit * 0.8
                        ? "bg-[#f59e0b]"
                        : "bg-[#00E5A0]"
                  }`}
                  style={{
                    width: `${Math.min((usage.used / usage.limit) * 100, 100)}%`,
                  }}
                />
              </div>
              {usage.used >= usage.limit && (
                <p className="mt-2 text-xs text-[#ef4444]">
                  Free tier limit reached. Add funds to continue.
                </p>
              )}
            </div>
          )}

          {/* Conversation history sidebar (desktop) */}
          {authenticated && (
            <div className="hidden lg:block">
              <ConversationSidebar
                slug={slug}
                onSelectSession={handleSelectSession}
              />
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Chat area */}
          <div className="flex h-[calc(100vh-8rem)] flex-col bg-[#141414] border border-[#262626] rounded-lg">
            {authenticated ? (
              <ChatInterface
                slug={slug}
                pricePerQuery={model.price_per_query}
                balance={balance}
                onBalanceUpdate={handleBalanceUpdate}
                initialSessionId={activeSessionId || undefined}
                onSessionChange={handleSessionChange}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#1a1a1a]">
                    <MessageSquare className="h-7 w-7 text-[#666]" />
                  </div>
                  <p className="mb-2 text-[#a1a1a1]">
                    Connect your wallet to start chatting
                  </p>
                  <p className="text-xs text-[#666]">
                    Each message costs {priceDisplay}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Conversation history (mobile) */}
          {authenticated && (
            <div className="lg:hidden">
              <ConversationSidebar
                slug={slug}
                onSelectSession={handleSelectSession}
              />
            </div>
          )}

          {/* API Access panel */}
          <div className="bg-[#141414] border border-[#262626] rounded-lg">
            <button
              onClick={() => setApiPanelOpen(!apiPanelOpen)}
              className="flex w-full items-center justify-between p-4 text-left"
            >
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-[#fafafa]" />
                <h3 className="font-medium text-[#fafafa]">API Access</h3>
              </div>
              {apiPanelOpen ? (
                <ChevronUp className="h-4 w-4 text-[#a1a1a1]" />
              ) : (
                <ChevronDown className="h-4 w-4 text-[#a1a1a1]" />
              )}
            </button>

            {apiPanelOpen && (
              <div className="border-t border-[#262626] p-4 space-y-4">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-[#a1a1a1]">
                    Endpoint
                  </p>
                  <div className="flex items-center gap-2 rounded-lg bg-[#111] border border-[#262626] px-3 py-2">
                    <code className="flex-1 truncate text-sm text-[#a1a1a1] font-mono">
                      POST {endpointUrl}
                    </code>
                    <button
                      onClick={() => copyToClipboard(endpointUrl, "endpoint")}
                      className="shrink-0 rounded p-1 text-[#666] transition-colors hover:bg-[#1a1a1a] hover:text-[#a1a1a1]"
                    >
                      {copiedSnippet === "endpoint" ? (
                        <Check className="h-3.5 w-3.5 text-[#00E5A0]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <CodeSnippet
                  label="cURL"
                  code={curlSnippet}
                  snippetKey="curl"
                  copiedSnippet={copiedSnippet}
                  onCopy={copyToClipboard}
                />
                <CodeSnippet
                  label="Python"
                  code={pythonSnippet}
                  snippetKey="python"
                  copiedSnippet={copiedSnippet}
                  onCopy={copyToClipboard}
                />
                <CodeSnippet
                  label="JavaScript"
                  code={jsSnippet}
                  snippetKey="js"
                  copiedSnippet={copiedSnippet}
                  onCopy={copyToClipboard}
                />

                <p className="text-xs text-[#666]">
                  Create an API key from your{" "}
                  <Link
                    href="/account"
                    className="text-[#a1a1a1] hover:text-[#fafafa] transition-colors"
                  >
                    account page
                  </Link>{" "}
                  to use the API.
                </p>
              </div>
            )}
          </div>

          {/* Reviews section */}
          <ReviewSection slug={slug} authenticated={authenticated} />
        </div>
      </div>
    </div>
  );
}

function CodeSnippet({
  label,
  code,
  snippetKey,
  copiedSnippet,
  onCopy,
}: {
  label: string;
  code: string;
  snippetKey: string;
  copiedSnippet: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-medium text-[#a1a1a1]">{label}</p>
        <button
          onClick={() => onCopy(code, snippetKey)}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-[#666] transition-colors hover:bg-[#1a1a1a] hover:text-[#a1a1a1]"
        >
          {copiedSnippet === snippetKey ? (
            <>
              <Check className="h-3 w-3 text-[#00E5A0]" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-[#111] border border-[#262626] p-3 text-xs text-[#a1a1a1] font-mono leading-relaxed">
        {code}
      </pre>
    </div>
  );
}
