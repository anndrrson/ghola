import { createLiveTradingStatusGet } from "./_handler";

export const dynamic = "force-dynamic";

export async function GET() {
  return createLiveTradingStatusGet({ fetchImpl: globalThis.fetch })();
}
