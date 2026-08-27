const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGES_PER_SCAN = 10_000;

export async function listAllCarryPositionRecords({
  state,
  owner_commitment: ownerCommitment,
  status,
  page_size: pageSize = DEFAULT_PAGE_SIZE,
}) {
  const limit = boundedInteger(pageSize, 1, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const records = [];
  const seen = new Set();
  let beforeUpdatedAt = null;
  let beforePositionId = null;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SCAN; pageNumber += 1) {
    const page = await state.listCarryPositionRecords({
      owner_commitment: ownerCommitment,
      status,
      limit,
      ...(beforeUpdatedAt && beforePositionId ? {
        before_updated_at: beforeUpdatedAt,
        before_position_id: beforePositionId,
      } : {}),
    });
    if (!Array.isArray(page)) throw new Error("carry_record_scan_page_invalid");
    for (const record of page) {
      const positionId = String(record?.position?.position_id || "");
      if (!positionId || seen.has(positionId)) continue;
      seen.add(positionId);
      records.push(record);
    }
    if (page.length < limit) return records;
    const tail = page.at(-1);
    const nextUpdatedAt = String(tail?.updated_at || "");
    const nextPositionId = String(tail?.position?.position_id || "");
    if (!nextUpdatedAt || !nextPositionId
      || (nextUpdatedAt === beforeUpdatedAt && nextPositionId === beforePositionId)) {
      throw new Error("carry_record_scan_cursor_invalid");
    }
    beforeUpdatedAt = nextUpdatedAt;
    beforePositionId = nextPositionId;
  }
  throw new Error("carry_record_scan_page_limit_exceeded");
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
