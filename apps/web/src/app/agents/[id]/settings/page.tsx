"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getAgent, updateAgent, deleteAgent } from "@/lib/api";
import type { AgentDetail, AgentStatus } from "@/lib/types";
import { Loader2, Save, Archive, AlertTriangle } from "lucide-react";

export default function AgentSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [status, setStatus] = useState<AgentStatus>("active");

  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!params.id) return;
    getAgent(params.id)
      .then((a) => {
        setAgent(a);
        setDisplayName(a.display_name);
        setBio(a.bio ?? "");
        setAvatarUrl(a.avatar_url ?? "");
        setStatus(a.status);
      })
      .finally(() => setLoading(false));
  }, [params.id]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!params.id) return;
    setError(null);
    setSaving(true);
    try {
      await updateAgent(params.id, {
        display_name: displayName,
        bio: bio || undefined,
        avatar_url: avatarUrl || undefined,
        status,
      });
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (!params.id) return;
    setArchiving(true);
    try {
      await deleteAgent(params.id);
      router.push("/agents");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to archive");
      setArchiving(false);
    }
  }

  if (loading || !agent) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-[#161822]" />
        <div className="h-32 animate-pulse rounded-xl bg-[#161822]" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-[#eef1f8]">Settings</h1>
        <p className="mt-1 text-[#8b95a8]">
          Update display info or archive this agent.
        </p>
      </div>

      <form
        onSubmit={handleSave}
        className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-5 space-y-5"
      >
        <div>
          <label className="block text-sm font-medium text-[#eef1f8] mb-2">
            Display name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            required
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#eef1f8] mb-2">
            Bio
          </label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors resize-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#eef1f8] mb-2">
            Avatar URL
          </label>
          <input
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://..."
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors font-mono text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#eef1f8] mb-2">
            Status
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as AgentStatus)}
            className="w-full rounded-lg border border-[#1e2a3a] bg-[#08090d] px-3 py-2 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none transition-colors"
          >
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </button>
          {savedAt && Date.now() - savedAt < 3000 && (
            <span className="text-sm text-green-400">Saved</span>
          )}
        </div>
      </form>

      {/* Danger zone */}
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <h2 className="text-sm font-medium text-red-300">Danger zone</h2>
        </div>
        <p className="text-sm text-[#8b95a8] mb-4">
          Archiving an agent hides it from your dashboard. The on-chain DID,
          wallet, and transaction history remain permanent — nothing is
          actually deleted.
        </p>
        {!confirmArchive ? (
          <button
            onClick={() => setConfirmArchive(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer"
          >
            <Archive className="h-4 w-4" />
            Archive agent
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={handleArchive}
              disabled={archiving}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {archiving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              Confirm archive
            </button>
            <button
              onClick={() => setConfirmArchive(false)}
              className="rounded-lg border border-[#1e2a3a] px-4 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
