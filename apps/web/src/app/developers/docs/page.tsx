"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BookOpen, Copy, Check } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";

type DocSection = "auth" | "chat" | "models" | "tasks" | "errors";

const API_BASE = "https://ghola.xyz";

export default function DocsPage() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();
  const [section, setSection] = useState<DocSection>("auth");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/signin");
    }
  }, [authenticated, loading, router]);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading || !authenticated) return null;

  const sections: { id: DocSection; label: string }[] = [
    { id: "auth", label: "Authentication" },
    { id: "chat", label: "Chat Completions" },
    { id: "models", label: "Models" },
    { id: "tasks", label: "Tasks & Actions" },
    { id: "errors", label: "Errors" },
  ];

  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <div className="mx-auto max-w-3xl px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/developers"
            className="p-1.5 rounded-lg text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822] transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <BookOpen className="h-5 w-5 text-[#3da8ff]" />
          <h1 className="text-lg font-semibold text-[#eef1f8]">
            API Documentation
          </h1>
        </div>

        {/* Section Nav */}
        <div className="flex gap-1 mb-8 rounded-lg bg-[#0f1117] p-1 overflow-x-auto">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                section === s.id
                  ? "bg-[#161822] text-[#eef1f8]"
                  : "text-[#4a5568] hover:text-[#8b95a8]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {section === "auth" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-medium text-[#eef1f8] mb-3">
                Authentication
              </h2>
              <p className="text-sm text-[#8b95a8] leading-relaxed mb-4">
                All API requests require authentication via a Bearer token in
                the Authorization header. You can use either a JWT token (from
                sign-in) or an API key.
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[#eef1f8] mb-2">
                API Key Format
              </h3>
              <p className="text-sm text-[#8b95a8] mb-3">
                API keys use the format{" "}
                <code className="rounded bg-[#161822] px-1.5 py-0.5 text-xs text-[#3da8ff]">
                  sk-ghola-*
                </code>
                . Create keys from the{" "}
                <Link
                  href="/developers/keys"
                  className="text-[#3da8ff] hover:underline"
                >
                  API Keys
                </Link>{" "}
                page.
              </p>
            </div>

            <CodeBlock
              id="auth-header"
              title="Request Header"
              language="bash"
              code={`Authorization: Bearer sk-ghola-your-key-here`}
              onCopy={handleCopy}
              copied={copied}
            />

            <div>
              <h3 className="text-sm font-medium text-[#eef1f8] mb-2">
                Base URL
              </h3>
              <code className="rounded bg-[#161822] px-2 py-1 text-sm text-[#3da8ff]">
                {API_BASE}
              </code>
            </div>
          </div>
        )}

        {section === "chat" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-medium text-[#eef1f8] mb-3">
                Chat Completions
              </h2>
              <p className="text-sm text-[#8b95a8] leading-relaxed mb-2">
                Create a chat completion. This endpoint is OpenAI-compatible —
                any OpenAI SDK works by changing the base URL.
              </p>
              <div className="flex items-center gap-2 mb-4">
                <span className="rounded bg-green-400/10 px-2 py-0.5 text-xs font-medium text-green-400">
                  POST
                </span>
                <code className="text-sm text-[#8b95a8]">
                  /v1/chat/completions
                </code>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[#eef1f8] mb-2">
                Request Body
              </h3>
              <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] divide-y divide-[#1e2a3a]">
                {[
                  {
                    name: "messages",
                    type: "array",
                    required: true,
                    desc: "Array of message objects with role and content",
                  },
                  {
                    name: "stream",
                    type: "boolean",
                    required: false,
                    desc: "If true, returns SSE stream of deltas",
                  },
                  {
                    name: "model",
                    type: "string",
                    required: false,
                    desc: "Model override (uses your configured model by default)",
                  },
                  {
                    name: "max_tokens",
                    type: "integer",
                    required: false,
                    desc: "Maximum tokens to generate",
                  },
                  {
                    name: "temperature",
                    type: "float",
                    required: false,
                    desc: "Sampling temperature (0-2)",
                  },
                ].map((p) => (
                  <div key={p.name} className="px-4 py-3 flex gap-4">
                    <div className="min-w-[120px]">
                      <code className="text-xs text-[#eef1f8]">{p.name}</code>
                      {p.required && (
                        <span className="ml-1.5 text-[10px] text-red-400">
                          required
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="text-[10px] text-[#4a5568] uppercase">
                        {p.type}
                      </span>
                      <p className="text-xs text-[#8b95a8] mt-0.5">{p.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <CodeBlock
              id="chat-curl"
              title="curl"
              language="bash"
              code={`curl ${API_BASE}/v1/chat/completions \\
  -H "Authorization: Bearer sk-ghola-your-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'`}
              onCopy={handleCopy}
              copied={copied}
            />

            <CodeBlock
              id="chat-python"
              title="Python (OpenAI SDK)"
              language="python"
              code={`from openai import OpenAI

client = OpenAI(
    api_key="sk-ghola-your-key",
    base_url="${API_BASE}/v1"
)

response = client.chat.completions.create(
    model="default",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)
print(response.choices[0].message.content)`}
              onCopy={handleCopy}
              copied={copied}
            />

            <CodeBlock
              id="chat-ts"
              title="TypeScript (OpenAI SDK)"
              language="typescript"
              code={`import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-ghola-your-key",
  baseURL: "${API_BASE}/v1",
});

const response = await client.chat.completions.create({
  model: "default",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);`}
              onCopy={handleCopy}
              copied={copied}
            />

            <div>
              <h3 className="text-sm font-medium text-[#eef1f8] mb-2">
                Response (non-streaming)
              </h3>
              <CodeBlock
                id="chat-response"
                title="Response"
                language="json"
                code={`{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "claude-sonnet-4-6-20250514",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 8,
    "total_tokens": 18
  }
}`}
                onCopy={handleCopy}
                copied={copied}
              />
            </div>
          </div>
        )}

        {section === "models" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-medium text-[#eef1f8] mb-3">
                Models
              </h2>
              <p className="text-sm text-[#8b95a8] leading-relaxed mb-2">
                List available models based on your configured provider.
              </p>
              <div className="flex items-center gap-2 mb-4">
                <span className="rounded bg-blue-400/10 px-2 py-0.5 text-xs font-medium text-blue-400">
                  GET
                </span>
                <code className="text-sm text-[#8b95a8]">/v1/models</code>
              </div>
            </div>

            <CodeBlock
              id="models-curl"
              title="curl"
              language="bash"
              code={`curl ${API_BASE}/v1/models \\
  -H "Authorization: Bearer sk-ghola-your-key"`}
              onCopy={handleCopy}
              copied={copied}
            />

            <CodeBlock
              id="models-response"
              title="Response"
              language="json"
              code={`{
  "object": "list",
  "data": [
    { "id": "claude-sonnet-4-6-20250514", "object": "model", "owned_by": "anthropic" },
    { "id": "claude-opus-4-6-20250514", "object": "model", "owned_by": "anthropic" },
    { "id": "claude-haiku-4-5-20251001", "object": "model", "owned_by": "anthropic" }
  ]
}`}
              onCopy={handleCopy}
              copied={copied}
            />
          </div>
        )}

        {section === "tasks" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-medium text-[#eef1f8] mb-3">
                Tasks & Actions
              </h2>
              <p className="text-sm text-[#8b95a8] leading-relaxed">
                Beyond chat, ghola can perform real-world actions. Use the
                existing REST endpoints with your API key for full access.
              </p>
            </div>

            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] divide-y divide-[#1e2a3a]">
              {[
                { method: "POST", path: "/api/calls", desc: "Initiate a phone call" },
                { method: "POST", path: "/api/emails/generate", desc: "Generate an email draft" },
                { method: "POST", path: "/api/emails/send", desc: "Send an email" },
                { method: "POST", path: "/api/tasks", desc: "Create a task" },
                { method: "GET", path: "/api/tasks", desc: "List tasks" },
                { method: "POST", path: "/api/chat", desc: "Chat (SSE streaming)" },
              ].map((e) => (
                <div key={e.path + e.method} className="px-4 py-3 flex items-center gap-4">
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                      e.method === "POST"
                        ? "bg-green-400/10 text-green-400"
                        : "bg-blue-400/10 text-blue-400"
                    }`}
                  >
                    {e.method}
                  </span>
                  <code className="text-xs text-[#8b95a8] flex-1">{e.path}</code>
                  <span className="text-xs text-[#4a5568]">{e.desc}</span>
                </div>
              ))}
            </div>

            <p className="text-xs text-[#4a5568]">
              All endpoints accept the same{" "}
              <code className="text-[#8b95a8]">
                Authorization: Bearer sk-ghola-*
              </code>{" "}
              header as the chat completions endpoint.
            </p>
          </div>
        )}

        {section === "errors" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-medium text-[#eef1f8] mb-3">
                Errors
              </h2>
              <p className="text-sm text-[#8b95a8] leading-relaxed mb-4">
                The API returns standard HTTP status codes with JSON error bodies.
              </p>
            </div>

            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] divide-y divide-[#1e2a3a]">
              {[
                { code: "400", desc: "Bad Request — Invalid parameters" },
                { code: "401", desc: "Unauthorized — Missing or invalid API key" },
                { code: "402", desc: "Payment Required — Upgrade your plan" },
                { code: "404", desc: "Not Found — Resource doesn't exist" },
                { code: "429", desc: "Rate Limited — Too many requests" },
                { code: "500", desc: "Internal Error — Something went wrong" },
                { code: "503", desc: "Service Unavailable — LLM provider down" },
              ].map((e) => (
                <div key={e.code} className="px-4 py-3 flex items-center gap-4">
                  <span
                    className={`font-mono text-xs ${
                      e.code.startsWith("4")
                        ? "text-yellow-400"
                        : "text-red-400"
                    }`}
                  >
                    {e.code}
                  </span>
                  <span className="text-xs text-[#8b95a8]">{e.desc}</span>
                </div>
              ))}
            </div>

            <CodeBlock
              id="error-response"
              title="Error Response Format"
              language="json"
              code={`{
  "error": "invalid or revoked API key"
}`}
              onCopy={handleCopy}
              copied={copied}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CodeBlock({
  id,
  title,
  code,
  onCopy,
  copied,
}: {
  id: string;
  title: string;
  language?: string;
  code: string;
  onCopy: (text: string, id: string) => void;
  copied: string | null;
}) {
  return (
    <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] overflow-hidden">
      <div className="border-b border-[#1e2a3a] px-4 py-2 flex items-center justify-between">
        <span className="text-xs text-[#4a5568]">{title}</span>
        <button
          onClick={() => onCopy(code, id)}
          className="p-1 rounded text-[#4a5568] hover:text-[#8b95a8] transition-colors cursor-pointer"
        >
          {copied === id ? (
            <Check className="h-3.5 w-3.5 text-[#3da8ff]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <pre className="p-4 text-xs text-[#8b95a8] overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}
