"use client";

import { useState } from "react";
import {
  Mail,
  Phone,
  MessageSquare,
  Calendar,
  Send,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import { TaskCard } from "./TaskCard";
import {
  sendEmail,
  sendSms,
  initiateCall,
  createCalendarEvent,
} from "@/lib/thumper-api";
import type { ThumperInlineAction } from "@/lib/thumper-types";

export type ActionDraft =
  | { kind: "email"; to: string; subject: string; body: string }
  | { kind: "sms"; to: string; body: string }
  | { kind: "call"; phone_number: string; objective: string }
  | {
      kind: "calendar";
      title: string;
      start: string;
      end: string;
      description?: string;
      location?: string;
      timezone?: string;
    };

type ActionStatus = "ready" | "in_progress" | "completed" | "failed";

const KIND_META: Record<
  ActionDraft["kind"],
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  email: { label: "Email", icon: Mail },
  sms: { label: "Text Message", icon: MessageSquare },
  call: { label: "Phone Call", icon: Phone },
  calendar: { label: "Calendar Event", icon: Calendar },
};

export function inlineActionToDraft(action: ThumperInlineAction): ActionDraft | null {
  const d = action.data;
  switch (action.type) {
    case "email":
      return {
        kind: "email",
        to: String(d.to ?? ""),
        subject: String(d.subject ?? ""),
        body: String(d.body ?? ""),
      };
    case "sms":
      return {
        kind: "sms",
        to: String(d.to ?? ""),
        body: String(d.body ?? ""),
      };
    case "call":
      return {
        kind: "call",
        phone_number: String(d.phone_number ?? ""),
        objective: String(d.objective ?? ""),
      };
    case "calendar":
      return {
        kind: "calendar",
        title: String(d.title ?? ""),
        start: String(d.start ?? ""),
        end: String(d.end ?? ""),
        description: d.description ? String(d.description) : undefined,
        location: d.location ? String(d.location) : undefined,
        timezone: d.timezone ? String(d.timezone) : undefined,
      };
    default:
      return null;
  }
}

export function ActionCard({ draft: initial }: { draft: ActionDraft }) {
  const [draft, setDraft] = useState<ActionDraft>(initial);
  const [status, setStatus] = useState<ActionStatus>("ready");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultInfo, setResultInfo] = useState<{
    transcript?: string;
    htmlLink?: string;
  }>({});
  const [expanded, setExpanded] = useState(false);

  const meta = KIND_META[draft.kind];
  const Icon = meta.icon;

  const run = async () => {
    setStatus("in_progress");
    setError(null);
    try {
      switch (draft.kind) {
        case "email": {
          await sendEmail({
            to: draft.to,
            subject: draft.subject,
            body: draft.body,
          });
          setStatus("completed");
          setEditing(false);
          break;
        }
        case "sms": {
          await sendSms({ to: draft.to, body: draft.body });
          setStatus("completed");
          setEditing(false);
          break;
        }
        case "call": {
          const res = await initiateCall({
            phone_number: draft.phone_number,
            objective: draft.objective,
          });
          setStatus(res.status === "failed" ? "failed" : "completed");
          if (res.transcript) setResultInfo({ transcript: res.transcript });
          break;
        }
        case "calendar": {
          const res = await createCalendarEvent({
            title: draft.title,
            start: draft.start,
            end: draft.end,
            description: draft.description,
            location: draft.location,
            timezone: draft.timezone,
          });
          setStatus("completed");
          setEditing(false);
          if (res.event?.html_link) {
            setResultInfo({ htmlLink: res.event.html_link });
          }
          break;
        }
      }
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const recipientLine = () => {
    if (draft.kind === "email")
      return (
        <div className="flex items-center gap-2 text-sm">
          <Icon className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{draft.to}</span>
        </div>
      );
    if (draft.kind === "sms")
      return (
        <div className="flex items-center gap-2 text-sm">
          <Icon className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{draft.to}</span>
        </div>
      );
    if (draft.kind === "call")
      return (
        <div className="flex items-center gap-2 text-sm">
          <Icon className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{draft.phone_number}</span>
        </div>
      );
    return (
      <div className="flex items-center gap-2 text-sm">
        <Icon className="h-3.5 w-3.5 text-[#3da8ff]" />
        <span className="text-[#eef1f8]">{draft.title}</span>
      </div>
    );
  };

  const primaryButtonLabel = () => {
    if (draft.kind === "email") return "Edit & Send";
    if (draft.kind === "sms") return "Edit & Send";
    if (draft.kind === "call") return "Make this call";
    return "Create event";
  };

  const sendButtonLabel = () => {
    if (draft.kind === "call") return "Place call";
    if (draft.kind === "calendar") return "Create";
    return "Send";
  };

  return (
    <TaskCard taskType={meta.label} status={status}>
      <div className="space-y-2">
        {recipientLine()}

        {/* Body / details */}
        {!editing && draft.kind === "email" && (
          <>
            <p className="text-xs font-medium text-[#eef1f8]">{draft.subject}</p>
            <div>
              <p className="text-xs text-[#8b95a8] whitespace-pre-wrap">
                {expanded
                  ? draft.body
                  : draft.body.slice(0, 120) + (draft.body.length > 120 ? "..." : "")}
              </p>
              {draft.body.length > 120 && (
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
          </>
        )}

        {!editing && draft.kind === "sms" && (
          <p className="text-xs text-[#8b95a8] whitespace-pre-wrap">{draft.body}</p>
        )}

        {!editing && draft.kind === "call" && (
          <p className="text-xs text-[#8b95a8]">{draft.objective}</p>
        )}

        {!editing && draft.kind === "calendar" && (
          <div className="text-xs text-[#8b95a8] space-y-0.5">
            <p>
              {formatRange(draft.start, draft.end)}
            </p>
            {draft.location && <p>📍 {draft.location}</p>}
            {draft.description && (
              <p className="whitespace-pre-wrap">{draft.description}</p>
            )}
          </div>
        )}

        {/* Editor */}
        {editing && draft.kind === "email" && (
          <div className="space-y-2">
            <input
              type="text"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="To"
            />
            <input
              type="text"
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Subject"
            />
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={4}
              className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
            />
          </div>
        )}

        {editing && draft.kind === "sms" && (
          <div className="space-y-2">
            <input
              type="tel"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Phone (E.164, e.g. +15551234567)"
            />
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={3}
              maxLength={1600}
              className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
            />
            <p className="text-[10px] text-[#4a5568] text-right">
              {draft.body.length}/160
            </p>
          </div>
        )}

        {editing && draft.kind === "calendar" && (
          <div className="space-y-2">
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Title"
            />
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={toLocalInput(draft.start)}
                onChange={(e) =>
                  setDraft({ ...draft, start: fromLocalInput(e.target.value) })
                }
                className="flex-1 rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              />
              <input
                type="datetime-local"
                value={toLocalInput(draft.end)}
                onChange={(e) =>
                  setDraft({ ...draft, end: fromLocalInput(e.target.value) })
                }
                className="flex-1 rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              />
            </div>
            <input
              type="text"
              value={draft.location ?? ""}
              onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              className="w-full rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Location (optional)"
            />
            <textarea
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              rows={2}
              className="w-full resize-none rounded-md border border-[#1e2a3a] bg-[#161822] px-2.5 py-1.5 text-xs text-[#eef1f8] outline-none focus:border-[#3da8ff]"
              placeholder="Description (optional)"
            />
          </div>
        )}

        {editing && (
          <div className="flex gap-2">
            <button
              onClick={run}
              disabled={status === "in_progress"}
              className="flex items-center gap-1.5 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Send className="h-3 w-3" />
              {sendButtonLabel()}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-[#1e2a3a] px-3 py-1.5 text-xs text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Ready action button */}
        {!editing && status === "ready" && (
          <button
            onClick={() => {
              if (draft.kind === "call") {
                run();
              } else {
                setEditing(true);
              }
            }}
            className="mt-1 flex items-center gap-2 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <Icon className="h-3 w-3" />
            {primaryButtonLabel()}
          </button>
        )}

        {/* Completed states */}
        {status === "completed" && draft.kind === "email" && (
          <p className="text-xs text-green-400">Email sent successfully</p>
        )}
        {status === "completed" && draft.kind === "sms" && (
          <p className="text-xs text-green-400">Text sent successfully</p>
        )}
        {status === "completed" && draft.kind === "call" && resultInfo.transcript && (
          <div className="mt-1 rounded-md bg-[#161822] px-3 py-2 text-xs text-[#8b95a8]">
            <p className="font-medium text-[#eef1f8] mb-1">Transcript</p>
            {resultInfo.transcript}
          </div>
        )}
        {status === "completed" && draft.kind === "call" && !resultInfo.transcript && (
          <p className="text-xs text-green-400">Call placed</p>
        )}
        {status === "completed" && draft.kind === "calendar" && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-green-400">Event created</p>
            {resultInfo.htmlLink && (
              <a
                href={resultInfo.htmlLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-[#3da8ff] hover:underline"
              >
                Open <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}

        {/* Failed state */}
        {status === "failed" && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-red-400">{error}</p>
            <button
              onClick={() => {
                if (draft.kind === "call") run();
                else setEditing(true);
              }}
              className="flex items-center gap-1 text-xs text-[#3da8ff] hover:underline cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              {draft.kind === "call" ? "Retry" : "Try again"}
            </button>
          </div>
        )}
      </div>
    </TaskCard>
  );
}

function toLocalInput(iso: string): string {
  // datetime-local needs "YYYY-MM-DDTHH:mm"; strip timezone if present.
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (isNaN(d.getTime())) return local;
  return d.toISOString();
}

function formatRange(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const sameDay = s.toDateString() === e.toDateString();
    const dateOpts: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
    };
    const timeOpts: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
    };
    if (sameDay) {
      return `${s.toLocaleDateString(undefined, dateOpts)} · ${s.toLocaleTimeString(undefined, timeOpts)} – ${e.toLocaleTimeString(undefined, timeOpts)}`;
    }
    return `${s.toLocaleDateString(undefined, dateOpts)} ${s.toLocaleTimeString(undefined, timeOpts)} → ${e.toLocaleDateString(undefined, dateOpts)} ${e.toLocaleTimeString(undefined, timeOpts)}`;
  } catch {
    return `${start} – ${end}`;
  }
}
