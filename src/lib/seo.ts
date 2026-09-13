// Title and description construction for <title> and <meta name="description">.
//
// The root layout sets a title template of "%s | Frontier Capital Signals".
// That suffix costs 27 characters, and intelligence-post headlines are
// generated from source reporting rather than written to a length, so they run
// up to 67 characters on their own. Together they produced rendered titles of
// up to 94 characters, well past the ~65 Google renders before truncating —
// and since the brand sits at the end, the brand was the first thing cut.
//
// Post pages therefore opt out of the template via `title.absolute` and use
// seoTitle(), which appends the brand only when it actually fits.

export const TITLE_MAX = 65;
export const DESCRIPTION_MAX = 170;
export const BRAND = "Frontier Capital Signals";

/** Trim to at most `max` characters, breaking on a word boundary and marking the cut. */
function truncateOnWord(text: string, max: number): string {
  // One character of the budget is spent on the ellipsis itself.
  const clipped = text.slice(0, max - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  // A run of >max characters with no space in it has no word boundary to break
  // on, so fall back to the hard character cut.
  const body = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * Build a <title> that stays inside the SERP budget.
 *
 * Appends " | BRAND" when there is room, drops the suffix when there is not,
 * and truncates the headline itself only as a last resort.
 */
export function seoTitle(headline: string, brand: string = BRAND, max: number = TITLE_MAX): string {
  const clean = headline.replace(/\s+/g, " ").trim();
  if (!clean) return brand;

  const suffixed = `${clean} | ${brand}`;
  if (suffixed.length <= max) return suffixed;
  if (clean.length <= max) return clean;
  return truncateOnWord(clean, max);
}

/**
 * Clamp a description to the length Google will render.
 *
 * Post summaries come from the same generation step as the headlines and are
 * not written to a length either; anything past DESCRIPTION_MAX is dropped from
 * the snippet, so cut it on a word boundary rather than letting Google cut it
 * mid-word.
 */
export function seoDescription(text: string, max: number = DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : truncateOnWord(clean, max);
}
