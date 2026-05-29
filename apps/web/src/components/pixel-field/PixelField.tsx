"use client";

import { useEffect, useRef } from "react";

type PixelFieldProps = {
  /** Pixel square size in CSS pixels. */
  pixelSize?: number;
  /** Hex color string. */
  color?: string;
  /** Spatial frequency of the density field. */
  patternScale?: number;
  /** Overall density bias (0..2). */
  patternDensity?: number;
  /** Per-pixel size/opacity jitter (0..1). */
  pixelJitter?: number;
  /** Edge fade (0..0.5). */
  edgeFade?: number;
  /** Keep the hero center readable (0..10). */
  centerDepletion?: number;
  /** Animation speed multiplier. */
  speed?: number;
  /** Random seed for the field. */
  seed?: number;
  /** Freeze on a single frame without unmounting. */
  paused?: boolean;
  /** Maximum redraw rate. The browser may still composite at display rate. */
  maxFps?: number;
  className?: string;
};

type PixelCell = {
  x: number;
  y: number;
  size: number;
  alpha: number;
  phase: number;
  driftX: number;
  driftY: number;
  driftSpeed: number;
};

type RGB = {
  r: number;
  g: number;
  b: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function fract(value: number) {
  return value - Math.floor(value);
}

function hash2(x: number, y: number, seed: number) {
  return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);
}

const BAYER_8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
] as const;

function bayer8(column: number, row: number) {
  const x = ((column % 8) + 8) % 8;
  const y = ((row % 8) + 8) % 8;
  return (BAYER_8[y * 8 + x] + 0.5) / 64;
}

function parseHexColor(hex: string): RGB {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value.padEnd(6, "0").slice(0, 6);
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function buildCells(
  width: number,
  height: number,
  pixelSize: number,
  patternScale: number,
  patternDensity: number,
  pixelJitter: number,
  centerDepletion: number,
  seed: number,
): PixelCell[] {
  const cells: PixelCell[] = [];
  const pitch = Math.max(4, pixelSize * 2);
  const densityBias = clamp(patternDensity / 1.55, 0.18, 1.55);
  const columns = Math.ceil(width / pitch) + 2;
  const rows = Math.ceil(height / pitch) + 2;

  for (let row = -1; row < rows; row += 1) {
    for (let column = -1; column < columns; column += 1) {
      const x = column * pitch;
      const y = row * pitch;
      const nx = x / Math.max(1, width);
      const ny = y / Math.max(1, height);

      const edgeDistance = Math.min(nx, ny, 1 - nx, 1 - ny);
      const edgeBand = 1 - smoothstep(0.02, 0.36, edgeDistance);

      const cornerDistance = Math.min(
        Math.hypot(nx, ny),
        Math.hypot(1 - nx, ny),
        Math.hypot(nx, 1 - ny),
        Math.hypot(1 - nx, 1 - ny),
      );
      const cornerBloom = 1 - smoothstep(0.03, 0.42, cornerDistance);
      const leftShelf = 1 - smoothstep(0.08, 0.36, nx);
      const rightShelf = smoothstep(0.58, 0.96, nx);
      const topShelf = 1 - smoothstep(0.04, 0.28, ny);
      const lowerLeft =
        (1 - smoothstep(0.08, 0.52, Math.hypot(nx - 0.12, ny - 0.78))) * 0.58;

      const centerDistance = Math.hypot((nx - 0.5) * 1.34, (ny - 0.47) * 1.05);
      const readableCenter = smoothstep(
        0.17,
        0.48 + centerDepletion * 0.015,
        centerDistance,
      );

      const textureA =
        Math.sin((nx * 7.0 + seed * 0.013) * patternScale) * 0.5 + 0.5;
      const textureB =
        Math.sin((ny * 9.0 - nx * 2.4 + seed * 0.019) * patternScale) * 0.5 +
        0.5;
      const texture = 0.72 + textureA * 0.16 + textureB * 0.14;

      let density =
        edgeBand * 0.34 +
        cornerBloom * 0.4 +
        leftShelf * 0.16 +
        rightShelf * 0.22 +
        topShelf * 0.18 +
        lowerLeft;
      density *= texture * densityBias * readableCenter;
      density = clamp(density, 0, 0.96);

      const random = hash2(column, row, seed);
      const ordered = bayer8(column, row);
      if (ordered > density) continue;

      const jitter = (random - 0.5) * pixelJitter * 0.35;
      cells.push({
        x,
        y,
        size: clamp(pixelSize * (0.74 + jitter), 1.4, pixelSize),
        alpha: clamp(0.2 + density * 0.82 + random * 0.04, 0, 1),
        phase: (nx * 2.2 + ny * 1.4 + random * 0.18) * Math.PI,
        driftX: (hash2(column, row, seed + 17) - 0.5) * pixelSize * 0.42,
        driftY: (hash2(row, column, seed + 29) - 0.5) * pixelSize * 0.42,
        driftSpeed: 0.75 + hash2(row, column, seed + 91) * 0.65,
      });
    }
  }

  return cells;
}

export function PixelField({
  pixelSize = 5,
  color = "#8fa0bf",
  patternScale = 3,
  patternDensity = 1,
  pixelJitter = 0.12,
  edgeFade = 0.04,
  centerDepletion = 3,
  speed = 0.35,
  seed = 50,
  paused = false,
  maxFps = 42,
  className = "",
}: PixelFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellsRef = useRef<PixelCell[]>([]);
  const colorRef = useRef<RGB>(parseHexColor(color));
  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  const maxFpsRef = useRef(maxFps);
  const visibleRef = useRef(true);
  const reducedMotionRef = useRef(false);
  const startRef = useRef(0);
  const lastDrawRef = useRef(0);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    colorRef.current = parseHexColor(color);
    speedRef.current = speed;
    pausedRef.current = paused;
    maxFpsRef.current = maxFps;
  }, [color, speed, paused, maxFps]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const rebuild = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dprCap = window.innerWidth < 768 ? 1.15 : 1.45;
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cellsRef.current = buildCells(
        width,
        height,
        pixelSize,
        patternScale,
        patternDensity,
        pixelJitter,
        centerDepletion,
        seed,
      );
    };

    const draw = (now: number) => {
      const { width, height } = sizeRef.current;
      if (!width || !height) return;

      const rgb = colorRef.current;
      const time = (now - startRef.current) / 1000;
      const t = reducedMotionRef.current || pausedRef.current ? 0 : time * speedRef.current;
      ctx.clearRect(0, 0, width, height);

      for (const cell of cellsRef.current) {
        const nx = cell.x / width;
        const ny = cell.y / height;
        const edgeDistance = Math.min(nx, ny, 1 - nx, 1 - ny);
        const edgeAlpha =
          edgeFade > 0 ? smoothstep(0, edgeFade, edgeDistance) : 1;
        const driftPhase = t * cell.driftSpeed + cell.phase;
        const x = Math.round(cell.x + Math.sin(driftPhase) * cell.driftX);
        const y = Math.round(
          cell.y + Math.cos(driftPhase * 0.86 + cell.phase) * cell.driftY,
        );
        const alpha = clamp(cell.alpha * edgeAlpha, 0, 1);

        if (alpha < 0.025) continue;
        const size = cell.size;
        ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(3)})`;
        ctx.fillRect(x, y, size, size);

        if (size >= 3) {
          const highlight = clamp(alpha * 0.42, 0, 0.34);
          const shadow = clamp(alpha * 0.48, 0, 0.38);
          ctx.fillStyle = `rgba(255, 255, 255, ${highlight.toFixed(3)})`;
          ctx.fillRect(x, y, size, 1);
          ctx.fillRect(x, y, 1, size);
          ctx.fillStyle = `rgba(0, 0, 0, ${shadow.toFixed(3)})`;
          ctx.fillRect(x, y + size - 1, size, 1);
          ctx.fillRect(x + size - 1, y, 1, size);
        }
      }
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = reducedMotion.matches;
    startRef.current = performance.now();

    let raf = 0;
    const tick = (now: number) => {
      if (visibleRef.current) {
        const frameInterval = 1000 / clamp(maxFpsRef.current, 1, 60);
        if (!lastDrawRef.current || now - lastDrawRef.current >= frameInterval) {
          lastDrawRef.current = now;
          draw(now);
        }
      }
      if (!reducedMotionRef.current && !pausedRef.current) {
        raf = requestAnimationFrame(tick);
      }
    };

    const ro = new ResizeObserver(() => {
      rebuild();
      draw(performance.now());
    });
    ro.observe(canvas);

    const io = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((entry) => entry.isIntersecting);
        if (visibleRef.current && !reducedMotionRef.current && !pausedRef.current) {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(tick);
        }
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const handleReducedMotionChange = () => {
      reducedMotionRef.current = reducedMotion.matches;
      draw(performance.now());
      if (!reducedMotionRef.current && !pausedRef.current) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      }
    };
    reducedMotion.addEventListener("change", handleReducedMotionChange);

    rebuild();
    draw(performance.now());
    if (!reducedMotionRef.current && !pausedRef.current) {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      reducedMotion.removeEventListener("change", handleReducedMotionChange);
    };
  }, [
    pixelSize,
    patternScale,
    patternDensity,
    pixelJitter,
    edgeFade,
    centerDepletion,
    seed,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 block h-full w-full ${className}`}
    />
  );
}
