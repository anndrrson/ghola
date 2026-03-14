"use client";

import { useState } from "react";
import { Phone, RotateCcw } from "lucide-react";
import { TaskCard } from "./TaskCard";
import { initiateCall } from "@/lib/thumper-api";

interface CallCardProps {
  phoneNumber: string;
  objective: string;
}

export function CallCard({ phoneNumber, objective }: CallCardProps) {
  const [status, setStatus] = useState<"ready" | "in_progress" | "completed" | "failed">("ready");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCall = async () => {
    setStatus("in_progress");
    setError(null);
    try {
      const res = await initiateCall({
        phone_number: phoneNumber,
        objective,
      });
      if (res.status === "completed") {
        setStatus("completed");
        setTranscript(res.transcript);
      } else if (res.status === "failed") {
        setStatus("failed");
        setError("Call failed");
      } else {
        // Still in progress — poll would go here in production
        setStatus("completed");
        setTranscript(res.transcript || "Call initiated successfully.");
      }
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to make call");
    }
  };

  return (
    <TaskCard taskType="Phone Call" status={status}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Phone className="h-3.5 w-3.5 text-[#3da8ff]" />
          <span className="text-[#eef1f8]">{phoneNumber}</span>
        </div>
        <p className="text-xs text-[#8b95a8]">{objective}</p>

        {status === "ready" && (
          <button
            onClick={handleCall}
            className="mt-1 flex items-center gap-2 rounded-lg bg-[#3da8ff] px-3 py-1.5 text-xs font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <Phone className="h-3 w-3" />
            Make this call
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
