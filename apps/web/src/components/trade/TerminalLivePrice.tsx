"use client";

import { memo, useEffect, useRef, useState } from "react";

export interface TerminalLivePriceProps {
  value: number | null;
  formattedValue: string;
  className?: string;
}

/** Keeps the transient tick animation out of the 4,700-line terminal parent. */
export const TerminalLivePrice = memo(function TerminalLivePrice({
  value,
  formattedValue,
  className = "",
}: TerminalLivePriceProps) {
  const previousValueRef = useRef(value);
  const [animationRevision, setAnimationRevision] = useState(0);

  useEffect(() => {
    const changed = value != null && previousValueRef.current != null && value !== previousValueRef.current;
    previousValueRef.current = value;
    if (!changed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setAnimationRevision((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <span
      key={animationRevision}
      data-price-flash={animationRevision > 0 ? "active" : "idle"}
      className={`${className} ${animationRevision > 0 ? "trade-price-flash" : "text-[#f6f8ff]"}`.trim()}
    >
      {formattedValue}
    </span>
  );
});
