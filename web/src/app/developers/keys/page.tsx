"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, Copy, Check, Trash2, AlertTriangle, Key } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/thumper-api";
import type { ThumperApiKeyInfo } from "@/lib/thumper-types";

export default function ApiKeysPage() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();
  const [keys, setKeys] = useState<ThumperApiKeyInfo[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/signin");
    }
  }, [authenticated, loading, router]);

  useEffect(() => {
    if (authenticated) {
      listApiKeys()
        .then(setKeys)
        .catch(() => {})
        .finally(() => setLoadingKeys(false));
    }
  }, [authenticated]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await createApiKey({ name: newKeyName || "Default" });
      setNewKey(result.key);
      setNewKeyName("");
      // Refresh list
      const updated = await listApiKeys();
      setKeys(updated);
    } catch {
      // silent
    }
    setCreating(false);
  };

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      await revokeApiKey(id);
      const updated = await listApiKeys();
      setKeys(updated);
    } catch {
      // silent
    }
    setRevoking(null);
  };

  const handleCopy = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading || !authenticated) return null;

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <div className="mx-auto max-w-2xl px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/developers"
            className="p-1.5 rounded-lg text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822] transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Key className="h-5 w-5 text-[#3da8ff]" />
          <h1 className="text-lg font-semibold text-[#eef1f8]">API Keys</h1>
        </div>

        {/* New key banner */}
        {newKey && (
          <div className="mb-6 rounded-xl border border-yellow-400/30 bg-yellow-400/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-yellow-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-yellow-400 mb-2">
                  Copy your API key now — you won&apos;t be able to see it again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-[#161822] px-3 py-2 text-xs font-mono text-[#eef1f8] truncate">
                    {newKey}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 p-2 rounded-lg bg-[#161822] text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-[#3da8ff]" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="mt-3 ml-8 text-xs text-[#4a5568] hover:text-[#8b95a8] transition-colors cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Create key section */}
        {!showCreate ? (
          <button
            onClick={() => setShowCreate(true)}
            className="mb-6 flex items-center gap-2 rounded-xl bg-[#3da8ff] px-4 py-2.5 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Create new key
          </button>
        ) : (
          <div className="mb-6 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-4">
            <div>
              <label className="block text-sm text-[#8b95a8] mb-1.5">
                Key name
              </label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Production, Development"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff] transition-colors"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 transition-colors cursor-pointer"
              >
                {creating ? "Creating..." : "Create key"}
              </button>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setNewKeyName("");
                }}
                className="rounded-lg border border-[#1e2a3a] px-4 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Active keys */}
        {loadingKeys ? (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 text-center text-sm text-[#4a5568]">
            Loading keys...
          </div>
        ) : activeKeys.length === 0 && !newKey ? (
          <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8 text-center">
            <Key className="h-8 w-8 text-[#4a5568] mx-auto mb-3" />
            <p className="text-sm text-[#8b95a8]">No API keys yet</p>
            <p className="text-xs text-[#4a5568] mt-1">
              Create a key to start using the Ghola API
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {activeKeys.map((key) => (
              <div
                key={key.id}
                className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-[#eef1f8]">
                      {key.name}
                    </h3>
                    <p className="text-xs font-mono text-[#4a5568] mt-1">
                      {key.key_prefix}
                    </p>
                    <div className="flex gap-4 mt-2 text-xs text-[#4a5568]">
                      <span>
                        Created{" "}
                        {new Date(key.created_at).toLocaleDateString()}
                      </span>
                      {key.last_used_at && (
                        <span>
                          Last used{" "}
                          {new Date(key.last_used_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={revoking === key.id}
                    className="p-2 rounded-lg text-[#4a5568] hover:text-red-400 hover:bg-red-400/5 disabled:opacity-50 transition-colors cursor-pointer"
                    title="Revoke key"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Revoked keys */}
        {revokedKeys.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xs font-medium text-[#4a5568] uppercase tracking-wider mb-3">
              Revoked
            </h2>
            <div className="space-y-2">
              {revokedKeys.map((key) => (
                <div
                  key={key.id}
                  className="rounded-xl border border-[#1e2a3a]/50 bg-[#0f1117]/50 p-3 opacity-60"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs text-[#4a5568]">{key.name}</span>
                      <span className="text-xs font-mono text-[#4a5568] ml-2">
                        {key.key_prefix}
                      </span>
                    </div>
                    <span className="text-[10px] text-red-400/60">Revoked</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
