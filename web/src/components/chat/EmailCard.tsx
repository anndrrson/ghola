"use client";

import { useState } from "react";
import { Mail, Send, ChevronDown, ChevronUp } from "lucide-react";
import { TaskCard } from "./TaskCard";
import { sendEmail } from "@/lib/thumper-api";

interface EmailCardProps {
  to: string;
  subject: string;
  body: string;
}

export function EmailCard({ to, subject: initialSubject, body: initialBody }: EmailCardProps) {
  const [status, setStatus] = useState<"ready" | "in_progress" | "completed" | "failed">("ready");
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setStatus("in_progress");
    setError(null);
    try {
      await sendEmail({ to, subject, body });
      setStatus("completed");
      setEditing(false);
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to send email");
    }
  };

  return (
    <TaskCard taskType="Email" status={status}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Mail className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{to}</span>
        </div>

        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Subject"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSend}
                disabled={status === "in_progress"}
                className="flex items-center gap-1.5 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Send className="h-3 w-3" />
                Send
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg border border-[#1e2a3a] px-3 py-1.5 text-xs text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs font-medium text-[#eef1f8]">{subject}</p>
            <div>
              <p className="text-xs text-[#8b95a8]">
                {expanded ? body : body.slice(0, 120) + (body.length > 120 ? "..." : "")}
              </p>
              {body.length > 120 && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-0.5 mt-1 text-xs text-[#3da8ff] hover:underline cursor-pointer"
                >
                  {expanded ? (
                    <>
                      <ChevronUp className="h-3 w-3" /> Less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" /> More
                    </>
                  )}
                </button>
              )}
            </div>

            {status === "ready" && (
              <button
                onClick={() => setEditing(true)}
                className="mt-1 flex items-center gap-2 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
              >
                <Mail className="h-3 w-3" />
                Edit & Send
              </button>
            )}

            {status === "completed" && (
              <p className="text-xs text-green-400">Email sent successfully</p>
            )}

            {status === "failed" && (
              <div className="flex items-center gap-2">
                <p className="text-xs text-red-400">{error}</p>
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs text-[#3da8ff] hover:underline cursor-pointer"
                >
                  Try again
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </TaskCard>
  );
}
