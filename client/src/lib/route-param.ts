/**
 * Decoding a route parameter that the router has already half-decoded.
 *
 * Links are built with encodeURIComponent. wouter then runs decodeURI over the
 * path before matching (src/paths.js `unescape`), which turns %25 back into a
 * bare % and %20 into a space but leaves reserved characters (%3A, %2F, %26)
 * encoded. The pages called decodeURIComponent on that, which throws on a bare
 * %:
 *
 *   shop "100% Pure"  ->  link  name%3A100%25%20Pure
 *                         wouter name%3A100% Pure
 *                         decodeURIComponent -> URIError: URI malformed
 *
 * With no error boundary, clicking that shop blanked the whole app.
 *
 * So: decode the runs that are still well-formed escapes and leave everything
 * else exactly as it is. This never throws. (A name containing a literal
 * escape such as "%41" would still be read as "A" — the router has already
 * erased the difference by the time the page sees it.)
 */
export function decodeRouteParam(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
