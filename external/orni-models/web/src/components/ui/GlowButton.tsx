import { ButtonHTMLAttributes } from "react";

interface GlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
}

const variantStyles = {
  primary:
    "bg-[#fafafa] text-[#0a0a0a] font-medium hover:bg-[#e5e5e5]",
  secondary:
    "border border-[#262626] text-[#a1a1a1] hover:text-[#fafafa] hover:border-[#333]",
  ghost:
    "text-[#a1a1a1] hover:text-[#fafafa]",
};

const sizeStyles = {
  sm: "px-3 py-1.5 text-xs rounded-lg gap-1.5",
  md: "px-5 py-2.5 text-sm rounded-lg gap-2",
  lg: "px-7 py-3.5 text-base rounded-lg gap-2",
};

export default function GlowButton({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: GlowButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center transition-colors active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
