/** Strip dangerous HTML for preview rendering (not a full HTML mail sanitizer). */
export function sanitizeHtmlPreview(html: string): string {
  if (!html) return '';
  const out = html
    // 注意：本文件不用 \b 词边界（历史上被工具链转成退格符），用 (?=[\s/>]|$) 表达。
    .replace(/<script(?=[\s/>])[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style(?=[\s/>])[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe(?=[\s/>])[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object(?=[\s/>])[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed[^>]*\/?>/gi, '')
    .replace(/<link[^>]*\/?>/gi, '')
    .replace(/<meta[^>]*\/?>/gi, '')
    .replace(/<base[^>]*\/?>/gi, '')
    .replace(/<form(?=[\s/>])[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '')
    .replace(/<svg(?=[\s/>])[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    // v2.31 R3 (audit S2): the old event-attribute regex required whitespace before the
    // attribute name, so `<img src=x/onerror=...>` (slash-separated) slipped through.
    // Separator now accepts whitespace OR a slash; event attributes are stripped regardless
    // of their value.
    .replace(/[\s/]+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // javascript:/data: schemes tolerate whitespace and numeric entity padding (the browser
    // decodes entities inside attribute values before scheme resolution). Detection runs on a
    // decoded COPY; on a hit the whole value is replaced with "#". Numeric entity padding is
    // caught; double-encoded forms are intentionally over-blocked (fail-closed).
    .replace(/((?:href|src|xlink:href)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]*)/gi,
      (match: string, attr: string, value: string) => {
        const decoded = value
          .replace(/&#(x?)([0-9a-f]+);?/gi, (_e: string, x: string, digits: string) => {
            const code = parseInt(digits, x ? 16 : 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
          })
          .replace(/[\s>'"]+/g, '')
          .toLowerCase();
        if (decoded.includes('javascript:') || decoded.includes('data:') || decoded.includes('vbscript:')) {
          return attr + '"#"';
        }
        return match;
      });
  return out;
}
