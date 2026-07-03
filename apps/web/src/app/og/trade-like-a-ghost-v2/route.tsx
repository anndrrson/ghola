import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 30,
            fontWeight: 700,
            color: "#eef1f8",
          }}
        >
          ghola
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 78,
            fontSize: 112,
            lineHeight: 0.98,
            fontWeight: 500,
          }}
        >
          <span style={{ display: "flex" }}>Trade like</span>
          <span style={{ display: "flex", color: "#3da8ff" }}>
            a ghost.
          </span>
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 46,
            fontSize: 28,
            lineHeight: 1.25,
            color: "#8b95a8",
            maxWidth: 1010,
          }}
        >
          Private agents for live markets. Sealed intent. Verifiable receipts.
        </div>

        <div
          style={{
            display: "flex",
            marginTop: "auto",
            alignItems: "center",
            fontSize: 16,
            letterSpacing: "2.6px",
            textTransform: "uppercase",
            color: "#6f798c",
          }}
        >
          <span>Live markets</span>
          <span style={{ margin: "0 18px", color: "#2a3a50" }}>·</span>
          <span>Sealed agents</span>
          <span style={{ margin: "0 18px", color: "#2a3a50" }}>·</span>
          <span>Private intent</span>
          <span style={{ margin: "0 18px", color: "#2a3a50" }}>·</span>
          <span>Execution receipts</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    },
  );
}
