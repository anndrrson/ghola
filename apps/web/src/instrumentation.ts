export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureMarketDataWarmer } = await import("./lib/market-data-warmer");
  await ensureMarketDataWarmer();
}
