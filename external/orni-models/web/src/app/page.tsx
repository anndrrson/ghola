"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { getModels, type Model } from "@/lib/api";
import ModelCard from "@/components/ModelCard";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import GlowButton from "@/components/ui/GlowButton";

export default function Home() {
  const [featured, setFeatured] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const heroRef = useRef<HTMLElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const rect = heroRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    setMouse({ x, y });
  }, []);

  useEffect(() => {
    getModels({ sort: "popular", limit: 6 })
      .then((res) => setFeatured(res.models))
      .catch(() => setFeatured([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      {/* Hero */}
      <section ref={heroRef} onMouseMove={handleMouseMove} className="relative overflow-hidden border-b border-[#262626] min-h-[85vh] flex items-center">
        {/* Drifting dot layers — react to cursor */}
        <div
          className="absolute inset-[-64px] animate-drift-dots transition-transform duration-300 ease-out"
          style={{
            backgroundImage: "radial-gradient(#666 1.5px, transparent 1.5px)",
            backgroundSize: "32px 32px",
            transform: `translate(${mouse.x * -20}px, ${mouse.y * -20}px)`,
          }}
        />
        <div
          className="absolute inset-[-64px] animate-drift-dots-slow transition-transform duration-500 ease-out"
          style={{
            backgroundImage: "radial-gradient(#F3037E 1px, transparent 1px)",
            backgroundSize: "64px 64px",
            opacity: 0.15,
            transform: `translate(${mouse.x * -40}px, ${mouse.y * -40}px)`,
          }}
        />
        {/* Radial fade — follows cursor */}
        <div
          className="absolute inset-0 transition-all duration-500 ease-out"
          style={{
            background: `radial-gradient(ellipse at ${50 + mouse.x * 15}% ${50 + mouse.y * 15}%, transparent 35%, #0a0a0a 70%)`,
          }}
        />
        <div className="relative mx-auto max-w-7xl px-4 py-24 text-center">
          <h1 className="mb-4 text-5xl md:text-6xl font-medium tracking-tight text-[#fafafa]">
            AI models by your
            <br />
            favorite creators
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-lg text-[#a1a1a1]">
            Chat with custom AI models trained by top creators. Pay per query,
            earn as a creator. Built on Solana.
          </p>
          <div className="flex justify-center gap-4">
            <Link href="/models">
              <GlowButton variant="primary" size="lg">
                Browse Models
                <ArrowRight className="h-4 w-4" />
              </GlowButton>
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid gap-8 md:grid-cols-3">
          {[
            {
              color: "#F3037E",
              title: "Creator-Trained",
              desc: "Models fine-tuned with unique knowledge and personality from top creators.",
            },
            {
              color: "#00E5A0",
              title: "Pay Per Query",
              desc: "No subscriptions. Pay only for what you use with USDT or USDC on Solana.",
            },
            {
              color: "#F3037E",
              title: "Earn as a Creator",
              desc: "Build and monetize your own AI models. Keep the majority of revenue.",
            },
          ].map((f) => (
            <GlassCard key={f.title} hover className="p-6">
              <div className="mb-4 h-1 w-8 rounded-full" style={{ backgroundColor: f.color }} />
              <h3 className="mb-2 text-lg font-medium text-[#fafafa]">{f.title}</h3>
              <p className="text-sm text-[#a1a1a1]">{f.desc}</p>
            </GlassCard>
          ))}
        </div>
      </section>

      {/* Featured Models */}
      <section className="mx-auto max-w-7xl px-4 pb-16">
        <div className="mb-8 flex items-center justify-between">
          <h2 className="text-2xl font-medium text-[#fafafa]">Featured Models</h2>
          <Link
            href="/models"
            className="flex items-center gap-1 text-sm text-[#a1a1a1] hover:text-[#fafafa] transition-colors"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {loading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-48 animate-pulse rounded-lg bg-[#141414]"
              />
            ))}
          </div>
        ) : featured.length > 0 ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {featured.map((model) => (
              <ModelCard key={model.id} model={model} />
            ))}
          </div>
        ) : (
          <GlassCard className="py-16 text-center">
            <p className="text-[#666]">
              No models yet. Be the first creator to publish!
            </p>
          </GlassCard>
        )}
      </section>
    </div>
  );
}
