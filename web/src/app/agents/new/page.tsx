"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { createAgent } from "@/lib/api";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 64);
}

export default function NewAgentPage() {
  const router = useRouter();
  const { authenticated, loading: authLoading } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [bio, setBio] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/identity/login?redirect=/agents/new");
    }
  }, [authenticated, authLoading, router]);

  // Auto-derive slug from display name unless the user has touched it
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(displayName));
  }, [displayName, slugTouched]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError("Display name is required");
      return;
    }
    if (!slug.trim()) {
      setError("Slug is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      setError("Slug can only contain letters, digits, '-', and '_'");
      return;
    }

    setSubmitting(true);
    try {
      const agent = await createAgent({
        slug,
        display_name: displayName,
        bio: bio || undefined,
      });
      router.push(`/agents/${agent.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create agent");
      setSubmitting(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <Loader2 className="h-8 w-8 animate-spin text-[#3da8ff]" />
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <div className="min-h-screen pt-24">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link
          href="/agents"
          className="inline-flex items-center gap-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] mb-8 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to my agents
        </Link>

        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-4 py-1.5 text-sm text-[#8b95a8] mb-6">
            <Sparkles className="h-3.5 w-3.5 text-[#3da8ff]" />
            New agent
          </div>
          <h1 className="text-3xl md:text-4xl font-medium text-[#eef1f8] mb-3">
            Create an agent.
          </h1>
          <p className="text-[#8b95a8]">
            We&apos;ll generate a fresh ed25519 keypair, derive a DID, and
            provision a dedicated Solana wallet — all in one click.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="display_name"
              className="block text-sm font-medium text-[#eef1f8] mb-2"
            >
              Display name
            </label>
            <input
              id="display_name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alpha Researcher"
              maxLength={64}
              required
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="slug"
              className="block text-sm font-medium text-[#eef1f8] mb-2"
            >
              Slug
            </label>
            <input
              id="slug"
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(slugify(e.target.value));
                setSlugTouched(true);
              }}
              placeholder="alpha-researcher"
              maxLength={64}
              required
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors font-mono text-sm"
            />
            <p className="mt-1 text-xs text-[#4a5568]">
              Used in URLs. Letters, digits, hyphens, and underscores only.
            </p>
          </div>

          <div>
            <label
              htmlFor="bio"
              className="block text-sm font-medium text-[#eef1f8] mb-2"
            >
              Bio <span className="text-[#4a5568]">(optional)</span>
            </label>
            <textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              placeholder="What does this agent do?"
              maxLength={500}
              className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-3 py-2 text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:outline-none transition-colors resize-none"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-6 py-3 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Create agent
                </>
              )}
            </button>
            <Link
              href="/agents"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-6 py-3 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-all"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
