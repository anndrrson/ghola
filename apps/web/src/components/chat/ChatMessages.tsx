"use client";

import { useMemo, useRef, useEffect } from "react";
import DOMPurify from "dompurify";
import { ActionCard } from "@/components/actions/ActionCard";
import { mapInlineActionToDraft } from "@/components/actions/types";
import { ReceiptBadge } from "./ReceiptBadge";
import type { ThumperChatMessage } from "@/lib/thumper-types";
import type { SovereigntyMode } from "@/lib/sovereignty";

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["strong", "em", "code", "span"],
    ALLOWED_ATTR: ["class"],
  });
}

interface ChatMessagesProps {
  messages: ThumperChatMessage[];
  isStreaming: boolean;
  mode: SovereigntyMode;
  authenticated: boolean;
  providerInfo?: { type: string; model?: string; provider_name?: string } | null;
}

export function ChatMessages({
  messages,
  isStreaming,
  mode,
  authenticated,
  providerInfo,
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const groupedByDay = groupMessagesByDay(messages);

  // The most recent assistant message that has a receipt — used as the
  // single hint anchor so loading old chats doesn't paint a hint next
  // to every historical badge. Reference equality is enough because
  // updateSession in the parent splices in fresh message objects on
  // updates, and the receipt arrives in its own update.
  const lastReceiptMessage = useMemo<ThumperChatMessage | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.receipt) return m;
    }
    return null;
  }, [messages]);
  const emptyState = getEmptyStateCopy(mode, authenticated);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center text-center px-4">
          <div className="w-12 h-12 rounded-2xl bg-[#3da8ff]/10 flex items-center justify-center mb-4">
            <span className="text-xl">G</span>
          </div>
          <p className="text-[#eef1f8] font-medium mb-1">{emptyState.title}</p>
          <p className="text-sm text-[#4a5568] max-w-sm">
            {emptyState.body}
          </p>
        </div>
      )}
      {groupedByDay.map(({ date, messages: dayMessages }) => (
        <div key={date}>
          <div className="flex items-center justify-center my-4">
            <span className="text-xs text-[#4a5568] bg-[#0f1117] px-3 py-1 rounded-full">
              {date}
            </span>
          </div>
          {dayMessages.map((msg, idx) => {
            // For receipt verification we need the prompt that produced
            // this assistant message — that's the immediately preceding
            // message (which should be the user role). Falls back to ""
            // if the structure is unexpected (e.g. opening assistant
            // greeting), which the verifier will flag as a hash
            // mismatch rather than crashing.
            const prev = idx > 0 ? dayMessages[idx - 1] : undefined;
            const promptForReceipt =
              prev && prev.role === "user" ? prev.content : "";
            return (
            <div key={idx}>
              <div
                className={`flex mb-3 ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-[#3da8ff] text-white rounded-br-md"
                      : "bg-[#161822] text-[#eef1f8] rounded-bl-md"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <RenderMarkdown content={msg.content} />
                  ) : (
                    msg.content
                  )}
                  {msg.role === "assistant" &&
                    !msg.content &&
                    isStreaming &&
                    idx === dayMessages.length - 1 && (
                      <span className="inline-flex gap-1">
                        <span className="animate-pulse">.</span>
                        <span
                          className="animate-pulse"
                          style={{ animationDelay: "0.2s" }}
                        >
                          .
                        </span>
                        <span
                          className="animate-pulse"
                          style={{ animationDelay: "0.4s" }}
                        >
                          .
                        </span>
                      </span>
                    )}
                  <div
                    className={`text-[10px] mt-1 ${
                      msg.role === "user" ? "text-white/60" : "text-[#4a5568]"
                    }`}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              </div>

              {/* Inline action cards — one per tool_use emitted in this turn. */}
              {msg.actions?.map((action, ai) => {
                const draft = mapInlineActionToDraft(action);
                if (!draft) return null;
                return (
                  <div key={ai} className="flex justify-start mb-3">
                    <div className="max-w-[80%]">
                      <ActionCard draft={draft} />
                    </div>
                  </div>
                );
              })}
              {providerInfo?.type === "community" && !isStreaming && idx === dayMessages.length - 1 && msg.role === "assistant" && msg.content && (
                <div className="flex justify-start mb-3 ml-1">
                  <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] text-[#4a5568] bg-white/[0.02] border border-white/[0.06]">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    Powered by community GPU
                    {providerInfo.provider_name && <span className="text-[#8b95a8]">&middot; {providerInfo.provider_name}</span>}
                  </div>
                </div>
              )}
              {msg.role === "assistant" && msg.receipt && (
                <div className="flex justify-start mb-3 ml-1">
                  <ReceiptBadge
                    receipt={msg.receipt}
                    prompt={promptForReceipt}
                    response={msg.content}
                    isHintAnchor={msg === lastReceiptMessage}
                  />
                </div>
              )}
            </div>
            );
          })}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function getEmptyStateCopy(
  mode: SovereigntyMode,
  authenticated: boolean,
): { title: string; body: string } {
  if (mode === "local") {
    return {
      title: "Local mode selected.",
      body:
        "Runs on this device only after a supported local model loads here. If the model is not loaded, no on-device claim applies.",
    };
  }

  if (mode === "open") {
    return {
      title: "Open mode selected.",
      body:
        "Plain cloud inference. This is not private, not on-device, and not the default privacy path.",
    };
  }

  return {
    title: authenticated ? "Private mode selected." : "Create your account to start Private.",
    body: authenticated
      ? "Private cloud inference routes through Ghola's private relay and returns verifiable receipts."
      : "Private cloud inference requires an account. Local is the explicit on-device option.",
  };
}

function RenderMarkdown({ content }: { content: string }) {
  if (!content) return null;

  // Split by code blocks first
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0]?.trim() || "";
          const code = lang ? lines.slice(1).join("\n") : lines.join("\n");
          return (
            <pre
              key={i}
              className="my-2 rounded-md bg-[#0a0b10] p-3 text-xs overflow-x-auto font-mono"
            >
              <code>{code}</code>
            </pre>
          );
        }

        // Process inline markdown
        return (
          <span key={i} dangerouslySetInnerHTML={{ __html: sanitizeHtml(inlineMarkdown(part)) }} />
        );
      })}
    </>
  );
}

function inlineMarkdown(text: string): string {
  return text
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="rounded bg-[#0a0b10] px-1 py-0.5 text-xs font-mono">$1</code>')
    // Unordered list items
    .replace(/^- (.+)$/gm, '<span class="block ml-3">&#8226; $1</span>')
    // Ordered list items
    .replace(/^(\d+)\. (.+)$/gm, '<span class="block ml-3">$1. $2</span>');
}

function groupMessagesByDay(messages: ThumperChatMessage[]) {
  const groups: { date: string; messages: ThumperChatMessage[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const date = new Date(msg.timestamp).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    if (date !== currentDate) {
      currentDate = date;
      groups.push({ date, messages: [] });
    }
    groups[groups.length - 1].messages.push(msg);
  }

  return groups;
}
