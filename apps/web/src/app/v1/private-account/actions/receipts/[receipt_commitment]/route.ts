import {
  json,
  privateAccountOwnerFromRequest,
  receiptDetailForOwner,
  unauthorized,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ receipt_commitment: string }> },
) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const params = await context.params;
  const detail = await receiptDetailForOwner(
    { receipt_commitment: params.receipt_commitment },
    owner,
  );
  if (!detail) return json({ error: "receipt_not_found" }, 404);
  return json(detail);
}
