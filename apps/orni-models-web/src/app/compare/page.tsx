"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getModels, type Model } from "@/lib/api";
import CompareView from "@/components/CompareView";
import { Send, Loader2, ArrowLeftRight, ThumbsUp, RotateCcw } from "lucide-react";

function ComparePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  const [slugA, setSlugA] = useState(searchParams.get("a") || "");
  const [slugB, setSlugB] = useState(searchParams.get("b") || "");

  const [input, setInput] = useState("");
  const [activeMessage, setActiveMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [bothDone, setBothDone] = useState(false);
  const [vote, setVote] = useState<"a" | "b" | null>(null);

  // Fetch all available models
  useEffect(() => {
    (async () => {
      try {
        const res = await getModels({ limit: 100 });
        setModels(res.models);
      } catch {
        setModels([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Sync URL params when selectors change
  useEffect(() => {
    const params = new URLSearchParams();
    if (slugA) params.set("a", slugA);
    if (slugB) params.set("b", slugB);
    const qs = params.toString();
    router.replace(`/compare${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [slugA, slugB, router]);

  const modelA = models.find((m) => m.slug === slugA);
  const modelB = models.find((m) => m.slug === slugB);

  const canCompare = slugA && slugB && slugA !== slugB;

  const handleSend = () => {
    const text = input.trim();
    if (!text || !canCompare || isStreaming) return;
    setInput("");
    setActiveMessage(text);
    setIsStreaming(true);
    setBothDone(false);
    setVote(null);
  };

  const handleComplete = useCallback(() => {
    setIsStreaming(false);
    setBothDone(true);
  }, []);

  const handleSwap = () => {
    const tmpA = slugA;
    setSlugA(slugB);
    setSlugB(tmpA);
  };

  const handleReset = () => {
    setActiveMessage("");
    setIsStreaming(false);
    setBothDone(false);
    setVote(null);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-medium">Compare Models</h1>
        <p className="mt-2 text-sm text-[#a1a1a1]">
          Send the same question to two models and see how they stack up side by side.
        </p>
      </div>

      {/* Model Selectors */}
      <div className="mb-6 flex flex-col items-center gap-3 md:flex-row">
        <div className="flex-1 w-full">
          <label className="mb-1.5 block text-xs font-medium text-[#a1a1a1]">Model A</label>
          <select
            value={slugA}
            onChange={(e) => setSlugA(e.target.value)}
            disabled={isStreaming}
            className="w-full rounded-lg bg-[#141414] border border-[#262626] px-4 py-2.5 text-sm text-[#a1a1a1] outline-none transition-colors focus:border-[#444] disabled:opacity-50"
          >
            <option value="">Select a model...</option>
            {models
              .filter((m) => m.slug !== slugB)
              .map((m) => (
                <option key={m.id} value={m.slug}>
                  {m.name} {m.creator_name ? `by ${m.creator_name}` : ""}
                </option>
              ))}
          </select>
        </div>

        <button
          onClick={handleSwap}
          disabled={isStreaming || !slugA || !slugB}
          className="mt-5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#262626] bg-[#141414] text-[#a1a1a1] transition-colors hover:border-[#333] hover:text-[#fafafa] disabled:opacity-30 active:scale-[0.98]"
          title="Swap models"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>

        <div className="flex-1 w-full">
          <label className="mb-1.5 block text-xs font-medium text-[#a1a1a1]">Model B</label>
          <select
            value={slugB}
            onChange={(e) => setSlugB(e.target.value)}
            disabled={isStreaming}
            className="w-full rounded-lg bg-[#141414] border border-[#262626] px-4 py-2.5 text-sm text-[#a1a1a1] outline-none transition-colors focus:border-[#444] disabled:opacity-50"
          >
            <option value="">Select a model...</option>
            {models
              .filter((m) => m.slug !== slugA)
              .map((m) => (
                <option key={m.id} value={m.slug}>
                  {m.name} {m.creator_name ? `by ${m.creator_name}` : ""}
                </option>
              ))}
          </select>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-[#666]" />
        </div>
      )}

      {/* Compare View */}
      {activeMessage && modelA && modelB && (
        <div className="mb-6">
          <div className="mb-3 bg-[#141414] border border-[#262626] rounded-lg px-4 py-3">
            <p className="text-xs font-medium text-[#666] mb-1">Your question</p>
            <p className="text-sm text-[#a1a1a1]">{activeMessage}</p>
          </div>

          <CompareView
            modelA={{ slug: modelA.slug, name: modelA.name }}
            modelB={{ slug: modelB.slug, name: modelB.name }}
            message={activeMessage}
            onComplete={handleComplete}
          />

          {/* Vote Buttons */}
          {bothDone && (
            <div className="mt-4 flex flex-col items-center gap-3">
              <p className="text-sm font-medium text-[#a1a1a1]">Which response was better?</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setVote("a")}
                  className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors active:scale-[0.98] ${
                    vote === "a"
                      ? "bg-[#fafafa] text-[#0a0a0a]"
                      : "border border-[#262626] bg-[#141414] text-[#a1a1a1] hover:border-[#333] hover:text-[#fafafa]"
                  }`}
                >
                  <ThumbsUp className="h-4 w-4" />
                  {modelA.name}
                </button>
                <button
                  onClick={() => setVote("b")}
                  className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors active:scale-[0.98] ${
                    vote === "b"
                      ? "bg-[#fafafa] text-[#0a0a0a]"
                      : "border border-[#262626] bg-[#141414] text-[#a1a1a1] hover:border-[#333] hover:text-[#fafafa]"
                  }`}
                >
                  <ThumbsUp className="h-4 w-4" />
                  {modelB.name}
                </button>
                <button
                  onClick={handleReset}
                  className="flex items-center gap-2 rounded-lg border border-[#262626] bg-[#141414] px-4 py-2.5 text-sm text-[#a1a1a1] transition-colors hover:border-[#333] hover:text-[#fafafa] active:scale-[0.98]"
                >
                  <RotateCcw className="h-4 w-4" />
                  Try again
                </button>
              </div>
              {vote && (
                <p className="text-xs text-[#666] mt-1">
                  You voted for <span className="text-[#fafafa]">{vote === "a" ? modelA.name : modelB.name}</span>. Thanks for the feedback!
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!activeMessage && !loading && (
        <div className="mb-6 flex items-center justify-center bg-[#141414] border border-[#262626] rounded-lg py-20">
          <div className="text-center">
            <ArrowLeftRight className="mx-auto mb-3 h-8 w-8 text-[#666]" />
            <p className="text-sm text-[#666]">
              {canCompare
                ? "Type a message below to compare both models"
                : "Select two different models to get started"}
            </p>
          </div>
        </div>
      )}

      {/* Input Bar */}
      <div className="bg-[#141414] border border-[#262626] rounded-lg p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={
              canCompare
                ? "Ask both models the same question..."
                : "Select two models first..."
            }
            disabled={isStreaming || !canCompare}
            className="flex-1 rounded-lg bg-[#0a0a0a] border border-[#262626] px-4 py-2.5 text-sm text-[#fafafa] placeholder-[#666] outline-none transition-colors focus:border-[#444] disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim() || !canCompare}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#fafafa] text-[#0a0a0a] transition-colors hover:bg-[#e5e5e5] disabled:opacity-50 active:scale-[0.98]"
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-6 w-6 animate-spin text-[#666]" />
        </div>
      }
    >
      <ComparePageInner />
    </Suspense>
  );
}
