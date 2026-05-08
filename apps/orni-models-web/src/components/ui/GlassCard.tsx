interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  featured?: boolean;
}

export default function GlassCard({
  children,
  className = "",
  hover = false,
  featured = false,
}: GlassCardProps) {
  return (
    <div
      className={`rounded-lg bg-[#141414] border border-[#262626] ${
        hover ? "transition-colors duration-150 hover:border-[#333]" : ""
      } ${featured ? "border-l-2 border-l-[#00E5A0]" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
