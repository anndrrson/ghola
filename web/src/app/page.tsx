import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen pt-16">
      {/* Hero — asymmetric with code block */}
      <section className="border-b border-gray-800">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-24 sm:py-32">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white leading-[1.1]">
                Infrastructure for the Agentic Web
              </h1>
              <p className="mt-6 text-lg text-gray-400 leading-relaxed max-w-lg">
                Make your business discoverable by AI agents. Fine-tune and
                monetize AI models. One platform, open standards.
              </p>
              <div className="mt-10 flex flex-col sm:flex-row gap-4">
                <Link
                  href="/identity/register"
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-coral-500 px-6 py-3 text-base font-semibold text-white hover:bg-coral-600 transition-colors"
                >
                  Create Your Identity
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/models"
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-6 py-3 text-base font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
                >
                  Browse Models
                </Link>
              </div>
            </div>

            {/* agents.txt code block */}
            <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
                <div className="h-3 w-3 rounded-full bg-gray-700" />
                <div className="h-3 w-3 rounded-full bg-gray-700" />
                <div className="h-3 w-3 rounded-full bg-gray-700" />
                <span className="ml-2 text-xs text-gray-500 font-mono">
                  yourdomain.com/agents.txt
                </span>
              </div>
              <pre className="p-5 text-sm font-mono leading-relaxed overflow-x-auto">
                <code>
                  <span className="text-gray-500"># agents.txt — AI agent discovery</span>
                  {"\n\n"}
                  <span className="text-coral-400">Agent</span>
                  <span className="text-gray-300">: *</span>
                  {"\n"}
                  <span className="text-coral-400">Allow</span>
                  <span className="text-gray-300">: /api/v1/</span>
                  {"\n"}
                  <span className="text-coral-400">Description</span>
                  <span className="text-gray-300">: E-commerce product catalog</span>
                  {"\n"}
                  <span className="text-coral-400">Auth</span>
                  <span className="text-gray-300">: Bearer</span>
                  {"\n"}
                  <span className="text-coral-400">Rate-Limit</span>
                  <span className="text-gray-300">: 1000/hour</span>
                  {"\n\n"}
                  <span className="text-gray-500"># Verified on Solana</span>
                  {"\n"}
                  <span className="text-said-400">DID</span>
                  <span className="text-gray-300">: did:said:3EqrapHP...7QyR</span>
                  {"\n"}
                  <span className="text-said-400">Verify</span>
                  <span className="text-gray-300">: solana:mainnet</span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Two Products — staggered rows */}
      <section className="border-b border-gray-800">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {/* Identity row */}
          <div className="grid gap-8 lg:grid-cols-5 py-20 border-b border-gray-800/50">
            <div className="lg:col-span-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-said-400 mb-4">
                Identity
              </p>
              <h2 className="text-3xl font-bold text-white mb-4">
                Be discoverable by AI agents
              </h2>
              <p className="text-gray-400 leading-relaxed max-w-lg">
                Deploy an agents.txt file to your domain. AI agents crawl it to
                understand what your business offers, how to authenticate, and
                what endpoints to call. Verify ownership on-chain with a
                Solana-native DID.
              </p>
              <Link
                href="/identity/register"
                className="inline-flex items-center gap-2 mt-8 text-sm font-semibold text-said-400 hover:text-said-300 transition-colors"
              >
                Set up your identity
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="lg:col-span-2 flex flex-col gap-3">
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-4">
                <p className="text-sm font-medium text-white">agents.txt standard</p>
                <p className="mt-1 text-xs text-gray-500">
                  Open spec for agent-to-business discovery
                </p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-4">
                <p className="text-sm font-medium text-white">Domain verification</p>
                <p className="mt-1 text-xs text-gray-500">
                  Prove ownership via DNS or well-known endpoint
                </p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-4">
                <p className="text-sm font-medium text-white">On-chain DID</p>
                <p className="mt-1 text-xs text-gray-500">
                  Solana-registered identity with verified badge
                </p>
              </div>
            </div>
          </div>

          {/* Models row — reversed */}
          <div className="grid gap-8 lg:grid-cols-5 py-20">
            <div className="lg:col-span-2 lg:order-1 flex flex-col gap-3">
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-4">
                <p className="text-sm font-medium text-white">Custom fine-tuning</p>
                <p className="mt-1 text-xs text-gray-500">
                  Train on your content, docs, or personality
                </p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-4">
                <p className="text-sm font-medium text-white">USDC payments</p>
                <p className="mt-1 text-xs text-gray-500">
                  Pay-per-query with instant Solana settlement
                </p>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-5 py-4">
                <p className="text-sm font-medium text-white">Streaming chat</p>
                <p className="mt-1 text-xs text-gray-500">
                  Real-time SSE responses via Together.ai
                </p>
              </div>
            </div>
            <div className="lg:col-span-3 lg:order-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-coral-400 mb-4">
                Models
              </p>
              <h2 className="text-3xl font-bold text-white mb-4">
                Fine-tune and monetize AI
              </h2>
              <p className="text-gray-400 leading-relaxed max-w-lg">
                Create custom AI models powered by your content. Set your own
                pricing, publish to the marketplace, and earn 85% of every
                conversation. Powered by Together.ai inference.
              </p>
              <Link
                href="/models"
                className="inline-flex items-center gap-2 mt-8 text-sm font-semibold text-coral-400 hover:text-coral-300 transition-colors"
              >
                Browse the marketplace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Stats strip */}
      <section className="py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-px sm:grid-cols-3 rounded-lg border border-gray-800 overflow-hidden">
            <div className="bg-gray-900/50 px-8 py-10 text-center">
              <p className="text-2xl font-bold text-white">Open Standard</p>
              <p className="mt-2 text-sm text-gray-500">
                agents.txt — anyone can implement
              </p>
            </div>
            <div className="bg-gray-900/50 px-8 py-10 text-center border-x border-gray-800">
              <p className="text-2xl font-bold text-white">Solana-Native</p>
              <p className="mt-2 text-sm text-gray-500">
                Wallet auth, on-chain DIDs, USDC
              </p>
            </div>
            <div className="bg-gray-900/50 px-8 py-10 text-center">
              <p className="text-2xl font-bold text-white">85% to Creators</p>
              <p className="mt-2 text-sm text-gray-500">
                Industry-leading revenue split
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
