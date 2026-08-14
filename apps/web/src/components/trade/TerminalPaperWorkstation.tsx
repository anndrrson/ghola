"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PaperTradingPanelProps } from "./PaperTradingPanel";

const LazyPaperTradingPanel = dynamic(
  () => import("./PaperTradingPanel").then((module) => module.PaperTradingPanel),
  {
    ssr: false,
    loading: () => (
      <div role="status" className="border-t border-[#182234] bg-[#070a10] px-4 py-4 text-[10px] text-amber-100">
        Opening local PAPER workstation…
      </div>
    ),
  },
);

export const TERMINAL_OPEN_PAPER_EVENT = "ghola:open-paper";

export const TerminalPaperWorkstation = memo(function TerminalPaperWorkstation({
  inert,
  ...panelProps
}: PaperTradingPanelProps & { inert?: boolean }) {
  const [active, setActive] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activate = useCallback(() => setActive(true), []);

  useEffect(() => {
    window.addEventListener(TERMINAL_OPEN_PAPER_EVENT, activate);
    return () => window.removeEventListener(TERMINAL_OPEN_PAPER_EVENT, activate);
  }, [activate]);

  useEffect(() => {
    if (active || typeof IntersectionObserver === "undefined") return;
    const target = rootRef.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setActive(true);
        observer.disconnect();
      }
    }, { rootMargin: "400px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div
      ref={rootRef}
      id="paper-workstation"
      tabIndex={-1}
      inert={inert ? true : undefined}
      className="scroll-mt-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300/60"
    >
      {active ? (
        <LazyPaperTradingPanel {...panelProps} />
      ) : (
        <section className="border-t border-[#182234] bg-[#070a10] px-4 py-5" aria-labelledby="paper-workstation-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="paper-workstation-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#dce6f4]">PAPER workstation</h2>
              <p className="mt-1 text-[9px] leading-4 text-[#7d8ba5]">Local simulator loads only when opened or near the viewport, keeping the live terminal path lean.</p>
            </div>
            <button type="button" onClick={activate} className="term-chip h-9 shrink-0 px-3 text-[10px] uppercase">
              Open PAPER
            </button>
          </div>
        </section>
      )}
    </div>
  );
});
