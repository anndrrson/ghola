"use client";

import Link from "next/link";
import { useState } from "react";
import { Copy, Check, Terminal, Search, Shield, CreditCard, ArrowRight, Package } from "lucide-react";

const API = "https://ghola-api.onrender.com/v1";

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-lg border border-[#1e2a3a] bg-[#08090d] overflow-hidden">
      {label && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e2a3a] bg-[#0a0c14]">
          <span className="text-xs text-[#8b95a8] font-mono">{label}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
      <pre className="p-4 text-sm text-[#eef1f8] font-mono overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function MerchantQuickstart() {
  return (
    <div className="min-h-screen pt-16">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        {/* Hero */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#1e2a3a] bg-[#0f1117] px-3 py-1 text-xs text-[#8b95a8] mb-4">
            <Terminal className="h-3 w-3" />
            Merchant API
          </div>
          <h1 className="text-3xl font-medium text-[#eef1f8] mb-3">
            Quickstart
          </h1>
          <p className="text-[#8b95a8] text-lg">
            Register your API, verify agents, get paid. Three commands to get started.
          </p>
        </div>

        {/* Section 1: Discover */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-8 w-8 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center">
              <Search className="h-4 w-4 text-[#3da8ff]" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[#eef1f8]">1. Discover</h2>
              <p className="text-sm text-[#8b95a8]">No auth needed. Try these right now.</p>
            </div>
          </div>

          <div className="space-y-3">
            <CodeBlock
              label="Search for services"
              code={`curl ${API}/services/resolve?task=text+analysis`}
            />
            <CodeBlock
              label="View pricing catalog"
              code={`curl ${API}/pricing`}
            />
            <CodeBlock
              label="Browse all services"
              code={`curl "${API}/services?limit=10"`}
            />
          </div>
        </section>

        {/* Section 2: Verify */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-8 w-8 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center">
              <Shield className="h-4 w-4 text-[#3da8ff]" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[#eef1f8]">2. Verify</h2>
              <p className="text-sm text-[#8b95a8]">Check trust before you pay. No auth needed.</p>
            </div>
          </div>

          <div className="space-y-3">
            <CodeBlock
              label="Look up a DID"
              code={`curl ${API}/verify/did/did:key:z6MkExample`}
            />
            <CodeBlock
              label="Check reputation score"
              code={`curl ${API}/reputation/did:key:z6MkExample`}
            />
            <CodeBlock
              label="Verify x402 merchant before payment"
              code={`curl ${API}/verify/x402/SolanaAddressHere`}
            />
          </div>
        </section>

        {/* Section 3: Register */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-8 w-8 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center">
              <CreditCard className="h-4 w-4 text-[#3da8ff]" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[#eef1f8]">3. Register Your Service</h2>
              <p className="text-sm text-[#8b95a8]">Become a headless merchant in 3 API calls.</p>
            </div>
          </div>

          <div className="space-y-3">
            <CodeBlock
              label="Step 1: Create account"
              code={`curl -X POST ${API}/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "you@example.com",
    "password": "your-password",
    "account_type": "business",
    "business_name": "My Weather API",
    "category": "data"
  }'

# Save the "token" from the response`}
            />
            <CodeBlock
              label="Step 2: Register service"
              code={`curl -X POST ${API}/services/register \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "My Weather API",
    "slug": "my-weather-api",
    "description": "7-day forecast for any location",
    "category": "data",
    "base_url": "https://api.myweather.com",
    "pricing_model": "per_request",
    "price_micro_usdc": 3000,
    "free_tier_requests": 50
  }'

# Save the "id" from the response`}
            />
            <CodeBlock
              label="Step 3: Create service API key"
              code={`curl -X POST ${API}/service-keys \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "service_id": "YOUR_SERVICE_ID",
    "name": "prod-key",
    "scopes": ["verify", "meter"]
  }'

# Save the "key" — shown only once`}
            />
          </div>

          <div className="mt-4 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4">
            <p className="text-sm text-[#8b95a8]">
              <span className="text-[#eef1f8] font-medium">Done.</span> Your service is now discoverable by AI agents.
              They can find it via{" "}
              <code className="text-[#3da8ff] text-xs">/services/resolve</code>, verify your identity, and pay per request.
            </p>
          </div>
        </section>

        {/* Section 4: SDKs */}
        <section className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-8 w-8 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center">
              <Package className="h-4 w-4 text-[#3da8ff]" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[#eef1f8]">SDKs</h2>
              <p className="text-sm text-[#8b95a8]">TypeScript and Python clients.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <CodeBlock
              label="TypeScript"
              code={`npm install @said-id/sdk

import { SAIDClient } from '@said-id/sdk';

const said = new SAIDClient();
const services = await said.searchServices(
  "text analysis"
);
const trust = await said.getTrustScore(
  "did:key:z6Mk..."
);`}
            />
            <CodeBlock
              label="Python"
              code={`pip install said-sdk

from said_sdk import SAIDClient

async with SAIDClient() as said:
    services = await said.search_services(
        "text analysis"
    )
    trust = await said.get_trust_score(
        "did:key:z6Mk..."
    )`}
            />
          </div>
        </section>

        {/* Links */}
        <section className="mb-12">
          <h2 className="text-lg font-medium text-[#eef1f8] mb-4">Next steps</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { href: "/marketplace", label: "Browse Marketplace", desc: "See what's registered", icon: Search },
              { href: "/merchant/register", label: "Register via UI", desc: "Form-based registration", icon: CreditCard },
              { href: "/developers/docs", label: "Full API Docs", desc: "All endpoints documented", icon: Terminal },
              { href: "/provide", label: "Why Ghola?", desc: "The merchant pitch", icon: Shield },
            ].map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="flex items-center gap-3 rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-4 hover:border-[#3da8ff]/30 hover:bg-[#161822] transition-colors"
                >
                  <Icon className="h-4 w-4 text-[#3da8ff] shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-[#eef1f8]">{link.label}</p>
                    <p className="text-xs text-[#8b95a8]">{link.desc}</p>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-[#8b95a8] ml-auto shrink-0" />
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
