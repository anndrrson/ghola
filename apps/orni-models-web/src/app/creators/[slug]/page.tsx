import type { Metadata } from "next";
import { serverFetch } from "@/lib/api";
import type { CreatorPublicProfile, Model } from "@/lib/api";
import CreatorProfileClient from "./CreatorProfileClient";

interface CreatorProfileResponse {
  profile: CreatorPublicProfile;
  models: Model[];
}

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  try {
    const data = await serverFetch<CreatorProfileResponse>(`/creators/${slug}`);
    const name = data.profile.display_name || slug;
    const description = `${name} on Orni Models — ${data.profile.model_count} model${data.profile.model_count !== 1 ? "s" : ""}, ${data.profile.total_queries.toLocaleString()} total queries.`;

    return {
      title: `${name} — Orni Models`,
      description,
      openGraph: {
        title: `${name} — Orni Models`,
        description,
        type: "profile",
        ...(data.profile.avatar_url ? { images: [{ url: data.profile.avatar_url }] } : {}),
      },
      twitter: {
        card: "summary",
        title: `${name} — Orni Models`,
        description,
      },
    };
  } catch {
    return {
      title: "Creator — Orni Models",
      description: "Creator profile on Orni Models",
    };
  }
}

export default async function CreatorProfilePage({ params }: PageProps) {
  const { slug } = await params;

  let data: CreatorProfileResponse | null = null;
  let error = false;

  try {
    data = await serverFetch<CreatorProfileResponse>(`/creators/${slug}`);
  } catch {
    error = true;
  }

  return (
    <CreatorProfileClient
      initialProfile={data?.profile ?? null}
      initialModels={data?.models ?? []}
      slug={slug}
      serverError={error}
    />
  );
}
