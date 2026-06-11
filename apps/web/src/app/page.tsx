"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Gauge, LockKeyhole, ReceiptText } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";
import { GholaLogo } from "@/components/GholaLogo";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  decimateCandles,
  frameMidNumber,
  gholaFrameFromHyperliquid,
  type GholaChartCandle,
  type GholaMarketFrame,
} from "@/lib/ghola-market-chart";
import type { HyperliquidMarketSnapshot } from "@/lib/private-account-client";

export default function Home() {
  const thumperAuth = useThumperAuth();
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [frame, setFrame] = useState<GholaMarketFrame | null>(null);

  // Returning users skip the pitch and land in the terminal.
  useEffect(() => {
    if (thumperAuth.authenticated) router.replace("/trade");
  }, [thumperAuth.authenticated, router]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/v1/private-account/hyperliquid/market-snapshot?coin=BTC&interval=5m", {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`market_${res.status}`);
        const body = (await res.json()) as HyperliquidMarketSnapshot;
        if (!cancelled) setFrame(gholaFrameFromHyperliquid(body));
      } catch {
        // leave the skeleton; the preview is decorative here
      }
    }
    void load();
    const interval = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const mid = frameMidNumber(frame);

  function openAuth(mode: AuthMode) {
    setAuthMode(mode);
    setAuthOpen(true);
  }

  return (
    <div className="min-h-screen bg-[#05070b] text-[#eef1f8]">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
        redirectTo="/trade"
      />

      <header className="relative flex h-14 items-center justify-between border-b border-[#182234] bg-gradient-to-b from-[#0a0e16] to-[#070a10] px-4 sm:px-6">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#5aa7ff]/50 to-transparent"
        />
        <Link href="/" className="flex items-center gap-2">
          <GholaLogo size={26} className="text-[#eef1f8]" />
          <span className="text-lg font-semibold">ghola</span>
        </Link>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openAuth("signin")}
            className="rounded-md px-3 py-1.5 text-sm text-[#8b95a8] transition hover:text-[#eef1f8]"
          >
            Sign in
          </button>
          <Link href="/trade" className="trade-action rounded-md px-3 py-1.5 text-sm font-semibold">
            Launch terminal
          </Link>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <AsciiMarketField />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(5,7,11,0)_0%,rgba(5,7,11,0.3)_70%,rgba(5,7,11,0.6)_100%)]"
          />
          <div className="relative mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-5xl flex-col items-center justify-center gap-9 px-4 text-center sm:px-6">
            <h1 className="font-display text-6xl font-semibold leading-[1.02] tracking-tight text-[#f6f8ff] [text-shadow:0_0_80px_rgba(90,167,255,0.25)] sm:text-8xl">
              Trade like a ghost.
            </h1>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/trade"
                className="trade-action inline-flex h-12 items-center gap-2 rounded-md px-6 text-sm font-semibold"
              >
                Launch terminal
                <ArrowRight className="h-4 w-4" />
              </Link>
              <button
                type="button"
                onClick={() => openAuth("signup")}
                className="trade-chip inline-flex h-12 items-center rounded-md px-5 text-sm font-medium"
              >
                Create account
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-xs text-[#566278]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-emerald-200">
                <span aria-hidden className="trade-live-dot h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]" />
                live
              </span>
              <span className="tabular-nums">
                BTC {mid ? formatLandingPrice(mid) : "—"} · Hyperliquid · Phoenix · Coinbase
              </span>
            </div>
          </div>
        </section>

        <section className="border-t border-[#141d2e]">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <Link
              href="/trade"
              aria-label="Open the live trading terminal"
              className="group mx-auto block max-w-xl transition-transform duration-200 hover:-translate-y-1"
            >
              <div className="trade-panel relative rounded-md p-4 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
                <span aria-hidden className="trade-corners pointer-events-none absolute inset-0" />
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 font-mono text-xs text-[#aab5c8]">
                    <span aria-hidden className="trade-live-dot h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]" />
                    BTC-PERP · 5m
                  </span>
                  <span className="font-mono text-sm tabular-nums text-[#f6f8ff]">
                    {mid ? formatLandingPrice(mid) : ""}
                  </span>
                </div>
                <LandingChart frame={frame} />
                <div className="mt-4 rounded-md border border-[#1e2a3a] bg-[#070b12] p-3 shadow-[inset_0_1px_0_rgba(220,238,255,0.04)]">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.24em] text-[#5aa7ff]/70">
                      Mandate
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#566278]">draft</span>
                  </div>
                  <div className="grid gap-1.5 text-sm text-[#7b88a1]">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                      <MiniChip tone="good">Buy $25</MiniChip>
                      <span>of</span>
                      <MiniChip>BTC-PERP</MiniChip>
                      <span>when</span>
                      <MiniChip>higher high + pullback</MiniChip>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                      <MiniChip>enter now</MiniChip>
                      <span>at</span>
                      <MiniChip mono>{mid ? formatLandingPrice(mid) : "61,500.0"}</MiniChip>
                      <span className="text-[#3c4961]">·</span>
                      <span>stop</span>
                      <MiniChip tone="bad" mono>
                        {mid ? formatLandingPrice(mid * 0.9925) : "61,038.0"}
                      </MiniChip>
                      <span className="text-[#3c4961]">·</span>
                      <span>≤</span>
                      <MiniChip tone="warn" mono>50 bps</MiniChip>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-[#5aa7ff] opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  Open the live terminal
                  <ArrowRight className="h-3.5 w-3.5" />
                </div>
              </div>
            </Link>
          </div>
        </section>

        <section className="border-t border-[#141d2e]">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-14 sm:px-6 md:grid-cols-3">
            <PillarCard
              icon={LockKeyhole}
              title="Never exposed"
              body="Your main wallet never touches a venue."
            />
            <PillarCard
              icon={Gauge}
              title="Hard caps"
              body="Loss, slippage, and size are sealed in. The agent can't exceed them."
            />
            <PillarCard
              icon={ReceiptText}
              title="Verifiable"
              body="Every plan is sealed to a commitment before it runs."
            />
          </div>
        </section>

        <section className="border-t border-[#141d2e]">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-16 text-center sm:px-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-[#f6f8ff] sm:text-3xl">
              The terminal is live.
            </h2>
            <p className="max-w-md text-sm leading-6 text-[#8b95a8]">No signup needed to look around.</p>
            <Link
              href="/trade"
              className="trade-action inline-flex h-12 items-center gap-2 rounded-md px-6 text-sm font-semibold"
            >
              Launch terminal
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#141d2e]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 sm:px-6">
          <div className="flex items-center gap-2 text-sm text-[#566278]">
            <GholaLogo size={18} className="text-[#566278]" />
            <span>ghola</span>
          </div>
          <div className="flex flex-wrap items-center gap-5 text-xs text-[#566278]">
            <Link href="/trade" className="transition hover:text-[#eef1f8]">Terminal</Link>
            <Link href="/private-balance" className="transition hover:text-[#eef1f8]">Balance</Link>
            <Link href="/security/status" className="transition hover:text-[#eef1f8]">Security</Link>
            <Link href="/privacy" className="transition hover:text-[#eef1f8]">Privacy</Link>
            <Link href="/terms" className="transition hover:text-[#eef1f8]">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

// A living market rendered in ASCII: ghostly candlesticks march across the
// hero, with character flicker so the field reads as alive code rather than
// a static texture. Honors prefers-reduced-motion by drawing a single frame.
function AsciiMarketField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context = canvasEl.getContext("2d");
    if (!context) return;
    const canvas = canvasEl;
    const ctx = context;

    const CELL_W = 9;
    const CELL_H = 15;
    const TICK_MS = 130;
    const NOISE_GLYPHS = ["·", ".", ":", "<", ">", "+", "|", "/"];
    let raf = 0;
    let lastTick = 0;
    let cols = 0;
    let rows = 0;
    type AsciiCandle = { o: number; c: number; h: number; l: number };
    type Walker = {
      price: number;
      center: number;
      vol: number;
      alpha: number;
      colored: boolean;
      series: AsciiCandle[];
    };
    // Several ghost charts at different depths fill the field; only the
    // front one is tinted by direction.
    const walkers: Walker[] = [
      { price: 0.5, center: 0.5, vol: 0.05, alpha: 1, colored: true, series: [] },
      { price: 0.25, center: 0.24, vol: 0.07, alpha: 0.45, colored: false, series: [] },
      { price: 0.76, center: 0.78, vol: 0.06, alpha: 0.38, colored: false, series: [] },
      { price: 0.4, center: 0.6, vol: 0.1, alpha: 0.26, colored: false, series: [] },
    ];

    function step(walker: Walker): AsciiCandle {
      const open = walker.price;
      walker.price = Math.min(
        0.96,
        Math.max(0.04, walker.price + (Math.random() - 0.5) * walker.vol + (walker.center - walker.price) * 0.012),
      );
      const close = walker.price;
      return {
        o: open,
        c: close,
        h: Math.max(open, close) + Math.random() * walker.vol * 0.8,
        l: Math.min(open, close) - Math.random() * walker.vol * 0.8,
      };
    }

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(rect.width / CELL_W) + 1;
      rows = Math.ceil(rect.height / CELL_H);
      for (const walker of walkers) {
        while (walker.series.length < cols) walker.series.push(step(walker));
        walker.series = walker.series.slice(-cols);
      }
      render();
    }

    function render() {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "top";

      // Sparse drifting noise so the whole field reads as alive code.
      const noiseCount = Math.floor(cols * rows * 0.012);
      for (let n = 0; n < noiseCount; n++) {
        const x = Math.floor(Math.random() * cols) * CELL_W;
        const y = Math.floor(Math.random() * rows) * CELL_H;
        ctx.fillStyle = `rgba(120, 150, 195, ${0.04 + Math.random() * 0.08})`;
        ctx.fillText(NOISE_GLYPHS[Math.floor(Math.random() * NOISE_GLYPHS.length)], x, y);
      }

      for (const walker of walkers) {
        for (let i = 0; i < walker.series.length; i++) {
          const candle = walker.series[i];
          const x = i * CELL_W;
          const up = candle.c >= candle.o;
          // Screen y is inverted: high price sits near the top of the canvas.
          const wickTop = Math.floor((1 - candle.h) * rows);
          const wickBottom = Math.floor((1 - candle.l) * rows);
          const bodyTop = Math.floor((1 - Math.max(candle.o, candle.c)) * rows);
          const bodyBottom = Math.floor((1 - Math.min(candle.o, candle.c)) * rows);
          for (let y = wickTop; y <= wickBottom; y++) {
            const inBody = y >= bodyTop && y <= bodyBottom;
            const roll = Math.random();
            let glyph = inBody ? (up ? "+" : "=") : "|";
            if (roll > 0.965) glyph = roll > 0.985 ? (up ? ">" : "<") : "·";
            if (roll < 0.02) {
              ctx.fillStyle = `rgba(190, 220, 255, ${0.5 * walker.alpha})`;
            } else if (inBody) {
              ctx.fillStyle = walker.colored
                ? up
                  ? `rgba(98, 214, 163, ${0.4 * walker.alpha})`
                  : `rgba(240, 138, 147, ${0.36 * walker.alpha})`
                : `rgba(140, 170, 210, ${0.3 * walker.alpha})`;
            } else {
              ctx.fillStyle = `rgba(140, 170, 210, ${0.18 * walker.alpha})`;
            }
            ctx.fillText(glyph, x, y * CELL_H);
          }
        }
      }

      const front = walkers[0];
      const lastCandle = front.series[front.series.length - 1];
      if (lastCandle) {
        const y = Math.floor((1 - lastCandle.c) * rows) * CELL_H;
        ctx.fillStyle = "rgba(90, 167, 255, 0.28)";
        for (let x = 0; x < rect.width; x += CELL_W * 2) {
          ctx.fillText("-", x, y);
        }
      }
    }

    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      if (now - lastTick < TICK_MS) return;
      lastTick = now;
      for (const walker of walkers) {
        walker.series.push(step(walker));
        if (walker.series.length > cols) walker.series.shift();
      }
      render();
    }

    resize();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) raf = requestAnimationFrame(tick);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}

function MiniChip({
  tone,
  mono,
  children,
}: {
  tone?: "good" | "bad" | "warn";
  mono?: boolean;
  children: React.ReactNode;
}) {
  const color =
    tone === "good"
      ? "border-emerald-300/30 bg-emerald-300/8 text-emerald-200"
      : tone === "bad"
        ? "border-rose-300/30 bg-rose-300/8 text-rose-200"
        : tone === "warn"
          ? "border-[#f8e56b]/30 bg-[#f8e56b]/8 text-[#fff27a]"
          : "border-[#5aa7ff]/30 bg-[#5aa7ff]/8 text-[#cfe2ff]";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[13px] ${color} ${
        mono ? "font-mono tabular-nums" : ""
      }`}
    >
      {children}
    </span>
  );
}

function LandingChart({ frame }: { frame: GholaMarketFrame | null }) {
  const candles = useMemo(() => decimateCandles(frame?.candles ?? [], 64), [frame]);
  const width = 480;
  const height = 200;
  const layout = useMemo(() => {
    const pad = { top: 10, right: 10, bottom: 10, left: 10 };
    const prices = candles
      .flatMap((candle) => [Number(candle.h), Number(candle.l)])
      .filter((price) => Number.isFinite(price) && price > 0);
    if (prices.length === 0) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = Math.max(max - min, max * 0.001);
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = (index: number) => pad.left + (index / Math.max(1, candles.length - 1)) * plotW;
    const y = (price: number) => pad.top + ((max - price) / span) * plotH;
    const candleW = Math.max(2.5, Math.min(7, (plotW / Math.max(1, candles.length)) * 0.6));
    return { x, y, candleW };
  }, [candles]);

  if (!layout) {
    return (
      <div className="grid h-[200px] place-items-center rounded-md border border-[#152238] bg-[#05070b]">
        <span className="font-mono text-xs text-[#566278]">connecting to market…</span>
      </div>
    );
  }
  const last = candles.at(-1);
  const lastClose = last ? Number(last.c) : null;
  const lastUp = last ? Number(last.c) >= Number(last.o) : true;
  return (
    <div className="overflow-hidden rounded-md border border-[#152238] bg-[#05070b]">
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-[200px] w-full" role="img" aria-label="Live BTC chart preview">
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={width}
            y1={height * fraction}
            y2={height * fraction}
            stroke="#10182a"
            strokeWidth="1"
          />
        ))}
        {candles.map((candle: GholaChartCandle, index: number) => {
          const x = layout.x(index);
          const open = layout.y(Number(candle.o));
          const close = layout.y(Number(candle.c));
          const high = layout.y(Number(candle.h));
          const low = layout.y(Number(candle.l));
          const up = Number(candle.c) >= Number(candle.o);
          return (
            <g key={`${candle.t}-${index}`}>
              <line x1={x} x2={x} y1={high} y2={low} stroke={up ? "#62d6a3" : "#f59aa0"} strokeWidth="1.1" />
              <rect
                x={x - layout.candleW / 2}
                y={Math.min(open, close)}
                width={layout.candleW}
                height={Math.max(1.5, Math.abs(close - open))}
                fill={up ? "#58d99a" : "#f08a93"}
                rx="0.5"
              />
            </g>
          );
        })}
        {lastClose != null && (
          <line
            x1="0"
            x2={width}
            y1={layout.y(lastClose)}
            y2={layout.y(lastClose)}
            stroke={lastUp ? "#34d399" : "#fb7185"}
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity="0.8"
          />
        )}
      </svg>
    </div>
  );
}

function PillarCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof LockKeyhole;
  title: string;
  body: string;
}) {
  return (
    <div className="trade-panel rounded-md p-5">
      <span className="grid h-10 w-10 place-items-center rounded-md border border-[#1e2a3a] bg-gradient-to-b from-[#0c1320] to-[#070b12] shadow-[inset_0_1px_0_rgba(220,238,255,0.06)]">
        <Icon className="h-[18px] w-[18px] text-[#5aa7ff]" />
      </span>
      <h3 className="mt-4 font-display text-lg font-semibold tracking-tight text-[#f6f8ff]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[#8b95a8]">{body}</p>
    </div>
  );
}

function formatLandingPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value >= 1_000 ? 1 : 2,
    maximumFractionDigits: value >= 1_000 ? 1 : 2,
  }).format(value);
}
