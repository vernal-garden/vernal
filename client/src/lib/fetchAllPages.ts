// Walks a paginated list endpoint from offset 0 and returns every row.
// Stops at `total` rows, on an empty page, or after maxPages (a runaway guard).
export async function fetchAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ data: T[]; total: number | string }>,
  pageSize: number,
  maxPages = 20,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(rows.length, pageSize);
    const data = res?.data ?? [];
    if (data.length === 0) break;
    rows.push(...data);
    if (rows.length >= Number(res.total)) break;
  }
  return rows;
}
