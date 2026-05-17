// Route-level loading UI rendered while the page's React server
// component is streaming and during client hydration. The shapes
// below mirror the landing page's visual rhythm (hero headline,
// subtitle, CTA row, credentials strip, pillars section) so the
// jump from skeleton → real content is minimal. No copy — pure
// shape skeletons so we don't accidentally flash placeholder text.
//
// Lives at the app root so it covers EVERY route by default; Next
// will prefer a nested loading.tsx where one exists.

export default function Loading() {
  return (
    <div className="min-h-screen pt-16 bg-[#08090d] text-[#eef1f8]">
      {/* ───── Hero skeleton ───── */}
      <section className="relative flex flex-col overflow-hidden">
        <div className="relative">
          <div className="mx-auto w-full max-w-6xl px-6 lg:px-12 pt-24 pb-20 sm:pt-32 sm:pb-24">
            {/* "Live" pulse + label row */}
            <div className="flex items-center gap-2 mb-10">
              <span className="h-2 w-2 rounded-full bg-[#22c55e]/40 animate-pulse" />
              <span
                aria-hidden
                className="h-3 w-12 rounded bg-[#14202e] animate-pulse"
              />
            </div>

            {/* Headline — two rows to match the wrapped clamp size of
                "The most private AI." */}
            <div
              aria-hidden
              className="h-[clamp(3rem,9vw,7.5rem)] w-3/4 max-w-[44rem] rounded-lg bg-[#0f141c] animate-pulse"
            />
            <div
              aria-hidden
              className="mt-4 h-[clamp(2rem,5vw,4rem)] w-1/2 max-w-[28rem] rounded-lg bg-[#0f141c] animate-pulse"
            />

            {/* Subtitle */}
            <div
              aria-hidden
              className="mt-10 h-5 w-full max-w-md rounded bg-[#14202e] animate-pulse"
            />
            <div
              aria-hidden
              className="mt-2 h-5 w-2/3 max-w-sm rounded bg-[#14202e] animate-pulse"
            />

            {/* CTA row — primary + secondary */}
            <div className="mt-12 flex flex-wrap items-center gap-4">
              <div
                aria-hidden
                className="h-12 w-36 rounded-full bg-[#1e2a3a] animate-pulse"
              />
              <div
                aria-hidden
                className="h-12 w-36 rounded-full border border-[#1e2a3a] animate-pulse"
              />
            </div>
          </div>
        </div>

        {/* Credentials strip (Attested · On-chain · Open weights) */}
        <div className="relative border-t border-[#1e2a3a] bg-[#0a0b10]/60">
          <div className="mx-auto max-w-6xl px-6 lg:px-12 py-5 flex flex-wrap items-center gap-x-8 gap-y-2">
            <div className="h-3 w-16 rounded bg-[#14202e] animate-pulse" />
            <div className="h-3 w-20 rounded bg-[#14202e] animate-pulse" />
            <div className="h-3 w-24 rounded bg-[#14202e] animate-pulse" />
          </div>
        </div>
      </section>

      {/* ───── Pillars skeleton ───── */}
      <section className="pt-28 sm:pt-36">
        <div className="mx-auto w-full max-w-6xl px-6 lg:px-12">
          <div className="flex items-baseline gap-6 mb-16">
            <div className="h-3 w-32 rounded bg-[#14202e] animate-pulse" />
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>

          <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#1e2a3a] border-y border-[#1e2a3a]">
            {[0, 1, 2].map((i) => (
              <div key={i} className="p-8 lg:p-10 space-y-4">
                <div className="h-7 w-32 rounded bg-[#0f141c] animate-pulse" />
                <div className="h-4 w-full rounded bg-[#14202e] animate-pulse" />
                <div className="h-4 w-5/6 rounded bg-[#14202e] animate-pulse" />
                <div className="h-4 w-3/4 rounded bg-[#14202e] animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
