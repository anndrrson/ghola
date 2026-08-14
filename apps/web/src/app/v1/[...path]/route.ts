import type { NextRequest } from "next/server";
import { handleV1ProxyRequest } from "./_handler";

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, context: Params) {
  return handleV1ProxyRequest(req, context);
}

export async function POST(req: NextRequest, context: Params) {
  return handleV1ProxyRequest(req, context);
}

export async function PUT(req: NextRequest, context: Params) {
  return handleV1ProxyRequest(req, context);
}

export async function PATCH(req: NextRequest, context: Params) {
  return handleV1ProxyRequest(req, context);
}

export async function DELETE(req: NextRequest, context: Params) {
  return handleV1ProxyRequest(req, context);
}
