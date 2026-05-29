"use client";

import dynamic from "next/dynamic";

const PixelField = dynamic(
  () => import("@/components/pixel-field").then((mod) => mod.PixelField),
  { ssr: false, loading: () => null },
);

export function HomePixelBackdrop() {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 opacity-[0.78]">
        <PixelField
          color="#aebad3"
          pixelSize={4}
          patternScale={2.9}
          patternDensity={1.68}
          pixelJitter={0.02}
          edgeFade={0.01}
          centerDepletion={0}
          speed={1.05}
          seed={81}
          maxFps={42}
        />
      </div>
      <div className="pointer-events-none absolute inset-0 opacity-[0.42]">
        <PixelField
          color="#467fb2"
          pixelSize={6}
          patternScale={3.8}
          patternDensity={1.46}
          pixelJitter={0.03}
          edgeFade={0.01}
          centerDepletion={0}
          speed={0.82}
          seed={137}
          maxFps={36}
        />
      </div>
    </>
  );
}
