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
      {/* Outer eye shape — almond */}
      <path
        d="M2 16C2 16 8 6 16 6C24 6 30 16 30 16C30 16 24 26 16 26C8 26 2 16 2 16Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Iris — spice blue */}
      <circle cx="16" cy="16" r="6" fill="#3da8ff" />
      {/* Pupil */}
      <circle cx="16" cy="16" r="2.5" fill="#08090d" />
    </svg>
  );
}
