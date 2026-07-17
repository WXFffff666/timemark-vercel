/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
export function escapeHtml(str: unknown): string {
  if (str == null) return '';
  const s = typeof str === 'string' ? str : String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
