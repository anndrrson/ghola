"use client";

import { useState, useEffect } from "react";
import { linkDid } from "@/lib/api";
import Link from "next/link";
import { ShieldCheck, ArrowLeft, Loader2 } from "lucide-react";

export default function LinkIdentityPage() {
  const [did, setDid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Attempt to extract the DID from the stored SAID token (JWT sub claim).
    const token = localStorage.getItem("ghola_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.did) {
          setDid(payload.did);
        } else if (payload.sub) {
          setDid(`did:said:${payload.sub}`);
        }
      } catch {
        // Token is not a valid JWT; user may need to log in to SAID first.
      }
    }
  }, []);

  async function handleLink() {
    if (!did) return;
    const saidToken = localStorage.getItem("ghola_token");
    if (!saidToken) {
      setError("No ghola token found. Please log in to your ghola account first.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await linkDid(did, saidToken);
      setSuccess(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to link identity");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Link
        href="/models/creator"
        className="mb-8 inline-flex items-center gap-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] transition"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Creator Dashboard
      </Link>

      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-8">
        <div className="mb-6 flex items-center gap-3">
          <ShieldCheck className="h-8 w-8 text-[#3da8ff]" />
          <h1 className="text-2xl font-bold text-[#eef1f8]">Link ghola Identity</h1>
        </div>

        <p className="mb-6 text-sm text-[#8b95a8]">
          Connect your ghola identity to your Orni creator account. A verified
          badge will appear on all your model listings.
        </p>

        {success ? (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-center">
            <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-green-400" />
            <p className="text-lg font-semibold text-green-300">
              Identity Linked Successfully
            </p>
            <p className="mt-1 text-sm text-[#8b95a8]">
              Your verified badge will now appear on your model listings.
            </p>
            <Link
              href="/models/creator"
              className="mt-4 inline-block rounded-lg bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#eef1f8] hover:bg-[#5bb8ff] transition"
            >
              Return to Dashboard
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-6 rounded-lg bg-[#161822] p-4">
              <label className="mb-1 block text-xs font-medium text-[#4a5568]">
                Your ghola ID
              </label>
              {did ? (
                <p className="break-all font-mono text-sm text-[#eef1f8]">{did}</p>
              ) : (
                <p className="text-sm text-[#4a5568] italic">
                  No identity detected. Please log in to your ghola account first.
                </p>
              )}
            </div>

            {error && (
              <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            <button
              onClick={handleLink}
              disabled={!did || loading}
              className="w-full rounded-lg bg-[#3da8ff] px-4 py-3 font-medium text-[#eef1f8] transition hover:bg-[#5bb8ff] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Verifying...
                </span>
              ) : (
                "Link Identity"
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
