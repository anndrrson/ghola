import { routeModelChatCompletions } from "@/lib/model-router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return routeModelChatCompletions(req, process.env);
}
