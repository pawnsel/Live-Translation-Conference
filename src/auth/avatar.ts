/** Deterministic placeholder avatars.
 *
 *  There is no account database and no uploaded profile pictures yet, so a
 *  "photo" is derived from the address itself: same email in, same colour and
 *  initial out. Rendered as an inline SVG data URI so nothing has to be
 *  fetched — the mock works offline and in tests.
 */

const PALETTE = ['#DE5C8E', '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6'];

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function avatarDataUri(seed: string): string {
  const trimmed = seed.trim();
  const initial = escapeXml((trimmed[0] ?? '?').toUpperCase());

  let hash = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  }
  const bg = PALETTE[hash % PALETTE.length];

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" rx="48" fill="${bg}"/>` +
    `<text x="48" y="64" text-anchor="middle" fill="#ffffff" ` +
    `font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="44" font-weight="700">${initial}</text>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
