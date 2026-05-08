import { InputHTMLAttributes } from "react";

interface GlassInputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
}

export default function GlassInput({
  icon,
  className = "",
  ...props
}: GlassInputProps) {
  return (
    <div className="relative">
      {icon && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[#666]">
          {icon}
        </div>
      )}
      <input
        className={`w-full rounded-lg bg-[#141414] border border-[#262626] px-4 py-2.5 text-sm text-[#fafafa] placeholder-[#666] outline-none transition-colors focus:border-[#444] ${
          icon ? "pl-10" : ""
        } ${className}`}
        {...props}
      />
    </div>
  );
}
