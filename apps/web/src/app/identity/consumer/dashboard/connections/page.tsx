"use client";

import { useState } from "react";
import {
  Terminal,
  Sparkles,
  Code,
  Wind,
  Plug,
  Copy,
  Check,
  Info,
  Monitor,
} from "lucide-react";

const MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      ghola: {
        command: "said",
        args: ["serve"],
      },
    },
  },
  null,
  2
);

const TOOLS = [
  {
    id: "claude",
    name: "Claude Desktop / Claude Code",
    icon: Sparkles,
    path: "~/Library/Application Support/Claude/claude_desktop_config.json",
    pathWin: "%APPDATA%\\Claude\\claude_desktop_config.json",
    pathLinux: "~/.config/Claude/claude_desktop_config.json",
    config: MCP_CONFIG,
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: Code,
    path: ".cursor/mcp.json (in project root)",
    config: MCP_CONFIG,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    icon: Wind,
    path: "~/.codeium/windsurf/mcp_config.json",
    config: MCP_CONFIG,
  },
  {
    id: "generic",
    name: "Any MCP Client",
    icon: Plug,
    path: null,
    config: null,
  },
];

export default function ConsumerConnectionsPage() {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-medium text-[#eef1f8]">
          Connect Your AI Tools
        </h1>
        <p className="mt-1 text-[#8b95a8]">
          Add ghola to any MCP-compatible AI tool. Your identity, memory, and
          preferences will be available automatically.
        </p>
      </div>

      {/* Prerequisites */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-[#3da8ff]/10 p-2 text-[#3da8ff]">
            <Terminal className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold text-[#eef1f8]">
            Prerequisites
          </h2>
        </div>
        <div className="space-y-2">
          {[
            { cmd: "cargo install said", desc: "Install the CLI" },
            { cmd: "said init", desc: "Create your vault at ~/.said/" },
            { cmd: "said serve", desc: "Start the MCP server" },
          ].map((step) => (
            <div
              key={step.cmd}
              className="flex items-center gap-3 rounded-lg bg-[#161822] px-4 py-2.5"
            >
              <code className="text-sm font-mono text-[#3da8ff]">
                {step.cmd}
              </code>
              <span className="text-xs text-[#4a5568]">{step.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tool cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <div
              key={tool.id}
              className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="rounded-lg bg-[#161822] p-2 text-[#8b95a8]">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-[#eef1f8]">
                  {tool.name}
                </h3>
              </div>

              {tool.path && (
                <div className="mb-3">
                  <p className="text-xs text-[#4a5568] mb-1">Config file:</p>
                  <div className="flex items-center gap-2">
                    <Monitor className="h-3 w-3 text-[#4a5568] shrink-0" />
                    <code className="text-xs font-mono text-[#8b95a8] break-all">
                      {tool.path}
                    </code>
                  </div>
                  {tool.id === "claude" && (
                    <div className="mt-1 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-[#4a5568] w-10">Win</span>
                        <code className="text-[10px] font-mono text-[#4a5568] break-all">
                          {tool.pathWin}
                        </code>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-[#4a5568] w-10">Linux</span>
                        <code className="text-[10px] font-mono text-[#4a5568] break-all">
                          {tool.pathLinux}
                        </code>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tool.config ? (
                <div className="relative rounded-lg border border-[#1e2a3a] bg-[#08090d] p-3">
                  <pre className="text-xs font-mono text-[#5bb8ff] overflow-x-auto pr-8">
                    {tool.config}
                  </pre>
                  <button
                    onClick={() => handleCopy(tool.id, tool.config!)}
                    className="absolute top-2 right-2 rounded-md bg-[#161822] border border-[#1e2a3a] p-1.5 text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors cursor-pointer"
                    title="Copy config"
                  >
                    {copied === tool.id ? (
                      <Check className="h-3.5 w-3.5 text-green-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-[#8b95a8] leading-relaxed">
                    Any tool that supports the Model Context Protocol can connect
                    to ghola. Point it to{" "}
                    <code className="text-[#5bb8ff]">said serve</code> as a
                    stdio transport.
                  </p>
                  <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2">
                    <code className="text-xs font-mono text-[#5bb8ff]">
                      said serve
                    </code>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Cloud proxy note */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-[#3da8ff] mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-[#eef1f8] mb-1">
              Cloud Proxy Mode
            </h3>
            <p className="text-xs text-[#8b95a8] leading-relaxed">
              Don&apos;t want to run a local server? Install the ghola browser
              extension for cloud-proxied access to your vault. Your data is
              end-to-end encrypted — the cloud never sees your plaintext
              identity.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
