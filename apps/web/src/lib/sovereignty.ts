"use client";

import { useCallback, useEffect, useState } from "react";

// Three modes, one per chat message. Default is Private. The picker UI
// surfaces the choice in the chat header; routing through the right
// transport per mode lights up alongside the /inference/sealed PR.
export type SovereigntyMode = "private" | "local" | "open";

const STORAGE_KEY_PREFIX = "ghola:sovereignty-mode";
const DEFAULT_MODE: SovereigntyMode = "private";

export const SOVEREIGNTY_MODES: ReadonlyArray<{
  id: SovereigntyMode;
  label: string;
  blurb: string;
}> = [
  { id: "private", label: "Private", blurb: "TEE-encrypted. Default." },
  { id: "local", label: "Local", blurb: "On-device only." },
  { id: "open", label: "Open", blurb: "Plaintext. Unverified." },
];

function storageKey(userDid: string | null): string {
  return userDid ? `${STORAGE_KEY_PREFIX}:${userDid}` : STORAGE_KEY_PREFIX;
}

function readMode(userDid: string | null): SovereigntyMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(storageKey(userDid));
    if (raw === "private" || raw === "local" || raw === "open") return raw;
  } catch {
    // Private-mode browsers and quota errors are fine to swallow —
    // we just fall back to the default for this session.
  }
  return DEFAULT_MODE;
}

function writeMode(userDid: string | null, mode: SovereigntyMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userDid), mode);
  } catch {
    // Same swallow as readMode — persistence is best-effort.
  }
}

// Hook: returns the current mode and a setter that persists it. The
// mode is keyed per user DID so different signed-in identities don't
// trample each other's preference when they share a browser.
export function useSovereigntyMode(userDid: string | null): {
  mode: SovereigntyMode;
  setMode: (m: SovereigntyMode) => void;
} {
  const [mode, setModeState] = useState<SovereigntyMode>(DEFAULT_MODE);

  useEffect(() => {
    setModeState(readMode(userDid));
  }, [userDid]);

  const setMode = useCallback(
    (m: SovereigntyMode) => {
      setModeState(m);
      writeMode(userDid, m);
    },
    [userDid],
  );

  return { mode, setMode };
}

// Routing skeleton. Today every mode lands on the existing relay path
// over TLS — the differences become observable when the sealed
// inference endpoint (Private) and WebGPU + ghola-home wiring (Local)
// land in the next two commits. Kept here so call sites can already
// branch on `route.transport` and surface honest UI labels for each
// mode without waiting on the backend cut-over.
export type SovereigntyTransport =
  | "relay-plain"
  | "relay-sealed"
  | "webgpu"
  | "ghola-home";

export interface ModeRoute {
  mode: SovereigntyMode;
  transport: SovereigntyTransport;
  // Honest v1 caveat to surface in the receipt body / UI hover:
  // attestation hasn't shipped yet, Local isn't fully wired, etc.
  caveat?: string;
}

export function selectRoute(mode: SovereigntyMode): ModeRoute {
  switch (mode) {
    case "private":
      return {
        mode,
        transport: "relay-plain",
        caveat:
          "v1: relay still sees plaintext. Sealed transport + Nitro attestation land in v2.",
      };
    case "local":
      return {
        mode,
        transport: "webgpu",
        caveat: "v1: WebGPU + ghola-home wiring pending. Today this routes through the relay.",
      };
    case "open":
      return { mode, transport: "relay-plain" };
  }
}
