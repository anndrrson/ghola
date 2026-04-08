"use client";

interface AgentAvatarProps {
  displayName: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}

const COLORS = [
  "#3da8ff",
  "#5bb8ff",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#22d3ee",
  "#fb923c",
];

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function AgentAvatar({
  displayName,
  avatarUrl,
  size = 40,
  className = "",
}: AgentAvatarProps) {
  if (avatarUrl) {
    // Plain <img> instead of next/image: avatar URLs come from arbitrary user input
    // and adding every host to next.config.ts remotePatterns isn't practical.
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={avatarUrl}
        alt={displayName}
        width={size}
        height={size}
        className={`rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  const bg = colorFromName(displayName || "agent");
  return (
    <div
      className={`flex items-center justify-center rounded-full font-semibold text-[#08090d] ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: size * 0.4,
      }}
    >
      {initials(displayName || "?")}
    </div>
  );
}
