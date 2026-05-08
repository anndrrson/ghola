"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { sendMessage } from "@/lib/api";
import { Loader2 } from "lucide-react";

interface ModelInfo {
  slug: string;
  name: string;
}

interface CompareViewProps {
  modelA: ModelInfo;
  modelB: ModelInfo;
  message: string;
  onComplete: () => void;
}

export default function CompareView({
  modelA,
  modelB,
  message,
  onComplete,
}: CompareViewProps) {
  const [responseA, setResponseA] = useState("");
  const [responseB, setResponseB] = useState("");
  const [streamingA, setStreamingA] = useState(false);
  const [streamingB, setStreamingB] = useState(false);
  const [errorA, setErrorA] = useState<string | null>(null);
  const [errorB, setErrorB] = useState<string | null>(null);

  const colARef = useRef<HTMLDivElement>(null);
  const colBRef = useRef<HTMLDivElement>(null);

  const doneA = useRef(false);
  const doneB = useRef(false);

  const scrollToBottom = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (!message) return;

    setResponseA("");
    setResponseB("");
    setErrorA(null);
    setErrorB(null);
    setStreamingA(true);
    setStreamingB(true);
    doneA.current = false;
    doneB.current = false;

    const checkComplete = () => {
      if (doneA.current && doneB.current) {
        onComplete();
      }
    };

    // Stream A
    (async () => {
      try {
        const stream = sendMessage(modelA.slug, message);
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setResponseA((prev) => prev + value);
        }
      } catch (err) {
        setErrorA(err instanceof Error ? err.message : "Stream failed");
      } finally {
        setStreamingA(false);
        doneA.current = true;
        checkComplete();
      }
    })();

    // Stream B
    (async () => {
      try {
        const stream = sendMessage(modelB.slug, message);
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setResponseB((prev) => prev + value);
        }
      } catch (err) {
        setErrorB(err instanceof Error ? err.message : "Stream failed");
      } finally {
        setStreamingB(false);
        doneB.current = true;
        checkComplete();
      }
    })();
  }, [message, modelA.slug, modelB.slug, onComplete]);

  // Auto-scroll as content streams in
  useEffect(() => {
    scrollToBottom(colARef);
  }, [responseA, scrollToBottom]);

  useEffect(() => {
    scrollToBottom(colBRef);
  }, [responseB, scrollToBottom]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Column A */}
      <div className="flex flex-col bg-[#141414] border border-[#262626] rounded-lg">
        <div className="flex items-center gap-2 border-b border-[#262626] px-4 py-3">
          <div className="h-2.5 w-2.5 rounded-full bg-[#fafafa]" />
          <h3 className="text-sm font-medium text-[#fafafa]">{modelA.name}</h3>
          {streamingA && (
            <Loader2 className="ml-auto h-4 w-4 animate-spin text-[#a1a1a1]" />
          )}
        </div>
        <div
          ref={colARef}
          className="flex-1 overflow-y-auto p-4 text-sm text-[#a1a1a1] whitespace-pre-wrap min-h-[200px] max-h-[500px]"
        >
          {responseA}
          {!responseA && streamingA && (
            <span className="inline-flex gap-1.5">
              <span className="streaming-dot" />
              <span className="streaming-dot" />
              <span className="streaming-dot" />
            </span>
          )}
          {errorA && (
            <p className="text-[#ef4444]">Error: {errorA}</p>
          )}
        </div>
      </div>

      {/* Column B */}
      <div className="flex flex-col bg-[#141414] border border-[#262626] rounded-lg">
        <div className="flex items-center gap-2 border-b border-[#262626] px-4 py-3">
          <div className="h-2.5 w-2.5 rounded-full bg-[#666]" />
          <h3 className="text-sm font-medium text-[#fafafa]">{modelB.name}</h3>
          {streamingB && (
            <Loader2 className="ml-auto h-4 w-4 animate-spin text-[#a1a1a1]" />
          )}
        </div>
        <div
          ref={colBRef}
          className="flex-1 overflow-y-auto p-4 text-sm text-[#a1a1a1] whitespace-pre-wrap min-h-[200px] max-h-[500px]"
        >
          {responseB}
          {!responseB && streamingB && (
            <span className="inline-flex gap-1.5">
              <span className="streaming-dot" />
              <span className="streaming-dot" />
              <span className="streaming-dot" />
            </span>
          )}
          {errorB && (
            <p className="text-[#ef4444]">Error: {errorB}</p>
          )}
        </div>
      </div>
    </div>
  );
}
