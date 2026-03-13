"use client";

import { useRef, useEffect } from "react";
import type { ChatMessageLocal } from "@/lib/types";

interface ChatMessagesProps {
  messages: ChatMessageLocal[];
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
        <div className="flex h-full items-center justify-center">
          <p className="text-[#4a5568] text-sm">Send a message to start chatting</p>
        </div>
      )}
      {groupedByDay.map(({ date, messages: dayMessages }) => (
        <div key={date}>
          <div className="flex items-center justify-center my-4">
            <span className="text-xs text-[#4a5568] bg-[#0f1117] px-3 py-1 rounded-full">
              {date}
            </span>
          </div>
          {dayMessages.map((msg) => (
            <div
              key={msg.id}
              className={`flex mb-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-[#3da8ff] text-white rounded-br-md"
                    : "bg-[#161822] text-[#eef1f8] rounded-bl-md"
                }`}
              >
                {msg.content}
                {msg.role === "assistant" && !msg.content && isStreaming && (
                  <span className="inline-flex gap-1">
                    <span className="animate-pulse">.</span>
                    <span className="animate-pulse" style={{ animationDelay: "0.2s" }}>.</span>
                    <span className="animate-pulse" style={{ animationDelay: "0.4s" }}>.</span>
                  </span>
                )}
                <div className={`text-[10px] mt-1 ${msg.role === "user" ? "text-white/60" : "text-[#4a5568]"}`}>
                  {new Date(msg.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function groupMessagesByDay(messages: ChatMessageLocal[]) {
  const groups: { date: string; messages: ChatMessageLocal[] }[] = [];
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
