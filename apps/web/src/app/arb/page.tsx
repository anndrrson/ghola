import type { Metadata } from "next";
import { TriVenueArbConsole } from "@/components/arb/TriVenueArbConsole";

export const dynamic = "force-dynamic";

const TITLE = "Trade like a ghost — ghola";
const DESCRIPTION =
  "Live cross-venue market agents with private intent, sealed execution, and verifiable receipts.";
const PREVIEW_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "ghola — trade like a ghost",
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://ghola.xyz/arb",
    siteName: "ghola",
    type: "website",
    images: [PREVIEW_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [PREVIEW_IMAGE],
  },
};

export default function ArbPage() {
  return <TriVenueArbConsole />;
}
