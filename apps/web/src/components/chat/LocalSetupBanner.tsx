"use client";

import { useEffect, useState } from "react";
import { Check, Laptop, X } from "lucide-react";
import {
  clearPairToken,
  getGholaHomeUrl,
  pairWithGholaHome,
  probeGholaHome,
  setGholaHomeUrl,
  type GholaHomeStatus,
} from "@/lib/local-inference";

// Polls ghola-home and renders a thin banner under the chat header
// when Local mode is the active sovereignty mode. Three states:
//   1. probing — neutral grey, no action
//   2. available + paired — green confirmation, dismissable
//   3. available + unpaired — amber, opens pair dialog on click
//   4. unavailable — red, links to install docs (direct URL only)
//
// Re-probes on a 5s cadence while the banner is mounted so the user
// sees status changes (e.g. they start ghola-home in another window)
// without manually refreshing.
const POLL_INTERVAL_MS = 5000;

export function LocalSetupBanner() {
  const [status, setStatus] = useState<GholaHomeStatus | null>(null);
  const [dialog, setDialog] = useState<null | "pair" | "url">(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const next = await probeGholaHome();
      if (cancelled) return;
      setStatus(next);
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!status) {
    return (
      <div className="px-4 py-2 border-b border-[#1e2a3a] bg-[#0a0b10] text-[11px] text-[#6f798c] flex items-center gap-2">
        <Laptop className="h-3 w-3" />
        Checking ghola-home…
      </div>
    );
  }

  // Green: connected and paired.
  if (status.available && status.paired) {
    return (
      <div className="px-4 py-2 border-b border-[#1e2a3a] bg-emerald-500/5 text-[11px] text-emerald-300 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Check className="h-3 w-3" />
          Connected to ghola-home — your messages stay on this machine.
        </span>
        <button
          type="button"
          onClick={() => {
            clearPairToken();
            void probeGholaHome().then(setStatus);
          }}
          className="text-[10px] text-emerald-300/60 hover:text-emerald-200 cursor-pointer"
        >
          Unpair
        </button>
      </div>
    );
  }

  // Amber: available but not paired.
  if (status.available && !status.paired) {
    return (
      <>
        <div className="px-4 py-2 border-b border-[#1e2a3a] bg-amber-500/5 text-[11px] text-amber-200 flex items-center justify-between gap-2">
          <span>
            ghola-home is running at {status.baseUrl} but this browser
            isn&apos;t paired yet.
          </span>
          <button
            type="button"
            onClick={() => setDialog("pair")}
            className="rounded-full bg-amber-500/20 px-3 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/30 cursor-pointer"
          >
            Pair this browser
          </button>
        </div>
        {dialog === "pair" && (
          <PairDialog
            onClose={() => setDialog(null)}
            onPaired={() => {
              setDialog(null);
              void probeGholaHome().then(setStatus);
            }}
          />
        )}
      </>
    );
  }

  // Red: not reachable.
  return (
    <>
      <div className="px-4 py-2 border-b border-[#1e2a3a] bg-red-500/5 text-[11px] text-red-300 flex items-center justify-between gap-2">
        <span className="truncate">
          ghola-home not reachable at {status.baseUrl}
          {status.reason ? ` (${status.reason})` : ""}.
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setDialog("url")}
            className="text-[10px] text-red-300/70 hover:text-red-200 cursor-pointer"
          >
            Set URL
          </button>
          <a
            href="/security#local"
            className="rounded-full border border-red-500/30 px-3 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/10"
          >
            How to install
          </a>
        </div>
      </div>
      {dialog === "url" && (
        <UrlDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void probeGholaHome().then(setStatus);
          }}
        />
      )}
    </>
  );
}

interface PairDialogProps {
  onClose: () => void;
  onPaired: () => void;
}

function PairDialog({ onClose, onPaired }: PairDialogProps) {
  const [pin, setPin] = useState("");
  const [deviceName, setDeviceName] = useState(
    typeof navigator !== "undefined" ? `Web · ${navigator.platform}` : "Web",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await pairWithGholaHome(pin.trim(), deviceName.trim() || "Web");
    setBusy(false);
    if (res.ok) {
      onPaired();
    } else {
      setError(res.error ?? "Pairing failed.");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold text-[#eef1f8]">
            Pair this browser
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-[11px] text-[#8b95a8] leading-relaxed mb-5">
          Open the ghola-home app on this Mac. The PIN is printed in the
          startup log and tray menu. Once paired, Local mode routes
          straight to ghola-home and never touches the cloud.
        </p>
        <label className="block mb-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#6f798c]">
            PIN
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="123456"
            className="mt-1 w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm font-mono text-[#eef1f8] placeholder-[#4a5568] outline-none focus:border-[#3da8ff]"
          />
        </label>
        <label className="block mb-5">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#6f798c]">
            Device name
          </span>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm text-[#eef1f8] outline-none focus:border-[#3da8ff]"
          />
        </label>
        {error && (
          <p className="text-[11px] text-red-300 mb-3">{error}</p>
        )}
        <button
          type="submit"
          disabled={!pin.trim() || busy}
          className="w-full rounded-full bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] disabled:opacity-50 cursor-pointer"
        >
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </div>
  );
}

interface UrlDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

function UrlDialog({ onClose, onSaved }: UrlDialogProps) {
  const [url, setUrl] = useState(getGholaHomeUrl());

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.startsWith("http")) return;
    setGholaHomeUrl(url.trim());
    onSaved();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold text-[#eef1f8]">
            ghola-home URL
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-[11px] text-[#8b95a8] leading-relaxed mb-5">
          Default is 127.0.0.1:7878. Change this if you&apos;ve set
          GHOLA_HOME_BIND to a different port or you&apos;re running
          ghola-home on another machine on your network.
        </p>
        <input
          type="text"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full rounded-lg border border-[#1e2a3a] bg-[#161822] px-3 py-2 text-sm font-mono text-[#eef1f8] outline-none focus:border-[#3da8ff] mb-5"
        />
        <button
          type="submit"
          className="w-full rounded-full bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] cursor-pointer"
        >
          Save
        </button>
      </form>
    </div>
  );
}
