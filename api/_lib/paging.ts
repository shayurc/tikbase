/**
 * Read every row of a PostgREST query, a page at a time.
 *
 * PostgREST caps a response at 1000 rows whatever `.limit()` asks for, and it
 * does so silently: no error, no flag, just the first thousand. CLAUDE.md
 * records two data bugs from this and predicts a third. api/top-videos.ts was
 * the third — each 150-product batch asked for 5000 videos, got the 1000
 * most-viewed of all time, and filtered to the window AFTERWARDS, so a recent
 * video was dropped whenever older ones filled the page.
 *
 * `fetchPage(from, to)` must apply a total order (a unique tiebreaker after
 * the sort column), or rows that tie can repeat or vanish between pages.
 *
 * A failed page throws. Returning the rows read so far would publish a partial
 * ranking as if it were the whole one.
 */
export const POSTGREST_PAGE = 1000;

export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { pageSize?: number; maxRows?: number; what?: string } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? POSTGREST_PAGE;
  const maxRows = opts.maxRows ?? 2_000_000;
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) {
      throw new Error(`${opts.what ?? 'paged read'} failed at row ${from}: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/**
 * The same job by keyset: "the next page after this key", ordered by a unique
 * column. Offset paging makes the database sort and skip everything before the
 * page on every request, so reading a 650k-row table that way costs the whole
 * table again per page. A keyset page is one index range scan however deep it
 * is, which is what makes reading every row affordable.
 *
 * `fetchAfter(null)` is the first page. `keyOf` must be the column the query
 * orders by.
 */
export async function forEachKeyPage<T>(
  fetchAfter: (lastKey: string | null, pageSize: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  keyOf: (row: T) => string,
  onPage: (rows: T[]) => void,
  opts: { pageSize?: number; maxRows?: number; what?: string } = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? POSTGREST_PAGE;
  const maxRows = opts.maxRows ?? 5_000_000;
  let seen = 0;
  let last: string | null = null;
  while (seen < maxRows) {
    const { data, error } = await fetchAfter(last, pageSize);
    if (error) {
      throw new Error(`${opts.what ?? 'keyset read'} failed after ${seen} rows: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    onPage(data);
    seen += data.length;
    const next = keyOf(data[data.length - 1]);
    // A key that does not advance would loop forever on the same page.
    if (next === last) throw new Error(`${opts.what ?? 'keyset read'}: key did not advance past ${last}`);
    last = next;
    if (data.length < pageSize) break;
  }
  return seen;
}

/** forEachKeyPage, collected. Use the callback form when the rows are many. */
export async function readAllByKey<T>(
  fetchAfter: (lastKey: string | null, pageSize: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  keyOf: (row: T) => string,
  opts: { pageSize?: number; maxRows?: number; what?: string } = {},
): Promise<T[]> {
  const rows: T[] = [];
  await forEachKeyPage(fetchAfter, keyOf, (page) => { rows.push(...page); }, opts);
  return rows;
}

/**
 * Is this a plausible post time? TikTok ids encode it; a malformed id decodes
 * to nonsense. The upper bound used to be the literal year 2027, which would
 * have emptied every video ranking on 2028-01-01. It is "not in the future"
 * now, with a day of slack for clock skew.
 */
export function plausiblePostDate(date: Date, now: number = Date.now()): boolean {
  const t = date.getTime();
  return Number.isFinite(t) && date.getFullYear() >= 2020 && t <= now + 86_400_000;
}
