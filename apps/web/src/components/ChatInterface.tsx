"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { sendMessage } from "@/lib/api";
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
}

export default function ChatInterface({
  slug,
  pricePerQuery,
  balance,
  onBalanceUpdate,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

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
      const stream = sendMessage(slug, text, sessionId);
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
            <p className="text-[#4a5568] text-sm">
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
              className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-[#5bb8ff] text-[#eef1f8]"
                  : "bg-[#161822] text-[#eef1f8]"
              }`}
            >
              {msg.content}
              {msg.role === "assistant" && !msg.content && isStreaming && (
                <span className="inline-flex gap-1">
                  <span className="animate-pulse">.</span>
                  <span className="animate-pulse delay-100">.</span>
                  <span className="animate-pulse delay-200">.</span>
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="border-t border-[#1e2a3a] p-4">
        <div className="flex items-center gap-2 text-xs text-[#4a5568] mb-2">
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
            className="flex-1 rounded-xl border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none transition focus:border-[#3da8ff]"
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5bb8ff] text-[#eef1f8] transition hover:bg-[#3da8ff] disabled:opacity-50 disabled:hover:bg-[#5bb8ff]"
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
