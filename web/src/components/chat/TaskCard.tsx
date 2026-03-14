"use client";

import { Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";

interface TaskCardProps {
  taskType: string;
  status: "ready" | "pending" | "in_progress" | "completed" | "failed";
  children: React.ReactNode;
}

const statusConfig = {
  ready: { label: "Ready", color: "text-[#8b95a8]", bg: "bg-[#1e2a3a]", icon: Clock },
  pending: { label: "Pending", color: "text-yellow-400", bg: "bg-yellow-400/10", icon: Clock },
  in_progress: { label: "In progress", color: "text-[#3da8ff]", bg: "bg-[#3da8ff]/10", icon: Loader2 },
  completed: { label: "Done", color: "text-green-400", bg: "bg-green-400/10", icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-red-400", bg: "bg-red-400/10", icon: XCircle },
};

export function TaskCard({ taskType, status, children }: TaskCardProps) {
  const config = statusConfig[status];
  const StatusIcon = config.icon;

  return (
    <div className="mt-2 rounded-lg border border-[#1e2a3a] bg-[#0f1117] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e2a3a]">
        <span className="text-xs font-medium text-[#8b95a8] uppercase tracking-wider">
          {taskType}
        </span>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${config.color}`}>
          <StatusIcon className={`h-3 w-3 ${status === "in_progress" ? "animate-spin" : ""}`} />
          {config.label}
        </span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
