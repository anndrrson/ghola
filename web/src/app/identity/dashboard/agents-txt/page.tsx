"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getProfile, getAgentsTxt, getWellKnownSaid } from "@/lib/api";
import type { BusinessProfile } from "@/lib/types";
import {
  FileText,
  Code,
  Download,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";

type Tab = "agents-txt" | "said-json";

interface DeploySection {
  id: string;
  label: string;
  content: string;
}

const AGENTS_TXT_DEPLOY: DeploySection[] = [
  {
    id: "nginx",
    label: "Nginx",
    content: `# Add to your nginx server block
location = /agents.txt {
    alias /var/www/html/agents.txt;
    default_type text/plain;
    add_header Cache-Control "public, max-age=3600";
}`,
  },
  {
    id: "vercel",
    label: "Vercel",
    content: `// vercel.json
{
  "rewrites": [
    { "source": "/agents.txt", "destination": "/api/agents-txt" }
  ]
}

// Or simply place agents.txt in your /public directory`,
  },
  {
    id: "cloudflare",
    label: "Cloudflare Pages",
    content: `# Place agents.txt in your project root or /public directory.
# Cloudflare Pages serves static files from the build output automatically.
# No additional configuration needed.`,
  },
  {
    id: "apache",
    label: "Apache",
    content: `# .htaccess
<Files "agents.txt">
    ForceType text/plain
    Header set Cache-Control "public, max-age=3600"
</Files>

# Place agents.txt in your document root`,
  },
  {
    id: "generic",
    label: "Generic",
    content: `# Place agents.txt at your domain root so it is accessible at:
#   https://yourdomain.com/agents.txt
#
# Ensure:
#   - Content-Type: text/plain
#   - File is publicly accessible (no auth required)`,
  },
];

const SAID_JSON_DEPLOY: DeploySection[] = [
  {
    id: "nginx",
    label: "Nginx",
    content: `# Add to your nginx server block
location = /.well-known/said.json {
    alias /var/www/html/.well-known/said.json;
    default_type application/json;
    add_header Cache-Control "public, max-age=3600";
    add_header Access-Control-Allow-Origin "*";
}`,
  },
  {
    id: "vercel",
    label: "Vercel",
    content: `// Place said.json at /public/.well-known/said.json
// Vercel serves /.well-known/ paths from /public automatically.
//
// Or add a rewrite in vercel.json:
{
  "rewrites": [
    { "source": "/.well-known/said.json", "destination": "/api/said-json" }
  ]
}`,
  },
  {
    id: "cloudflare",
    label: "Cloudflare Pages",
    content: `# Place said.json at /public/.well-known/said.json
# Cloudflare Pages serves .well-known paths from the build output.
# Ensure the file has a .json extension for correct Content-Type.`,
  },
  {
    id: "apache",
    label: "Apache",
    content: `# Ensure .well-known directory is accessible
<Directory "/var/www/html/.well-known">
    Options None
    AllowOverride None
    Require all granted
</Directory>

# Place said.json at /.well-known/said.json`,
  },
  {
    id: "generic",
    label: "Generic",
    content: `# Place said.json so it is accessible at:
#   https://yourdomain.com/.well-known/said.json
#
# Ensure:
#   - Content-Type: application/json
#   - CORS header: Access-Control-Allow-Origin: *
#   - File is publicly accessible (no auth required)`,
  },
];

export default function AgentsTxtPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("agents-txt");
  const [agentsTxt, setAgentsTxt] = useState<string>("");
  const [saidJson, setSaidJson] = useState<string>("");
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/identity/login");
    }
  }, [authLoading, authenticated, router]);

  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);
    setError(null);
    Promise.all([getAgentsTxt(), getWellKnownSaid(), getProfile()])
      .then(([txt, json, prof]) => {
        setAgentsTxt(txt);
        setSaidJson(json);
        setProfile(prof);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authenticated]);

  const currentContent = tab === "agents-txt" ? agentsTxt : saidJson;
  const currentFilename = tab === "agents-txt" ? "agents.txt" : "said.json";
  const currentDeploy =
    tab === "agents-txt" ? AGENTS_TXT_DEPLOY : SAID_JSON_DEPLOY;
  const currentPlacement =
    tab === "agents-txt"
      ? "Place at your domain root as /agents.txt"
      : "Place at /.well-known/said.json";

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(currentContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentContent]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([currentContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [currentContent, currentFilename]);

  const toggleSection = useCallback((id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const profileIncomplete =
    profile &&
    (!profile.services || profile.services.length === 0 || !profile.description);

  if (authLoading || !authenticated) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#eef1f8]">File Generator</h1>
        <p className="mt-1 text-[#8b95a8]">
          Generate and deploy your agents.txt and .well-known/said.json files
        </p>
      </div>

      {profileIncomplete && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-yellow-600/30 bg-yellow-900/20 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-500" />
          <p className="text-sm text-yellow-300">
            Add more details to your profile to generate a richer agents.txt.
            Consider adding services, a description, and API endpoints.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-[#0f1117] p-1">
        <button
          onClick={() => {
            setTab("agents-txt");
            setCopied(false);
          }}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
            tab === "agents-txt"
              ? "bg-[#161822] text-[#eef1f8]"
              : "text-[#8b95a8] hover:text-[#eef1f8]"
          }`}
        >
          <FileText className="h-4 w-4" />
          agents.txt
        </button>
        <button
          onClick={() => {
            setTab("said-json");
            setCopied(false);
          }}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
            tab === "said-json"
              ? "bg-[#161822] text-[#eef1f8]"
              : "text-[#8b95a8] hover:text-[#eef1f8]"
          }`}
        >
          <Code className="h-4 w-4" />
          said.json
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-600/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <div className="h-64 animate-pulse rounded-lg bg-[#161822]" />
          <div className="h-10 animate-pulse rounded-lg bg-[#161822]" />
        </div>
      ) : (
        <>
          {/* Code Preview */}
          <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d]">
            <div className="flex items-center justify-between border-b border-[#1e2a3a] px-4 py-2">
              <span className="text-xs font-mono text-[#4a5568]">
                {currentFilename}
              </span>
              <span className="text-xs text-[#4a5568]">
                {currentContent.split("\n").length} lines
              </span>
            </div>
            <div className="max-h-[28rem] overflow-auto p-4">
              <pre className="font-mono text-sm leading-relaxed">
                {currentContent.split("\n").map((line, i) => (
                  <div key={i} className="flex">
                    <span className="mr-4 inline-block w-8 text-right text-[#4a5568] select-none">
                      {i + 1}
                    </span>
                    <span className="text-[#eef1f8] whitespace-pre-wrap break-all">
                      {line}
                    </span>
                  </div>
                ))}
              </pre>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="mt-4 flex gap-3">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-lg bg-[#2b96f0] px-4 py-2.5 text-sm font-medium text-[#eef1f8] hover:bg-[#3da8ff] transition-colors cursor-pointer"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? "Copied!" : "Copy to Clipboard"}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-2.5 text-sm font-medium text-[#eef1f8] hover:bg-[#1c1f2e] transition-colors cursor-pointer"
            >
              <Download className="h-4 w-4" />
              Download {currentFilename}
            </button>
          </div>

          {/* Deployment Instructions */}
          <div className="mt-10">
            <h2 className="text-lg font-semibold text-[#eef1f8]">
              Deployment Instructions
            </h2>
            <p className="mt-1 mb-4 text-sm text-[#8b95a8]">
              {currentPlacement}
            </p>

            <div className="space-y-2">
              {currentDeploy.map((section) => {
                const isOpen = openSections.has(
                  `${tab}-${section.id}`
                );
                return (
                  <div
                    key={section.id}
                    className="rounded-lg border border-[#1e2a3a] bg-[#161822]"
                  >
                    <button
                      onClick={() =>
                        toggleSection(`${tab}-${section.id}`)
                      }
                      className="flex w-full items-center justify-between px-4 py-3 text-left cursor-pointer"
                    >
                      <span className="text-sm font-medium text-[#eef1f8]">
                        {section.label}
                      </span>
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-[#4a5568]" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-[#4a5568]" />
                      )}
                    </button>
                    {isOpen && (
                      <div className="border-t border-[#1e2a3a] px-4 py-3">
                        <pre className="rounded-md bg-[#08090d] p-3 font-mono text-xs text-[#8b95a8] overflow-x-auto">
                          {section.content}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
