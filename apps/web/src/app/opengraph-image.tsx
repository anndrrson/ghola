import { ImageResponse } from "next/og";

// Next.js auto-detects this file and wires the output PNG into the
// page's `og:image` meta tag (and `twitter:image` as a fallback when
// twitter.card is `summary_large_image`). Every URL preview anywhere
// the link travels — Slack, iMessage, X, LinkedIn, Discord, search
// snippets — renders from here.
//
// Restraint matters: Satori (the engine behind next/og) supports a
// thin slice of CSS, and the typical failure mode is over-design that
// either doesn't render or looks busy at preview size (~600px wide on
// desktop chat clients). Keep the layout single-axis, the type huge
// enough to read inside an unfurl card, and the palette identical to
// the site.

export const alt = "ghola — the most private AI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#08090d",
          color: "#eef1f8",
          display: "flex",
          flexDirection: "column",
          padding: "80px",
          fontFamily: "sans-serif",
          backgroundImage:
            "radial-gradient(1000px 600px at 85% 8%, rgba(61,168,255,0.12), transparent 60%), radial-gradient(700px 400px at 5% 95%, rgba(61,168,255,0.06), transparent 60%)",
        }}
      >
        {/* Wordmark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: "-0.5px",
            color: "#eef1f8",
          }}
        >
          ghola
        </div>

        {/* Hero headline — pushed to the upper-middle so the image
            balances when shown small in a Slack card. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 90,
            fontSize: 124,
            lineHeight: 1.0,
            fontWeight: 500,
            letterSpacing: "-3px",
          }}
        >
          <span style={{ display: "flex" }}>The most private</span>
          <span style={{ display: "flex", color: "#3da8ff" }}>
            AI.
          </span>
        </div>

        {/* Subtitle — the dense investor positioning line, shortened
            so it doesn't wrap to a third row at preview size. */}
        <div
          style={{
            display: "flex",
            marginTop: 60,
            fontSize: 34,
            lineHeight: 1.35,
            color: "#8b95a8",
            maxWidth: 980,
            letterSpacing: "-0.3px",
          }}
        >
          Runs on your device. Or end-to-end encrypted in the cloud.
        </div>

        {/* Bottom rail — thin credential strip in the same mono
            uppercase voice as the homepage. */}
        <div
          style={{
            display: "flex",
            marginTop: "auto",
            alignItems: "center",
            fontSize: 18,
            letterSpacing: "3px",
            textTransform: "uppercase",
            color: "#6f798c",
          }}
        >
          <span>End-to-end encrypted</span>
          <span style={{ margin: "0 18px", color: "#2a3a50" }}>·</span>
          <span>On-device option</span>
          <span style={{ margin: "0 18px", color: "#2a3a50" }}>·</span>
          <span>Verifiable receipts</span>
          <span style={{ margin: "0 18px", color: "#2a3a50" }}>·</span>
          <span>Open weights</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
