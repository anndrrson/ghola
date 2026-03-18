"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
    }
  };

  return (
    <div className="border-t border-[#1e2a3a] px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Message ghola..."
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none transition-colors focus:border-[#3da8ff] disabled:opacity-50"
          style={{ maxHeight: "160px" }}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#3da8ff] text-white transition-colors hover:bg-[#5bb8ff] disabled:opacity-50 disabled:hover:bg-[#3da8ff] cursor-pointer"
        >
          {disabled ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </div>
      <p className="text-[10px] text-[#4a5568] mt-1.5 text-center">
        ghola can make calls, send emails, and manage your calendar
      </p>
    </div>
  );
}
