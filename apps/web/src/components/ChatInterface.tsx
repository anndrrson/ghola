"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2 } from "lucide-react";
import bs58 from "bs58";
import { didKeyFromVerifying } from "@/lib/chat-vault";
import {
  buildSealedChatCompletionsBody,
  openSealedAssistantPayload,
} from "@/lib/sealed-stream";
import {
  browserRailgunX402Provider,
  fetchWithRailgunX402,
} from "@/lib/railgun-x402-client";
import { selectRoute } from "@/lib/sovereignty";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatInterfaceProps {
  slug: string;
  modelId?: string;
  pricePerQuery: number;
  balance: number | null;
  onBalanceUpdate?: () => void;
}

interface SealedChatCompletionResponse {
  ciphertext_b64?: string;
}

interface PublicAgentMetadata {
  model_id?: string;
}

function formatMicroUsdc(microUsdc: number): string {
  const usd = microUsdc / 1_000_000;
  if (!Number.isFinite(usd) || usd <= 0) return "Free";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`;
  if (usd < 1) return `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
  return `$${usd.toFixed(2)}`;
}

function solanaAddressToDid(address: string): string | null {
  try {
    const pub = bs58.decode(address);
    if (pub.length !== 32) return null;
    return didKeyFromVerifying(pub);
  } catch {
    return null;
  }
}

async function fetchAgentModelId(slug: string): Promise<string | null> {
  const res = await fetch(`/api/agents/${encodeURIComponent(slug)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;

  const metadata = (await res.json().catch(() => null)) as PublicAgentMetadata | null;
  return typeof metadata?.model_id === "string" && metadata.model_id.trim()
    ? metadata.model_id
    : null;
}

export default function ChatInterface({
  slug,
  modelId,
  pricePerQuery,
  balance,
  onBalanceUpdate,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { walletAddress, signBytes } = useTurnkeyWallet();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    const nextMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsStreaming(true);

    const assistantIndex =
      messages.length + 1; // +1 for user message just added

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      if (!walletAddress) {
        throw new Error("Private agent chat requires a connected Turnkey wallet.");
      }
      const senderDid = solanaAddressToDid(walletAddress);
      if (!senderDid) {
        throw new Error("Private agent chat could not derive a DID for this wallet.");
      }
      const paymentProvider = browserRailgunX402Provider();
      if (!paymentProvider) {
        throw new Error(
          "Railgun x402 payment provider is not available in this browser. The prompt was not sent.",
        );
      }

      const requestedModelId = (await fetchAgentModelId(slug)) ?? modelId ?? slug;
      const route = await selectRoute("private", requestedModelId);
      if (route.transport !== "relay-sealed" || !route.enclave) {
        throw new Error(
          route.caveat ??
            "Private route unavailable: no attested enclave can receive this agent prompt.",
        );
      }

      const sealed = await buildSealedChatCompletionsBody({
        routeModel: `agent:${slug}`,
        modelId: requestedModelId,
        messages: nextMessages,
        enclave: route.enclave,
        signBytes,
        senderDid,
        maxTokens: 2048,
        stream: false,
      });
      const target = new URL("/v1/chat/completions", window.location.origin);
      const res = await fetchWithRailgunX402(target, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: sealed.body,
        provider: paymentProvider,
        rail: "private_shielded_auto",
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          detail || `Private agent request failed with HTTP ${res.status}`,
        );
      }

      const payload = (await res.json()) as SealedChatCompletionResponse;
      if (!payload.ciphertext_b64) {
        throw new Error("Private agent response did not include sealed ciphertext.");
      }
      const decoded = await openSealedAssistantPayload(
        payload.ciphertext_b64,
        signBytes,
      );
      setMessages((prev) => {
        const updated = [...prev];
        updated[assistantIndex] = {
          ...updated[assistantIndex],
          content: decoded.text,
        };
        return updated;
      });
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
          <span>Private x402: {formatMicroUsdc(pricePerQuery)}/message</span>
          {balance !== null && <span>| Legacy balance: ${balance.toFixed(2)}</span>}
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
