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
 * Is this a plausible post time? TikTok ids encode it; a malformed id decodes
 * to nonsense. The upper bound used to be the literal year 2027, which would
 * have emptied every video ranking on 2028-01-01. It is "not in the future"
 * now, with a day of slack for clock skew.
 */
export function plausiblePostDate(date: Date, now: number = Date.now()): boolean {
  const t = date.getTime();
  return Number.isFinite(t) && date.getFullYear() >= 2020 && t <= now + 86_400_000;
}
