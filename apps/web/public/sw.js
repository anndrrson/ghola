/*
 * Temporary service-worker kill switch.
 *
 * Why: `/chat` sign-in is currently failing for some users due to an
 * integrity mismatch path that can leave the app stuck on a loading spinner.
 *
 * This worker does three things only:
 * 1) Activates immediately.
 * 2) Deletes prior ghola caches.
 * 3) Unregisters itself so all requests go direct to network.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // best effort
      }

      try {
        await self.clients.claim();
      } catch {
        // best effort
      }

      try {
        const reg = await self.registration.unregister();
        if (reg) {
          const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
          for (const client of clients) {
            try {
              client.navigate(client.url);
            } catch {
              // ignore per-client failures
            }
          }
        }
      } catch {
        // best effort
      }
    })(),
  );
});
