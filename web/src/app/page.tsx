"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Phone, Mail, Calendar, Check, MessageCircle, Code } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";

export default function Home() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && authenticated) {
      router.push("/chat");
    }
  }, [authenticated, loading, router]);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!heroRef.current) return;
      const rect = heroRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 20;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * 20;
      heroRef.current.style.setProperty("--parallax-x", `${x}px`);
      heroRef.current.style.setProperty("--parallax-y", `${y}px`);
    }
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  if (loading || authenticated) return null;

  return (
    <div className="min-h-screen pt-16">
      {/* ──────────── Hero ──────────── */}
      <section
        ref={heroRef}
        className="relative min-h-[calc(100vh-4rem)] flex items-center overflow-hidden"
        style={
          {
            "--parallax-x": "0px",
            "--parallax-y": "0px",
          } as React.CSSProperties
        }
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle, #1e2a3a 1px, transparent 1px)",
            backgroundSize: "32px 32px",
            transform: "translate(var(--parallax-x), var(--parallax-y))",
            transition: "transform 0.15s ease-out",
          }}
        />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-24 sm:py-32">
          <div className="max-w-3xl">
            <h1 className="text-5xl md:text-7xl font-medium tracking-tight text-[#eef1f8] leading-[1.08]">
              Your AI assistant
              <br />
              that actually
              <br />
              <span className="text-[#3da8ff]">does things.</span>
            </h1>
            <p className="mt-8 text-lg md:text-xl text-[#8b95a8] leading-relaxed max-w-2xl">
              Make phone calls, send emails, manage your calendar — all from a
              simple chat. No app to download. Works in your browser{" "}
              <span className="text-[#eef1f8]">and on Telegram</span>.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row gap-4">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Get started free
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/signin"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Features ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-medium text-[#eef1f8] mb-4 text-center">
            What Ghola can do
          </h2>
          <p className="text-[#8b95a8] mb-12 text-center max-w-lg mx-auto">
            Just tell Ghola what you need. It handles the rest.
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 max-w-5xl mx-auto">
            {[
              {
                icon: Phone,
                title: "Phone Calls",
                desc: 'Say "Call Joe\'s Pizza and book a table for 4 at 7pm" — Ghola makes the call, gives you the transcript.',
              },
              {
                icon: Mail,
                title: "Emails",
                desc: "Draft, review, and send emails through your Gmail. AI writes it, you approve before it sends.",
              },
              {
                icon: Calendar,
                title: "Calendar",
                desc: "Schedule appointments, check availability, set reminders. Your calendar, managed by AI.",
              },
              {
                icon: MessageCircle,
                title: "Telegram",
                desc: "Connect your Telegram and chat with Ghola from anywhere. Make calls and send emails without opening a browser.",
              },
            ].map((card) => {
              const Icon = card.icon;
              return (
                <div
                  key={card.title}
                  className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6 hover:border-[#2a3a50] transition-colors"
                >
                  <div className="h-10 w-10 rounded-lg bg-[#3da8ff]/10 flex items-center justify-center mb-4">
                    <Icon className="h-5 w-5 text-[#3da8ff]" />
                  </div>
                  <h3 className="text-[#eef1f8] font-medium mb-1.5">
                    {card.title}
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed">
                    {card.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ──────────── How it works ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-medium text-[#eef1f8] mb-12 text-center">
            Dead simple
          </h2>
          <div className="grid gap-8 sm:grid-cols-3 max-w-3xl mx-auto">
            {[
              { step: "1", title: "Sign up", desc: "Name, email, password. That's it." },
              { step: "2", title: "Chat", desc: "Tell Ghola what you need in plain English." },
              { step: "3", title: "Done", desc: "Ghola makes the call, sends the email, books the appointment." },
            ].map((s) => (
              <div key={s.step} className="text-center">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#3da8ff]/10 text-sm font-medium text-[#3da8ff] mb-3">
                  {s.step}
                </span>
                <h3 className="text-[#eef1f8] font-medium mb-1">{s.title}</h3>
                <p className="text-sm text-[#8b95a8]">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ──────────── Telegram ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#3da8ff]/10 mb-6">
              <MessageCircle className="h-7 w-7 text-[#3da8ff]" />
            </div>
            <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
              Works on Telegram too
            </h2>
            <p className="text-[#8b95a8] mb-8 leading-relaxed">
              Connect your Telegram account and message Ghola like you&apos;d message a friend.
              Make phone calls, send emails, and manage tasks — all from the app you already use every day.
            </p>
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
            >
              Get started free
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ──────────── Developer API ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[#3da8ff]/10 mb-6">
              <Code className="h-7 w-7 text-[#3da8ff]" />
            </div>
            <h2 className="text-3xl font-medium text-[#eef1f8] mb-4">
              Developer API
            </h2>
            <p className="text-[#8b95a8] mb-8 leading-relaxed">
              Build on top of Ghola with an OpenAI-compatible API. Make phone calls, send emails, and
              chat — all programmatically. Works with any OpenAI SDK.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/developers"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-7 py-3.5 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Explore the API
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/developers/docs"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#1e2a3a] px-7 py-3.5 text-base font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Read the docs
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Pricing ──────────── */}
      <section className="py-24 sm:py-32 border-t border-[#1e2a3a]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-medium text-[#eef1f8] mb-4 text-center">
            Pricing
          </h2>
          <p className="text-[#8b95a8] mb-12 text-center max-w-lg mx-auto">
            Start free. Upgrade when you need more.
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 max-w-5xl mx-auto">
            {/* Free */}
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
              <h3 className="text-lg font-medium text-[#eef1f8]">Free</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">
                $0<span className="text-base text-[#4a5568]">/forever</span>
              </p>
              <ul className="mt-6 space-y-3">
                {["5 calls/month", "10 emails/month", "AI chat", "Calendar management"].map(
                  (f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 text-sm text-[#8b95a8]"
                    >
                      <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />
                      {f}
                    </li>
                  )
                )}
              </ul>
              <Link
                href="/signup"
                className="mt-8 block w-full rounded-xl border border-[#1e2a3a] py-2.5 text-center text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Get started
              </Link>
            </div>

            {/* Pro */}
            <div className="rounded-xl border border-[#3da8ff] bg-[#0f1117] p-6 relative">
              <span className="absolute -top-3 left-6 rounded-full bg-[#3da8ff] px-3 py-0.5 text-xs font-medium text-[#08090d]">
                Most popular
              </span>
              <h3 className="text-lg font-medium text-[#eef1f8]">Pro</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">
                $9.99<span className="text-base text-[#4a5568]">/month</span>
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "30 calls/month",
                  "50 emails/month",
                  "Telegram bot",
                  "Bring your own model",
                  "API access (10k calls/mo)",
                  "Priority responses",
                ].map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-sm text-[#8b95a8]"
                  >
                    <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-8 block w-full rounded-xl bg-[#3da8ff] py-2.5 text-center text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
              >
                Start free
              </Link>
            </div>

            {/* Unlimited */}
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
              <h3 className="text-lg font-medium text-[#eef1f8]">Unlimited</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">
                $29.99<span className="text-base text-[#4a5568]">/month</span>
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Unlimited calls",
                  "Unlimited emails",
                  "Telegram bot",
                  "Bring your own model",
                  "API access (100k calls/mo)",
                  "Priority support",
                ].map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-sm text-[#8b95a8]"
                  >
                    <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-8 block w-full rounded-xl bg-[#eef1f8] py-2.5 text-center text-sm font-medium text-[#08090d] hover:bg-[#d0d5e0] active:scale-[0.98] transition-all"
              >
                Get unlimited
              </Link>
            </div>

            {/* Enterprise */}
            <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
              <h3 className="text-lg font-medium text-[#eef1f8]">Enterprise</h3>
              <p className="mt-2 text-3xl font-medium text-[#eef1f8]">
                Custom
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Unlimited everything",
                  "Unlimited API calls",
                  "Custom SLA",
                  "Priority support",
                  "Dedicated account manager",
                ].map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-sm text-[#8b95a8]"
                  >
                    <Check className="h-4 w-4 text-[#3da8ff] shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <a
                href="mailto:hello@ghola.xyz"
                className="mt-8 block w-full rounded-xl border border-[#1e2a3a] py-2.5 text-center text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:border-[#2a3a50] active:scale-[0.98] transition-all"
              >
                Contact sales
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────── Final CTA ──────────── */}
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-medium text-[#eef1f8]">
            Your personal AI assistant awaits
          </h2>
          <p className="mt-4 text-[#8b95a8]">
            Sign up in 10 seconds. Start getting things done.
          </p>
          <Link
            href="/signup"
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-xl bg-[#3da8ff] px-8 py-4 text-base font-medium text-[#08090d] hover:bg-[#5bb8ff] active:scale-[0.98] transition-all"
          >
            Get started free
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
