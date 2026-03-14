"use client";

import { useRef, useEffect } from "react";
import { CallCard } from "./CallCard";
import { EmailCard } from "./EmailCard";
import type { ThumperChatMessage } from "@/lib/thumper-types";

interface ChatMessagesProps {
  messages: ThumperChatMessage[];
  isStreaming: boolean;
}

export function ChatMessages({ messages, isStreaming }: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const groupedByDay = groupMessagesByDay(messages);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {messages.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center text-center px-4">
          <div className="w-12 h-12 rounded-2xl bg-[#3da8ff]/10 flex items-center justify-center mb-4">
            <span className="text-xl">G</span>
          </div>
          <p className="text-[#eef1f8] font-medium mb-1">How can I help you?</p>
          <p className="text-sm text-[#4a5568] max-w-sm">
            I can make phone calls, send emails, manage your calendar, and more. Just ask.
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
          {dayMessages.map((msg, idx) => (
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

              {/* Inline action cards */}
              {msg.action?.type === "call" && (
                <div className="flex justify-start mb-3">
                  <div className="max-w-[80%]">
                    <CallCard
                      phoneNumber={msg.action.data.phone_number as string}
                      objective={msg.action.data.objective as string}
                    />
                  </div>
                </div>
              )}
              {msg.action?.type === "email" && (
                <div className="flex justify-start mb-3">
                  <div className="max-w-[80%]">
                    <EmailCard
                      to={msg.action.data.to as string}
                      subject={msg.action.data.subject as string}
                      body={msg.action.data.body as string}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
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
          <span key={i} dangerouslySetInnerHTML={{ __html: inlineMarkdown(part) }} />
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
