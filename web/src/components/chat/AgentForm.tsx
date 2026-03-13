"use client";

import { useState } from "react";
import { X, Eye, EyeOff } from "lucide-react";
import { PROVIDERS } from "@/lib/providers";
import type { ChatAgent } from "@/lib/types";

const AVATARS = ["\u{1F916}", "\u{1F9E0}", "\u{1F4A1}", "\u{1F3AF}", "\u{1F52E}", "\u{26A1}", "\u{1F31F}", "\u{1F3A8}", "\u{1F4DA}", "\u{1F52C}", "\u{1F6E1}\uFE0F", "\u{1F3AD}"];

interface AgentFormProps {
  agent: ChatAgent | null;
  onSave: (agent: ChatAgent) => void;
  onClose: () => void;
}

export function AgentForm({ agent, onSave, onClose }: AgentFormProps) {
  const [name, setName] = useState(agent?.name || "");
  const [avatar, setAvatar] = useState(agent?.avatar || "\u{1F916}");
  const [provider, setProvider] = useState(agent?.provider || "anthropic");
  const [model, setModel] = useState(agent?.model || "claude-sonnet-4-20250514");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || "");
  const [apiKey, setApiKey] = useState(agent?.apiKey || "");
  const [showKey, setShowKey] = useState(false);

  const selectedProvider = PROVIDERS.find((p) => p.id === provider);

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    const p = PROVIDERS.find((p) => p.id === newProvider);
    if (p && p.models.length > 0) {
      setModel(p.models[0].id);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !apiKey.trim()) return;

    onSave({
      id: agent?.id || crypto.randomUUID(),
      name: name.trim(),
      avatar,
      provider,
      model,
      systemPrompt: systemPrompt.trim(),
      apiKey: apiKey.trim(),
      createdAt: agent?.createdAt || new Date().toISOString(),
      lastMessageAt: agent?.lastMessageAt,
      lastMessagePreview: agent?.lastMessagePreview,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-[#0f1117] border border-[#1e2a3a] shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2a3a]">
          <h2 className="text-lg font-semibold text-[#eef1f8]">
            {agent ? "Edit Agent" : "New Agent"}
          </h2>
          <button onClick={onClose} className="p-1 text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {/* Avatar */}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Avatar</label>
            <div className="flex flex-wrap gap-2">
              {AVATARS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setAvatar(emoji)}
                  className={`h-10 w-10 rounded-lg flex items-center justify-center text-lg transition-colors cursor-pointer ${
                    avatar === emoji
                      ? "bg-[#3da8ff]/20 ring-2 ring-[#3da8ff]"
                      : "bg-[#161822] hover:bg-[#1e2a3a]"
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Assistant"
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff]"
              required
            />
          </div>

          {/* Provider */}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1.5">Provider</label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff] cursor-pointer"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff] cursor-pointer"
            >
              {selectedProvider?.models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 pr-10 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] font-mono"
                required
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#4a5568] hover:text-[#8b95a8] cursor-pointer"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-[#4a5568] mt-1">Stored locally. Never sent to ghola servers.</p>
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1.5">System Prompt (optional)</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={3}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] resize-none"
            />
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !apiKey.trim()}
              className="rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors disabled:opacity-50 cursor-pointer"
            >
              {agent ? "Save Changes" : "Create Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
