"use client";

import { startTransition, useEffect, useState } from "react";
import { createTerminalMarketScanner, type TerminalMarketScannerTarget } from "./terminal-market-scanner";
import { mergeTerminalWatchlistSources, type TerminalWatchlistSource } from "./terminal-market-watchlist";

export function useTerminalMarketScanner(targets: TerminalMarketScannerTarget[]) {
  const [sources, setSources] = useState<TerminalWatchlistSource[]>([]);

  useEffect(() => {
    const controller = createTerminalMarketScanner({
      targets,
      onSource: (source) => {
        startTransition(() => {
          setSources((current) => mergeTerminalWatchlistSources(current, [source]));
        });
      },
    });
    controller.start();
    return () => controller.stop();
  }, [targets]);

  return sources;
}
