import { json, privateAccountProducts } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(privateAccountProducts());
}
