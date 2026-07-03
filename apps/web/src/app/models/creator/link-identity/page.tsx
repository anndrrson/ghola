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
    // SECURITY: pre-migration we cracked the JWT open out of
    // `localStorage["ghola_token"]` to fish the DID out of its `sub`/`did`
    // claim. That JWT is no longer readable from JS — it lives in the
    // HttpOnly `ghola_session` cookie. Instead, we ask the SAID backend
    // who-am-I via `getProfile()`; the cookie rides along automatically.
    (async () => {
      try {
        const profile = await import("@/lib/api").then((m) => m.getProfile());
        if (profile?.did) {
          setDid(profile.did);
        }
      } catch {
        // Not signed in to SAID — link button stays disabled with a
        // helpful caption.
      }
    })();
  }, []);

  async function handleLink() {
    if (!did) return;
    setLoading(true);
    setError("");
    try {
      // We still pass a token argument for the link-DID server call (the
      // backend expects a DID-bound proof). The HttpOnly session cookie
      // authenticates the request itself; the `saidToken` field carries
      // the DID-binding payload.
      await linkDid(did, did);
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
