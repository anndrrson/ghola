"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="bg-[#08090d] text-[#eef1f8]">
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
          <h1 className="text-2xl font-medium">Ghola is temporarily unavailable</h1>
          <p className="mt-3 text-sm text-[#aab5c8]">No new trade was submitted. Check the status page before trying again.</p>
        </main>
      </body>
    </html>
  );
}
