interface GholaLogoProps {
  size?: number;
  className?: string;
}

export function GholaLogo({ size = 32, className = "" }: GholaLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Head — fully formed */}
      <circle cx="16" cy="5.5" r="3" fill="#3da8ff" />

      {/* Shoulders — solid, widest element */}
      <rect x="8.5" y="10" width="15" height="2.5" rx="1.25" fill="#3da8ff" />

      {/* Chest — solid */}
      <rect x="10.5" y="14" width="11" height="2" rx="1" fill="#3da8ff" />

      {/* Waist — beginning to split */}
      <rect x="11" y="17.5" width="4" height="1.8" rx="0.9" fill="#3da8ff" opacity="0.75" />
      <rect x="17" y="17.5" width="4" height="1.8" rx="0.9" fill="#3da8ff" opacity="0.75" />

      {/* Fragments — dispersing */}
      <rect x="9" y="21" width="3" height="1.5" rx="0.75" fill="#3da8ff" opacity="0.5" />
      <rect x="14.5" y="21.5" width="3" height="1.3" rx="0.65" fill="#3da8ff" opacity="0.45" />
      <rect x="20" y="20.5" width="2.5" height="1.3" rx="0.65" fill="#3da8ff" opacity="0.4" />

      {/* Particles — arriving from below */}
      <circle cx="10" cy="25" r="1" fill="#3da8ff" opacity="0.3" />
      <circle cx="16" cy="25.5" r="0.9" fill="#3da8ff" opacity="0.25" />
      <circle cx="21" cy="24.5" r="0.8" fill="#3da8ff" opacity="0.2" />
      <circle cx="13" cy="28" r="0.7" fill="#3da8ff" opacity="0.2" />
      <circle cx="18.5" cy="28.5" r="0.6" fill="#3da8ff" opacity="0.2" />
    </svg>
  );
}
