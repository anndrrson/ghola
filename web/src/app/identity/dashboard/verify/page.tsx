"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getProfile, verifyDomain, checkDomainVerification } from "@/lib/api";
import type { BusinessProfile, DomainVerification } from "@/lib/types";
import {
  Shield,
  ShieldCheck,
  Globe,
  FileText,
  Copy,
  Check,
  ChevronRight,
  Loader2,
  AlertCircle,
} from "lucide-react";

type Step = "status" | "choose" | "instructions" | "pending";
type Method = "dns" | "well-known";

function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname;
  } catch {
    return url;
  }
}

export default function VerifyPage() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("status");
  const [method, setMethod] = useState<Method | null>(null);
  const [verification, setVerification] = useState<DomainVerification | null>(
    null
  );
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!authLoading && !authenticated) {
      router.push("/identity/login");
    }
  }, [authLoading, authenticated, router]);

  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);
    getProfile()
      .then((prof) => {
        setProfile(prof);
        if (prof.verified_domain) {
          setStep("status");
        } else {
          setStep("choose");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authenticated]);

  const domain = useMemo(() => {
    if (!profile?.website) return null;
    return extractDomain(profile.website);
  }, [profile]);

  const handleSelectMethod = async (m: Method) => {
    setMethod(m);
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyDomain(m);
      setVerification(result);
      setStep("instructions");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  const handleVerifyNow = async () => {
    setVerifying(true);
    setError(null);
    try {
      const result = await checkDomainVerification();
      if (result.verified) {
        const prof = await getProfile();
        setProfile(prof);
        setStep("status");
      } else {
        setStep("pending");
        if (result.message) setError(result.message);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification check failed");
      setStep("pending");
    } finally {
      setVerifying(false);
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const dnsRecord = verification
    ? `said-verify=${verification.token}`
    : "";

  const wellKnownJson = verification
    ? JSON.stringify(
        {
          said_verify: verification.token,
          did: profile?.did,
          domain: domain,
        },
        null,
        2
      )
    : "";

  // Step indicator
  const steps = [
    { key: "choose", label: "Choose Method" },
    { key: "instructions", label: "Configure" },
    { key: "pending", label: "Verify" },
  ];

  const stepIndex =
    step === "choose" ? 0 : step === "instructions" ? 1 : step === "pending" ? 2 : -1;

  if (authLoading || !authenticated) {
    return (
      <div className="flex h-screen items-center justify-center pt-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <Shield className="h-6 w-6 text-[#3da8ff]" />
          <h1 className="text-2xl font-bold text-[#eef1f8]">
            Domain Verification
          </h1>
        </div>
        <p className="mt-1 text-[#8b95a8]">
          Verify ownership of your domain to increase trust with AI agents
        </p>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-red-600/30 bg-red-900/20 px-4 py-3">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-[#161822]" />
      ) : profile?.verified_domain && step === "status" ? (
        /* Already Verified */
        <div className="rounded-xl border border-green-600/20 bg-green-900/10 p-8 text-center">
          <ShieldCheck className="mx-auto h-16 w-16 text-green-400 mb-4" />
          <h2 className="text-xl font-semibold text-[#eef1f8] mb-2">
            Domain Verified
          </h2>
          <div className="inline-flex items-center gap-2 rounded-full bg-green-600/15 border border-green-600/25 px-4 py-2 mb-4">
            <Globe className="h-4 w-4 text-green-400" />
            <span className="text-sm font-medium text-green-300">
              {profile.verified_domain}
            </span>
          </div>
          {profile.verified_at && (
            <p className="text-sm text-[#4a5568]">
              Verified on{" "}
              {new Date(profile.verified_at).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          )}
          <p className="mt-4 text-sm text-[#8b95a8] max-w-md mx-auto">
            AI agents will see a verified badge next to your business identity,
            increasing trust and discoverability.
          </p>
        </div>
      ) : (
        /* Verification Wizard */
        <div className="space-y-6">
          {/* Domain being verified */}
          {domain && (
            <div className="flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-3">
              <Globe className="h-4 w-4 text-[#8b95a8]" />
              <span className="text-sm text-[#8b95a8]">
                Verifying domain:
              </span>
              <span className="text-sm font-medium text-[#eef1f8]">{domain}</span>
            </div>
          )}

          {/* Step Indicator */}
          {stepIndex >= 0 && (
            <div className="flex items-center gap-2">
              {steps.map((s, i) => (
                <div key={s.key} className="flex items-center gap-2">
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
                      i <= stepIndex
                        ? "bg-[#2b96f0] text-[#eef1f8]"
                        : "bg-[#1c1f2e] text-[#4a5568]"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <span
                    className={`text-sm ${
                      i <= stepIndex ? "text-[#eef1f8]" : "text-[#4a5568]"
                    }`}
                  >
                    {s.label}
                  </span>
                  {i < steps.length - 1 && (
                    <ChevronRight className="h-4 w-4 text-[#4a5568] mx-1" />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Step 1: Choose Method */}
          {step === "choose" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <button
                onClick={() => handleSelectMethod("dns")}
                disabled={verifying}
                className="group rounded-xl border border-[#1e2a3a] bg-[#161822] p-6 text-left hover:border-[#3da8ff]/50 hover:bg-[#161822]/80 transition-all cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="rounded-lg bg-[#2b96f0]/10 border border-[#2b96f0]/20 p-2.5">
                    <Globe className="h-5 w-5 text-[#3da8ff]" />
                  </div>
                  <h3 className="text-base font-semibold text-[#eef1f8]">
                    DNS TXT Record
                  </h3>
                </div>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  Add a TXT record to your domain&apos;s DNS configuration.
                  Recommended for most users.
                </p>
                {verifying && method === "dns" && (
                  <Loader2 className="mt-3 h-4 w-4 animate-spin text-[#3da8ff]" />
                )}
              </button>
              <button
                onClick={() => handleSelectMethod("well-known")}
                disabled={verifying}
                className="group rounded-xl border border-[#1e2a3a] bg-[#161822] p-6 text-left hover:border-[#3da8ff]/50 hover:bg-[#161822]/80 transition-all cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="rounded-lg bg-[#2b96f0]/10 border border-[#2b96f0]/20 p-2.5">
                    <FileText className="h-5 w-5 text-[#3da8ff]" />
                  </div>
                  <h3 className="text-base font-semibold text-[#eef1f8]">
                    Well-Known File
                  </h3>
                </div>
                <p className="text-sm text-[#8b95a8] leading-relaxed">
                  Host a JSON file at a well-known path on your website.
                  Good if you can&apos;t modify DNS.
                </p>
                {verifying && method === "well-known" && (
                  <Loader2 className="mt-3 h-4 w-4 animate-spin text-[#3da8ff]" />
                )}
              </button>
            </div>
          )}

          {/* Step 2: Instructions */}
          {step === "instructions" && verification && (
            <div className="rounded-xl border border-[#1e2a3a] bg-[#161822] p-6">
              {method === "dns" ? (
                <>
                  <h2 className="text-lg font-semibold text-[#eef1f8] mb-2">
                    Add a DNS TXT Record
                  </h2>
                  <p className="text-sm text-[#8b95a8] mb-4">
                    Go to your DNS provider and add the following TXT record to{" "}
                    <span className="font-medium text-[#eef1f8]">{domain}</span>:
                  </p>
                  <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <code className="text-sm font-mono text-[#5bb8ff] break-all">
                        {dnsRecord}
                      </code>
                      <button
                        onClick={() => handleCopy(dnsRecord)}
                        className="flex-shrink-0 rounded-md bg-[#161822] border border-[#1e2a3a] p-2 text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors cursor-pointer"
                        title="Copy to clipboard"
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 rounded-lg border border-[#1e2a3a]/50 bg-[#0f1117] p-4">
                    <h3 className="text-sm font-medium text-[#8b95a8] mb-2">
                      Instructions
                    </h3>
                    <ol className="space-y-1.5 text-sm text-[#8b95a8] list-decimal list-inside">
                      <li>Log in to your DNS provider (e.g., Cloudflare, Namecheap, Route 53)</li>
                      <li>Navigate to DNS settings for <span className="text-[#eef1f8]">{domain}</span></li>
                      <li>Add a new TXT record with the value above</li>
                      <li>Set the host/name to <code className="text-[#8b95a8]">@</code> (root domain)</li>
                      <li>Save and wait for DNS propagation (may take up to 24 hours)</li>
                    </ol>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-[#eef1f8] mb-2">
                    Create a Well-Known Verification File
                  </h2>
                  <p className="text-sm text-[#8b95a8] mb-4">
                    Create a file at{" "}
                    <code className="text-[#8b95a8]">
                      /.well-known/said-verify.json
                    </code>{" "}
                    on{" "}
                    <span className="font-medium text-[#eef1f8]">{domain}</span>{" "}
                    with this content:
                  </p>
                  <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <pre className="text-sm font-mono text-[#5bb8ff] overflow-x-auto">
                        {wellKnownJson}
                      </pre>
                      <button
                        onClick={() => handleCopy(wellKnownJson)}
                        className="flex-shrink-0 rounded-md bg-[#161822] border border-[#1e2a3a] p-2 text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] transition-colors cursor-pointer"
                        title="Copy to clipboard"
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 rounded-lg border border-[#1e2a3a]/50 bg-[#0f1117] p-4">
                    <h3 className="text-sm font-medium text-[#8b95a8] mb-2">
                      Instructions
                    </h3>
                    <ol className="space-y-1.5 text-sm text-[#8b95a8] list-decimal list-inside">
                      <li>Create a <code className="text-[#8b95a8]">.well-known</code> directory at your site root (if it does not exist)</li>
                      <li>Create a file named <code className="text-[#8b95a8]">said-verify.json</code> inside it</li>
                      <li>Paste the JSON content above into the file</li>
                      <li>Deploy your site so the file is publicly accessible at <code className="text-[#8b95a8]">https://{domain}/.well-known/said-verify.json</code></li>
                    </ol>
                  </div>
                </>
              )}

              <div className="mt-6 flex gap-3">
                <button
                  onClick={handleVerifyNow}
                  disabled={verifying}
                  className="rounded-lg bg-[#2b96f0] px-5 py-2.5 text-sm font-medium text-[#eef1f8] hover:bg-[#3da8ff] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {verifying ? "Checking..." : "Verify Now"}
                </button>
                <button
                  onClick={() => {
                    setStep("choose");
                    setMethod(null);
                    setVerification(null);
                    setCopied(false);
                  }}
                  className="rounded-lg border border-[#1e2a3a] bg-[#161822] px-5 py-2.5 text-sm font-medium text-[#8b95a8] hover:bg-[#1c1f2e] transition-colors cursor-pointer"
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Pending */}
          {step === "pending" && (
            <div className="rounded-xl border border-[#2b96f0]/20 bg-[#0a1929]/10 p-8 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#2b96f0]/10 border border-[#2b96f0]/20">
                <Shield className="h-8 w-8 text-[#3da8ff]" />
              </div>
              <h2 className="text-xl font-semibold text-[#eef1f8] mb-2">
                Verification Pending
              </h2>
              <p className="text-sm text-[#8b95a8] max-w-md mx-auto mb-4">
                We will periodically check your{" "}
                {method === "dns" ? "DNS TXT record" : "well-known file"} for{" "}
                <span className="font-medium text-[#eef1f8]">{domain}</span>. This
                usually takes a few minutes but can take up to 24 hours for DNS
                changes to propagate.
              </p>
              <p className="text-xs text-[#4a5568]">
                You will be notified once verification is complete. You can
                safely leave this page.
              </p>
              <div className="mt-6 flex gap-3 justify-center">
                <button
                  onClick={handleVerifyNow}
                  disabled={verifying}
                  className="rounded-lg bg-[#2b96f0] px-5 py-2.5 text-sm font-medium text-[#eef1f8] hover:bg-[#3da8ff] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {verifying ? "Checking..." : "Check Again"}
                </button>
                <button
                  onClick={() => {
                    setStep("choose");
                    setMethod(null);
                    setVerification(null);
                  }}
                  className="rounded-lg border border-[#1e2a3a] bg-[#161822] px-5 py-2.5 text-sm font-medium text-[#8b95a8] hover:bg-[#1c1f2e] transition-colors cursor-pointer"
                >
                  Start Over
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
