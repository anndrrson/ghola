"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Server,
  Star,
  Activity,
  Clock,
  DollarSign,
  BarChart3,
  MessageSquare,
} from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

interface InferenceNode {
  id: string;
  owner_did: string;
  endpoint_url: string;
  models_served: string[];
  price_per_query_micro_usdc: number;
  status: string;
  region: string | null;
  description: string | null;
  uptime_percent: number;
  total_queries: number;
  avg_rating: number;
  review_count: number;
  last_heartbeat_at: string | null;
  created_at: string;
}

interface Heartbeat {
  status: string;
  latency_ms: number | null;
  error_message: string | null;
  created_at: string;
}

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
    case "ok":
      return "bg-green-500";
    case "degraded":
      return "bg-yellow-500";
    case "pending":
      return "bg-[#4a5568]";
    default:
      return "bg-red-500";
  }
}

function formatPrice(microUsdc: number): string {
  return `$${(microUsdc / 1_000_000).toFixed(4)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

export default function NodeDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [node, setNode] = useState<InferenceNode | null>(null);
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    async function fetchData() {
      setLoading(true);
      try {
        const [nodeRes, reviewsRes] = await Promise.all([
          fetch(`${API_BASE}/nodes/${id}`),
          fetch(`${API_BASE}/nodes/${id}/reviews?limit=20`),
        ]);

        if (!nodeRes.ok) throw new Error("Node not found");
        const nodeData = await nodeRes.json();
        setNode(nodeData.node);
        setHeartbeats(nodeData.heartbeats || []);

        if (reviewsRes.ok) {
          const reviewsData = await reviewsRes.json();
          setReviews(reviewsData.reviews || []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load node");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [id]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 pt-24 pb-8">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-64 rounded bg-[#161822]" />
          <div className="h-48 rounded-xl bg-[#0f1117]" />
          <div className="h-64 rounded-xl bg-[#0f1117]" />
        </div>
      </div>
    );
  }

  if (error || !node) {
    return (
      <div className="mx-auto max-w-5xl px-4 pt-24 pb-8 text-center">
        <Server className="mx-auto h-12 w-12 text-[#4a5568] mb-4" />
        <h2 className="text-xl font-semibold text-[#eef1f8] mb-2">
          {error || "Node not found"}
        </h2>
        <Link
          href="/models/nodes"
          className="text-sm text-[#3da8ff] hover:text-[#5bb8ff] transition"
        >
          Back to nodes
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pt-24 pb-8">
      {/* Back link */}
      <Link
        href="/models/nodes"
        className="inline-flex items-center gap-1 text-sm text-[#8b95a8] hover:text-[#eef1f8] transition mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        All Nodes
      </Link>

      {/* Node header */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#3da8ff]/10">
              <Server className="h-6 w-6 text-[#3da8ff]" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-[#eef1f8]">
                {node.endpoint_url
                  .replace(/^https?:\/\//, "")
                  .replace(/\/$/, "")}
              </h1>
              <p className="text-sm text-[#4a5568]">{node.owner_did}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`h-2.5 w-2.5 rounded-full ${statusColor(node.status)}`}
            />
            <span className="text-sm font-medium text-[#8b95a8]">
              {node.status}
            </span>
          </div>
        </div>

        {node.description && (
          <p className="text-[#8b95a8] mb-4">{node.description}</p>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-4">
            <div className="flex items-center gap-2 text-[#4a5568] text-xs mb-1">
              <Activity className="h-3.5 w-3.5" />
              Uptime
            </div>
            <p className="text-lg font-semibold text-[#eef1f8]">
              {node.uptime_percent.toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-4">
            <div className="flex items-center gap-2 text-[#4a5568] text-xs mb-1">
              <DollarSign className="h-3.5 w-3.5" />
              Price
            </div>
            <p className="text-lg font-semibold text-[#eef1f8]">
              {formatPrice(node.price_per_query_micro_usdc)}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-4">
            <div className="flex items-center gap-2 text-[#4a5568] text-xs mb-1">
              <BarChart3 className="h-3.5 w-3.5" />
              Queries
            </div>
            <p className="text-lg font-semibold text-[#eef1f8]">
              {node.total_queries.toLocaleString()}
            </p>
          </div>
          <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-4">
            <div className="flex items-center gap-2 text-[#4a5568] text-xs mb-1">
              <Star className="h-3.5 w-3.5" />
              Rating
            </div>
            <p className="text-lg font-semibold text-[#eef1f8]">
              {node.review_count > 0
                ? `${node.avg_rating.toFixed(1)} (${node.review_count})`
                : "No reviews"}
            </p>
          </div>
        </div>

        {/* Models served */}
        <div className="mt-4">
          <p className="text-xs font-medium text-[#4a5568] uppercase tracking-wider mb-2">
            Models Served
          </p>
          <div className="flex flex-wrap gap-2">
            {node.models_served.map((model) => (
              <span
                key={model}
                className="rounded-lg bg-[#161822] px-3 py-1 text-sm text-[#8b95a8]"
              >
                {model}
              </span>
            ))}
          </div>
        </div>

        {/* Metadata */}
        <div className="mt-4 flex items-center gap-4 text-xs text-[#4a5568]">
          {node.region && <span>Region: {node.region}</span>}
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Registered: {formatDate(node.created_at)}
          </span>
          {node.last_heartbeat_at && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last heartbeat: {formatDate(node.last_heartbeat_at)}
            </span>
          )}
        </div>
      </div>

      {/* Two-column layout: heartbeats + reviews */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Heartbeat history */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <h2 className="text-lg font-semibold text-[#eef1f8] mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5 text-[#3da8ff]" />
            Heartbeat History
          </h2>
          {heartbeats.length === 0 ? (
            <p className="text-sm text-[#4a5568]">No heartbeats recorded yet.</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {heartbeats.map((hb, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg bg-[#08090d] px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full ${statusColor(hb.status)}`}
                    />
                    <span className="text-[#8b95a8]">{hb.status}</span>
                    {hb.latency_ms !== null && (
                      <span className="text-[#4a5568]">
                        {hb.latency_ms}ms
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-[#4a5568]">
                    {formatDate(hb.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Reviews */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <h2 className="text-lg font-semibold text-[#eef1f8] mb-4 flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-[#3da8ff]" />
            Reviews
          </h2>
          {reviews.length === 0 ? (
            <p className="text-sm text-[#4a5568]">No reviews yet.</p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {reviews.map((review) => (
                <div
                  key={review.id}
                  className="rounded-lg bg-[#08090d] px-4 py-3"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-3.5 w-3.5 ${
                            i < review.rating
                              ? "text-yellow-400 fill-yellow-400"
                              : "text-[#1e2a3a]"
                          }`}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-[#4a5568]">
                      {formatDate(review.created_at)}
                    </span>
                  </div>
                  {review.comment && (
                    <p className="text-sm text-[#8b95a8]">{review.comment}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
