interface BadgeProps {
  children: React.ReactNode;
  color?: "green" | "gold" | "red" | "neutral";
  className?: string;
}

const colorStyles = {
  green: "bg-[#00E5A0]/10 text-[#00E5A0] border-[#00E5A0]/20",
  gold: "bg-[#f59e0b]/10 text-[#f59e0b] border-[#f59e0b]/20",
  red: "bg-[#ef4444]/10 text-[#ef4444] border-[#ef4444]/20",
  neutral: "bg-[#222] text-[#a1a1a1] border-[#333]",
};

export default function Badge({
  children,
  color = "neutral",
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colorStyles[color]} ${className}`}
    >
      {children}
    </span>
  );
}
