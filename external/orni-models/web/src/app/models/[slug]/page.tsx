import { Metadata } from "next";
import { serverFetch } from "@/lib/api";
import ModelDetailClient from "./ModelDetailClient";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const model = await serverFetch<{
      name: string;
      description?: string;
      price_per_query: number;
      creator_name?: string;
      category?: string;
      avg_rating: number;
    }>(`/models/${slug}`);
    const priceDisplay =
      model.price_per_query > 0
        ? `$${model.price_per_query.toFixed(2)}/query`
        : "Free";
    const desc =
      model.description || `Chat with ${model.name} on Orni Models`;
    return {
      title: `${model.name} - Orni Models`,
      description: desc,
      openGraph: {
        title: `${model.name} - Orni Models`,
        description: desc,
        type: "website",
        siteName: "Orni Models",
      },
      twitter: {
        card: "summary_large_image",
        title: `${model.name} - ${priceDisplay}`,
        description: desc,
      },
    };
  } catch {
    return { title: "Model - Orni Models" };
  }
}

export default async function ModelDetailPage({ params }: Props) {
  const { slug } = await params;
  return <ModelDetailClient slug={slug} />;
}
