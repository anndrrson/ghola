// Monochrome SVG provider marks rendered as currentColor — they pick up the
// surrounding text color, so a card hover that shifts text to cyan also
// tints the lineage mark to cyan with no extra wiring. The fallback is a
// deterministic two-color gradient seeded from the slug, so unknown providers
// at least have a stable, recognizable identity rather than a "?" circle.

import { memo, type ReactElement } from "react";

interface Props {
  developer?: string;
  slug: string;
  size?: number;
  className?: string;
}

// Each mark is drawn at a 24×24 viewBox so a single `size` prop scales them
// consistently. Stroke and fill use currentColor.
const MARKS: Record<string, (s: number) => ReactElement> = {
  meta: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 14.5c0-3 1.7-7.5 5-7.5 2.5 0 4.4 2.4 6 5.5 1.6 3.1 3.5 5.5 6 5.5 2 0 3-1.5 3-3.3 0-1.7-.8-3-2.4-3-1 0-1.7.5-2.5 1.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 14.7C22 11 20 7 16.5 7c-2.5 0-4.4 2.4-6 5.5C8.9 15.6 7 18 4.5 18 2.5 18 1.5 16.5 1.5 14.7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.5"
      />
    </svg>
  ),
  openai: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2.5l8.66 5v9l-8.66 5-8.66-5v-9l8.66-5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.5l4.33 2.5v5L12 17.5l-4.33-2.5v-5L12 7.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity="0.65"
      />
    </svg>
  ),
  anthropic: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7.4 4h2.4l5.4 16h-2.6l-1.2-3.6H6.4L5.2 20H2.6L7.4 4zM7.1 14h3.7L9 8.5 7.1 14zM15.4 4h2.4l5.4 16h-2.6L15.4 4z" />
    </svg>
  ),
  mistral: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="3" y="4" width="3" height="3" />
      <rect x="9" y="4" width="3" height="3" opacity="0.5" />
      <rect x="3" y="10" width="3" height="3" opacity="0.7" />
      <rect x="9" y="10" width="3" height="3" />
      <rect x="15" y="10" width="3" height="3" opacity="0.5" />
      <rect x="3" y="16" width="3" height="3" opacity="0.5" />
      <rect x="15" y="16" width="3" height="3" opacity="0.7" />
      <rect x="18" y="4" width="3" height="3" opacity="0.7" />
    </svg>
  ),
  google: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4a8 8 0 108 8h-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  microsoft: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="3" y="3" width="8.5" height="8.5" />
      <rect x="12.5" y="3" width="8.5" height="8.5" opacity="0.7" />
      <rect x="3" y="12.5" width="8.5" height="8.5" opacity="0.7" />
      <rect x="12.5" y="12.5" width="8.5" height="8.5" opacity="0.5" />
    </svg>
  ),
  alibaba: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 7c2-2 4-2 6-2s5 1 5 4-2 4-4 4H8c-1 0-2 1-2 2s1 2 2 2h8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  deepseek: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 12c0-4.5 4-8 9-8 3.5 0 6.5 2 8 5-2-1.5-5-2-7-1-2 1-3 3-3 5 0 2 1 4 3 5 2 1 5 .5 7-1-1.5 3-4.5 5-8 5-5 0-9-3.5-9-10z"
        fill="currentColor"
      />
      <circle cx="14" cy="11" r="1" fill="#08090d" />
    </svg>
  ),
  cohere: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
  moonshot: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M14 3a9 9 0 100 18 7.5 7.5 0 010-18z" />
    </svg>
  ),
  nous: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 19V5l14 14V5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  ),
  allenai: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {[3, 9, 15, 21].flatMap((y) =>
        [3, 9, 15, 21].map((x) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r={x === 12 || y === 12 ? 1.4 : 1}
            opacity={(x + y) % 12 === 0 ? 1 : 0.5}
          />
        ))
      )}
    </svg>
  ),
};

const PROVIDER_KEY: Record<string, keyof typeof MARKS> = {
  meta: "meta",
  facebook: "meta",
  openai: "openai",
  "open ai": "openai",
  anthropic: "anthropic",
  mistral: "mistral",
  "mistral ai": "mistral",
  google: "google",
  "google deepmind": "google",
  deepmind: "google",
  microsoft: "microsoft",
  alibaba: "alibaba",
  qwen: "alibaba",
  deepseek: "deepseek",
  cohere: "cohere",
  moonshot: "moonshot",
  "moonshot ai": "moonshot",
  "nous research": "nous",
  nous: "nous",
  "allen ai": "allenai",
  allenai: "allenai",
  ai2: "allenai",
};

function lookupKey(developer?: string): keyof typeof MARKS | null {
  if (!developer) return null;
  return PROVIDER_KEY[developer.trim().toLowerCase()] ?? null;
}

// Deterministic gradient avatar from slug — used when developer is unknown
// or absent. Picks two hues 60° apart, seeded by string hash. Looks like a
// "real" mark rather than a placeholder character.
function gradientFromSlug(slug: string): { a: string; b: string } {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    a: `hsl(${hue}, 60%, 55%)`,
    b: `hsl(${(hue + 60) % 360}, 60%, 35%)`,
  };
}

function ProviderMark({ developer, slug, size = 22, className = "" }: Props) {
  const key = lookupKey(developer);
  if (key) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center text-[#cfd4dd] transition-colors ${className}`}
        title={developer}
      >
        {MARKS[key](size)}
      </span>
    );
  }
  const { a, b } = gradientFromSlug(slug);
  return (
    <span
      aria-hidden
      title={developer || "Unknown provider"}
      className={`inline-flex shrink-0 items-center justify-center rounded-md ${className}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${a}, ${b})`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    />
  );
}

export default memo(ProviderMark);
