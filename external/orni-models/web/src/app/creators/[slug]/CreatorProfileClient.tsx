"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getCreatorProfile, type CreatorPublicProfile, type Model } from "@/lib/api";
import ModelCard from "@/components/ModelCard";
import {
  User,
  MessageSquare,
  Box,
  Calendar,
  ShieldCheck,
  ArrowLeft,
} from "lucide-react";

interface Props {
  initialProfile: CreatorPublicProfile | null;
  initialModels: Model[];
  slug: string;
  serverError: boolean;
}

export default function CreatorProfileClient({
  initialProfile,
  initialModels,
  slug,
  serverError,
}: Props) {
  const [profile, setProfile] = useState<CreatorPublicProfile | null>(initialProfile);
  const [models, setModels] = useState<Model[]>(initialModels);
  const [loading, setLoading] = useState(!initialProfile && !serverError);
  const [error, setError] = useState(serverError);

  useEffect(() => {
    if (initialProfile || serverError) return;
    setLoading(true);
    getCreatorProfile(slug)
      .then((data) => {
        setProfile(data.profile);
        setModels(data.models);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [slug, initialProfile, serverError]);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-8 h-64 animate-pulse rounded-lg bg-[#141414]" />
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-lg bg-[#141414]" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-medium">Creator not found</h1>
        <Link href="/models" className="text-[#a1a1a1] hover:text-[#fafafa] transition-colors">
          Back to browse
        </Link>
      </div>
    );
  }

  const displayName = profile.display_name || slug;
  const initial = displayName[0]?.toUpperCase() || "?";
  const memberSince = new Date(profile.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });
  const liveModels = models.filter((m) => m.status === "live");

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Back link */}
      <Link
        href="/models"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-[#a1a1a1] transition-colors hover:text-[#fafafa]"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to browse
      </Link>

      {/* Profile header */}
      <div className="mb-10 bg-[#141414] border border-[#262626] rounded-lg p-6 md:p-8">
        <div className="flex flex-col items-center gap-6 md:flex-row md:items-start">
          {/* Avatar */}
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt={displayName}
              className="h-24 w-24 rounded-full border-2 border-[#262626] object-cover"
            />
          ) : (
            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-[#222] text-3xl font-medium text-[#fafafa]">
              {initial}
            </div>
          )}

          <div className="flex-1 text-center md:text-left">
            {/* Name + verified badge */}
            <div className="mb-1 flex items-center justify-center gap-2 md:justify-start">
              <h1 className="text-2xl font-medium md:text-3xl">{displayName}</h1>
              {profile.said_verified && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#00E5A0]/10 px-2.5 py-0.5 text-xs font-medium text-[#00E5A0] border border-[#00E5A0]/20">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  DID Verified
                </span>
              )}
            </div>

            {/* DID */}
            {profile.did && (
              <p className="mb-3 font-mono text-xs text-[#666]">
                {profile.did}
              </p>
            )}

            {/* Member since */}
            <p className="mb-4 flex items-center justify-center gap-1.5 text-sm text-[#a1a1a1] md:justify-start">
              <Calendar className="h-4 w-4" />
              Member since {memberSince}
            </p>

            {/* Stats row */}
            <div className="flex items-center justify-center gap-6 md:justify-start">
              <div className="flex items-center gap-2 rounded-lg bg-[#1a1a1a] px-4 py-2">
                <Box className="h-4 w-4 text-[#a1a1a1]" />
                <div>
                  <p className="text-lg font-medium">{profile.model_count}</p>
                  <p className="text-xs text-[#666]">
                    model{profile.model_count !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-[#1a1a1a] px-4 py-2">
                <MessageSquare className="h-4 w-4 text-[#a1a1a1]" />
                <div>
                  <p className="text-lg font-medium">
                    {profile.total_queries.toLocaleString()}
                  </p>
                  <p className="text-xs text-[#666]">total queries</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Models section */}
      <div>
        <h2 className="mb-6 text-xl font-medium">
          Models by {displayName}
        </h2>

        {liveModels.length > 0 ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {liveModels.map((model) => (
              <ModelCard key={model.id} model={model} />
            ))}
          </div>
        ) : (
          <div className="bg-[#141414] border border-[#262626] rounded-lg py-16 text-center">
            <User className="mx-auto mb-3 h-8 w-8 text-[#666]" />
            <p className="text-[#666]">No live models yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
