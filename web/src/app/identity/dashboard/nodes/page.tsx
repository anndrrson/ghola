"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, Server, Wifi, WifiOff, AlertTriangle } from "lucide-react";
import { registerNode, getNodes, deleteNode } from "@/lib/api";
import type { InferenceNode } from "@/lib/types";

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    active: { color: "bg-green-500/10 text-green-400 border-green-500/30", icon: <Wifi className="w-3 h-3" />, label: "Active" },
    pending: { color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30", icon: <RefreshCw className="w-3 h-3" />, label: "Pending" },
    degraded: { color: "bg-orange-500/10 text-orange-400 border-orange-500/30", icon: <AlertTriangle className="w-3 h-3" />, label: "Degraded" },
    offline: { color: "bg-red-500/10 text-red-400 border-red-500/30", icon: <WifiOff className="w-3 h-3" />, label: "Offline" },
  };
  const c = config[status] || config.offline;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${c.color}`}>
      {c.icon} {c.label}
    </span>
  );
}

export default function NodesPage() {
  const [nodes, setNodes] = useState<InferenceNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    endpoint_url: "",
    models_served: "",
    price_per_query_micro_usdc: 100000,
    region: "",
    description: "",
  });

  const fetchNodes = async () => {
    try {
      const data = await getNodes();
      setNodes(data.nodes);
      setTotal(data.total);
    } catch (err) {
      console.error("Failed to fetch nodes:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await registerNode({
        endpoint_url: form.endpoint_url,
        models_served: form.models_served.split(",").map((s) => s.trim()).filter(Boolean),
        price_per_query_micro_usdc: form.price_per_query_micro_usdc,
        region: form.region || undefined,
        description: form.description || undefined,
      });
      setForm({ endpoint_url: "", models_served: "", price_per_query_micro_usdc: 100000, region: "", description: "" });
      setShowForm(false);
      await fetchNodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register node");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Take this node offline?")) return;
    try {
      await deleteNode(id);
      await fetchNodes();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete node");
    }
  };

  const priceDisplay = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#eef1f8]">Inference Nodes</h1>
          <p className="text-sm text-[#8b95a8] mt-1">
            Register and manage your self-hosted OpenAI-compatible inference endpoints.
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-[#3da8ff] hover:bg-[#2b96f0] text-[#eef1f8] rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Register Node
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleRegister} className="bg-[#0f1117] border border-[#1e2a3a] rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-[#eef1f8]">Register New Node</h2>
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">Endpoint URL</label>
            <input
              type="url"
              required
              value={form.endpoint_url}
              onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })}
              placeholder="https://your-node.example.com/v1"
              className="w-full bg-[#161822] border border-[#1e2a3a] rounded-lg px-4 py-2.5 text-[#eef1f8] text-sm focus:border-[#3da8ff] focus:outline-none"
            />
            <p className="text-xs text-[#4a5568] mt-1">Must expose an OpenAI-compatible /v1/models endpoint</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">Models Served</label>
            <input
              type="text"
              required
              value={form.models_served}
              onChange={(e) => setForm({ ...form, models_served: e.target.value })}
              placeholder="llama-3.1-8b, mistral-7b"
              className="w-full bg-[#161822] border border-[#1e2a3a] rounded-lg px-4 py-2.5 text-[#eef1f8] text-sm focus:border-[#3da8ff] focus:outline-none"
            />
            <p className="text-xs text-[#4a5568] mt-1">Comma-separated list of model identifiers</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#8b95a8] mb-1">
                Price per query: {priceDisplay(form.price_per_query_micro_usdc)}
              </label>
              <input
                type="range"
                min={10000}
                max={1000000}
                step={10000}
                value={form.price_per_query_micro_usdc}
                onChange={(e) => setForm({ ...form, price_per_query_micro_usdc: parseInt(e.target.value) })}
                className="w-full accent-[#3da8ff]"
              />
              <div className="flex justify-between text-xs text-[#4a5568] mt-1">
                <span>$0.01</span><span>$1.00</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#8b95a8] mb-1">Region (optional)</label>
              <input
                type="text"
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
                placeholder="us-east, eu-west"
                className="w-full bg-[#161822] border border-[#1e2a3a] rounded-lg px-4 py-2.5 text-[#eef1f8] text-sm focus:border-[#3da8ff] focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-1">Description (optional)</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              placeholder="Brief description of your node..."
              className="w-full bg-[#161822] border border-[#1e2a3a] rounded-lg px-4 py-2.5 text-[#eef1f8] text-sm focus:border-[#3da8ff] focus:outline-none resize-none"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-[#8b95a8] hover:text-[#eef1f8] text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-[#3da8ff] hover:bg-[#2b96f0] text-[#eef1f8] rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {submitting ? "Registering..." : "Register"}
            </button>
          </div>
        </form>
      )}

      {nodes.length === 0 ? (
        <div className="bg-[#0f1117] border border-[#1e2a3a] rounded-xl p-12 text-center">
          <Server className="w-12 h-12 text-[#4a5568] mx-auto mb-4" />
          <h3 className="text-lg font-medium text-[#8b95a8]">No nodes registered</h3>
          <p className="text-sm text-[#4a5568] mt-2">
            Register your first self-hosted inference node to start serving AI queries.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[#8b95a8]">{total} node{total !== 1 ? "s" : ""} registered</p>
          {nodes.map((node) => (
            <div key={node.id} className="bg-[#0f1117] border border-[#1e2a3a] rounded-xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <StatusBadge status={node.status} />
                    {node.region && (
                      <span className="text-xs text-[#4a5568] bg-[#161822] px-2 py-0.5 rounded">{node.region}</span>
                    )}
                  </div>
                  <p className="text-sm font-mono text-[#3da8ff] truncate">{node.endpoint_url}</p>
                  {node.description && (
                    <p className="text-sm text-[#8b95a8] mt-1">{node.description}</p>
                  )}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {node.models_served.map((m) => (
                      <span key={m} className="text-xs bg-[#161822] text-[#8b95a8] px-2 py-0.5 rounded">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(node.id)}
                  className="ml-4 p-2 text-[#4a5568] hover:text-red-400 transition-colors"
                  title="Take offline"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-[#1e2a3a]">
                <div>
                  <p className="text-xs text-[#4a5568]">Uptime</p>
                  <p className="text-sm font-medium text-[#eef1f8]">{node.uptime_percent.toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-xs text-[#4a5568]">Total Queries</p>
                  <p className="text-sm font-medium text-[#eef1f8]">{node.total_queries.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-[#4a5568]">Price/Query</p>
                  <p className="text-sm font-medium text-[#eef1f8]">{priceDisplay(node.price_per_query_micro_usdc)}</p>
                </div>
              </div>
              {node.last_heartbeat_at && (
                <p className="text-xs text-[#4a5568] mt-3">
                  Last heartbeat: {new Date(node.last_heartbeat_at).toLocaleString()}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
