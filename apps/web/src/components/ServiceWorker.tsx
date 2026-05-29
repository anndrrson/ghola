"use client";

import { useEffect } from "react";

const CLEANUP_KEY = "ghola:service-worker-cleanup:v1";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    try {
      if (window.localStorage.getItem(CLEANUP_KEY) === "done") return;
    } catch {
      // If storage is unavailable, run the cleanup best-effort.
    }

    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .catch(() => {});

    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {});
    }

    try {
      window.localStorage.setItem(CLEANUP_KEY, "done");
    } catch {
      // Best-effort marker only.
    }
  }, []);

  return null;
}
