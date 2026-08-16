"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const DESKTOP_TICKET_QUERY = "(min-width: 1280px)";

export function TerminalResponsiveTicketMount({
  mobileOpen,
  render,
}: {
  mobileOpen: boolean;
  render: () => ReactNode;
}) {
  const desktop = useSyncExternalStore(
    subscribeDesktopTicket,
    desktopTicketSnapshot,
    () => false,
  );
  return mobileOpen || desktop ? render() : null;
}

function subscribeDesktopTicket(notify: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DESKTOP_TICKET_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

function desktopTicketSnapshot() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(DESKTOP_TICKET_QUERY).matches;
}
