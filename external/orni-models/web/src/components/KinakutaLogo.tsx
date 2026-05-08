interface KinakutaLogoProps {
  size?: number;
  className?: string;
}

export default function KinakutaLogo({ size = 28, className = "" }: KinakutaLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer hexagonal frame */}
      <path
        d="M16 2L28 9V23L16 30L4 23V9L16 2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      {/* Inner K letterform — angular, geometric */}
      <path
        d="M12 10V22"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 16L20 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M14.5 16L21 22"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Accent nodes */}
      <circle cx="21" cy="10" r="1.5" fill="#F3037E" />
      <circle cx="21" cy="22" r="1.5" fill="#00E5A0" />
    </svg>
  );
}
