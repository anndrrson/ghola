"use client";

import { useState } from "react";
import {
  Mail,
  MessageSquare,
  Phone,
  Calendar,
  Send,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { TaskCard } from "@/components/chat/TaskCard";
import {
  sendEmail,
  sendSms,
  initiateCall,
  createCalendarEvent,
} from "@/lib/thumper-api";
import type { ActionDraft } from "./types";

interface ActionCardProps {
  draft: ActionDraft;
}

type Status = "ready" | "in_progress" | "completed" | "failed";

const KIND_LABEL: Record<ActionDraft["kind"], string> = {
  email: "Email",
  sms: "Text Message",
  call: "Phone Call",
  calendar: "Calendar Event",
};

export function ActionCard({ draft }: ActionCardProps) {
  switch (draft.kind) {
    case "email":
      return <EmailBody draft={draft} />;
    case "sms":
      return <SmsBody draft={draft} />;
    case "call":
      return <CallBody draft={draft} />;
    case "calendar":
      return <CalendarBody draft={draft} />;
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function EmailBody({
  draft,
}: {
  draft: Extract<ActionDraft, { kind: "email" }>;
}) {
  const [status, setStatus] = useState<Status>("ready");
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
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
    <TaskCard taskType={KIND_LABEL.email} status={status}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Mail className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{to}</span>
        </div>

        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="To"
            />
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
                Approve send
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
                Review & approve
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

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

function SmsBody({ draft }: { draft: Extract<ActionDraft, { kind: "sms" }> }) {
  const [status, setStatus] = useState<Status>("ready");
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(draft.to);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setStatus("in_progress");
    setError(null);
    try {
      await sendSms({ to, body });
      setStatus("completed");
      setEditing(false);
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to send SMS");
    }
  };

  return (
    <TaskCard taskType={KIND_LABEL.sms} status={status}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <MessageSquare className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{to}</span>
        </div>

        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="To (+15551234567)"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSend}
                disabled={status === "in_progress"}
                className="flex items-center gap-1.5 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Send className="h-3 w-3" />
                Approve send
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
            <p className="text-xs text-[#8b95a8] whitespace-pre-wrap">{body}</p>

            {status === "ready" && (
              <button
                onClick={() => setEditing(true)}
                className="mt-1 flex items-center gap-2 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
              >
                <MessageSquare className="h-3 w-3" />
                Review & approve
              </button>
            )}

            {status === "completed" && (
              <p className="text-xs text-green-400">Message sent</p>
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

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

function CallBody({
  draft,
}: {
  draft: Extract<ActionDraft, { kind: "call" }>;
}) {
  const [status, setStatus] = useState<Status>("ready");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCall = async () => {
    setStatus("in_progress");
    setError(null);
    try {
      const res = await initiateCall({
        phone_number: draft.phone_number,
        objective: draft.objective,
      });
      if (res.status === "completed") {
        setStatus("completed");
        setTranscript(res.transcript);
      } else if (res.status === "failed") {
        setStatus("failed");
        setError("Call failed");
      } else {
        setStatus("completed");
        setTranscript(res.transcript || "Call initiated successfully.");
      }
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to make call");
    }
  };

  return (
    <TaskCard taskType={KIND_LABEL.call} status={status}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Phone className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{draft.phone_number}</span>
        </div>
        <p className="text-xs text-[#8b95a8]">{draft.objective}</p>

        {status === "ready" && (
          <button
            onClick={handleCall}
            className="mt-1 flex items-center gap-2 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <Phone className="h-3 w-3" />
            Approve call
          </button>
        )}

        {status === "completed" && transcript && (
          <div className="mt-1 rounded-md bg-[#161822] px-3 py-2 text-xs text-[#8b95a8]">
            <p className="font-medium text-[#eef1f8] mb-1">Transcript</p>
            {transcript}
          </div>
        )}

        {status === "failed" && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-red-400">{error}</p>
            <button
              onClick={handleCall}
              className="flex items-center gap-1 text-xs text-[#3da8ff] hover:underline cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}
      </div>
    </TaskCard>
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function CalendarBody({
  draft,
}: {
  draft: Extract<ActionDraft, { kind: "calendar" }>;
}) {
  const [status, setStatus] = useState<Status>("ready");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [start, setStart] = useState(draft.start);
  const [end, setEnd] = useState(draft.end);
  const [description, setDescription] = useState(draft.description ?? "");
  const [location, setLocation] = useState(draft.location ?? "");
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setStatus("in_progress");
    setError(null);
    try {
      await createCalendarEvent({
        title,
        start,
        end,
        description: description || undefined,
        location: location || undefined,
        timezone: draft.timezone,
      });
      setStatus("completed");
      setEditing(false);
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to create event");
    }
  };

  return (
    <TaskCard taskType={KIND_LABEL.calendar} status={status}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8] font-medium">{title}</span>
        </div>
        <div className="text-xs text-[#8b95a8]">
          <p>{formatDateRange(start, end)}</p>
          {location && <p>📍 {location}</p>}
          {description && <p className="mt-1 whitespace-pre-wrap">{description}</p>}
        </div>

        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Title"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
                placeholder="Start (RFC3339)"
              />
              <input
                type="text"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
                placeholder="End (RFC3339)"
              />
            </div>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Location (optional)"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Description (optional)"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={status === "in_progress"}
                className="flex items-center gap-1.5 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Send className="h-3 w-3" />
                Approve create
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
            {status === "ready" && (
              <button
                onClick={() => setEditing(true)}
                className="mt-1 flex items-center gap-2 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
              >
                <Calendar className="h-3 w-3" />
                Review & approve
              </button>
            )}

            {status === "completed" && (
              <p className="text-xs text-green-400">Event created</p>
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

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) {
    return `${start} – ${end}`;
  }
  const sameDay = s.toDateString() === e.toDateString();
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  if (sameDay) {
    return `${s.toLocaleDateString(undefined, dateOpts)}, ${s.toLocaleTimeString(undefined, timeOpts)} – ${e.toLocaleTimeString(undefined, timeOpts)}`;
  }
  return `${s.toLocaleString(undefined, { ...dateOpts, ...timeOpts })} – ${e.toLocaleString(undefined, { ...dateOpts, ...timeOpts })}`;
}
