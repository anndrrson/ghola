"use client";

import { useState } from "react";
import {
  Bot,
  Sparkles,
  Brain,
  Cpu,
  Plug,
  Unplug,
  X,
  Info,
} from "lucide-react";

interface AiService {
  id: string;
  name: string;
  description: string;
  icon: typeof Bot;
  connected: boolean;
}

const INITIAL_SERVICES: AiService[] = [
  {
    id: "claude",
    name: "Claude",
    description: "Anthropic's AI assistant. Connect via the SAID browser extension.",
    icon: Sparkles,
    connected: false,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "OpenAI's conversational AI. Connect via the SAID browser extension.",
    icon: Bot,
    connected: false,
  },
  {
    id: "gemini",
    name: "Gemini",
    description: "Google's AI model. UCAN-based connection coming soon.",
    icon: Brain,
    connected: false,
  },
  {
    id: "local",
    name: "Local AI",
    description: "Self-hosted models (Ollama, LM Studio). Connect via the SAID CLI daemon.",
    icon: Cpu,
    connected: false,
  },
];

export default function ConsumerConnectionsPage() {
  const [services, setServices] = useState<AiService[]>(INITIAL_SERVICES);
  const [modalService, setModalService] = useState<AiService | null>(null);

  function handleConnect(service: AiService) {
    if (service.connected) {
      // Disconnect
      setServices((prev) =>
        prev.map((s) =>
          s.id === service.id ? { ...s, connected: false } : s
        )
      );
    } else {
      // Show connection instructions modal
      setModalService(service);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">AI Connections</h1>
        <p className="mt-1 text-gray-400">
          Connect your SAID identity to AI services so they can access your
          preferences.
        </p>
      </div>

      {/* Service grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {services.map((service) => {
          const Icon = service.icon;
          return (
            <div
              key={service.id}
              className={`rounded-xl border p-5 transition-colors ${
                service.connected
                  ? "border-said-500/40 bg-said-500/5"
                  : "border-gray-800 bg-gray-900/60"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`rounded-lg p-2 ${
                      service.connected
                        ? "bg-said-500/10 text-said-400"
                        : "bg-gray-800 text-gray-400"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      {service.name}
                    </h3>
                    <span
                      className={`text-xs ${
                        service.connected
                          ? "text-green-400"
                          : "text-gray-500"
                      }`}
                    >
                      {service.connected ? "Connected" : "Not Connected"}
                    </span>
                  </div>
                </div>
              </div>

              <p className="text-xs text-gray-500 mb-4">
                {service.description}
              </p>

              <button
                onClick={() => handleConnect(service)}
                className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                  service.connected
                    ? "border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white"
                    : "bg-said-500 text-white hover:bg-said-600"
                }`}
              >
                {service.connected ? (
                  <>
                    <Unplug className="h-4 w-4" />
                    Disconnect
                  </>
                ) : (
                  <>
                    <Plug className="h-4 w-4" />
                    Connect
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Info section */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-said-400 mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">
              How connections work
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              Connected services can access your public profile and preferences
              to personalize your experience. Your private data, wallet keys,
              and recovery phrase are never shared. Connections use UCAN
              delegation tokens that you can revoke at any time.
            </p>
          </div>
        </div>
      </div>

      {/* Connection modal */}
      {modalService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setModalService(null)}
          />
          <div className="relative w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-6 shadow-xl">
            <button
              onClick={() => setModalService(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-lg bg-said-500/10 p-2 text-said-400">
                <modalService.icon className="h-5 w-5" />
              </div>
              <h2 className="text-lg font-semibold text-white">
                Connect to {modalService.name}
              </h2>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-gray-300">
                To connect {modalService.name} to your SAID identity:
              </p>
              <ol className="space-y-3 text-sm text-gray-400">
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-said-400">1.</span>
                  Install the SAID browser extension from the Chrome Web Store.
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-said-400">2.</span>
                  Open {modalService.name} in your browser.
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-said-400">3.</span>
                  Click the SAID extension icon and select &quot;Connect&quot;.
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-said-400">4.</span>
                  Your UCAN token will be automatically generated and injected.
                </li>
              </ol>

              <div className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-3">
                <p className="text-xs text-gray-500">
                  Full WASM-based token generation coming soon. For now, the
                  browser extension connects to your local SAID daemon for
                  signing.
                </p>
              </div>
            </div>

            <button
              onClick={() => setModalService(null)}
              className="mt-6 w-full rounded-lg bg-said-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-said-600 transition-colors cursor-pointer"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
