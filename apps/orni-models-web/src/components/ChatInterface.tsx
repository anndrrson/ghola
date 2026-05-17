"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { sendMessage, getSessionMessages } from "@/lib/api";
import { Send, Loader2 } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatInterfaceProps {
  slug: string;
  pricePerQuery: number;
  balance: number | null;
  onBalanceUpdate?: () => void;
  initialSessionId?: string;
  onSessionChange?: (sessionId: string) => void;
}

export default function ChatInterface({
  slug,
  pricePerQuery,
  balance,
  onBalanceUpdate,
  initialSessionId,
  onSessionChange,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load history when resuming a session
  useEffect(() => {
    if (initialSessionId) {
      getSessionMessages(initialSessionId)
        .then((msgs) => {
          setMessages(
            msgs
              .filter((m) => m.role !== "system")
              .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
          );
          setSessionId(initialSessionId);
        })
        .catch(() => {});
    }
  }, [initialSessionId]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    if (balance !== null && balance < pricePerQuery) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Insufficient balance. You need at least $${pricePerQuery.toFixed(2)} per query. Please deposit funds.`,
        },
      ]);
      return;
    }

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsStreaming(true);

    const assistantIndex =
      messages.length + 1; // +1 for user message just added

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const stream = sendMessage(slug, text, sessionId, (newSessionId) => {
        setSessionId(newSessionId);
        onSessionChange?.(newSessionId);
      });
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setMessages((prev) => {
          const updated = [...prev];
          updated[assistantIndex] = {
            ...updated[assistantIndex],
            content: updated[assistantIndex].content + value,
          };
          return updated;
        });
      }
      onBalanceUpdate?.();
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[assistantIndex] = {
          ...updated[assistantIndex],
          content:
            updated[assistantIndex].content ||
            `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-[#666] text-sm">
              Send a message to start chatting
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-[#1a1a1a] text-[#fafafa] border border-[#262626]"
                  : "bg-[#141414] border border-[#222] text-[#a1a1a1]"
              }`}
            >
              {msg.content}
              {msg.role === "assistant" && !msg.content && isStreaming && (
                <span className="inline-flex gap-1.5 py-1">
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="border-t border-[#262626] p-4">
        <div className="flex items-center gap-2 text-xs text-[#666] mb-2">
          <span>Cost: ${pricePerQuery.toFixed(2)}/message</span>
          {balance !== null && <span>| Balance: ${balance.toFixed(2)}</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Type a message..."
            disabled={isStreaming}
            className="flex-1 rounded-lg bg-[#141414] border border-[#262626] px-4 py-2.5 text-sm text-[#fafafa] placeholder-[#666] outline-none transition-colors focus:border-[#444]"
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
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
