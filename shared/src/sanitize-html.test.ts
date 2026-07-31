import { describe, it, expect } from 'vitest';
import { sanitizeHtmlPreview } from './sanitize-html.js';

describe('sanitizeHtmlPreview', () => {
  it('removes script tags', () => {
    expect(sanitizeHtmlPreview('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('removes event handlers and javascript: urls', () => {
    expect(sanitizeHtmlPreview('<img src=x onerror=alert(1)>')).not.toContain('onerror');
    expect(sanitizeHtmlPreview('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('removes svg and iframe', () => {
    expect(sanitizeHtmlPreview('<svg onload=alert(1)></svg><iframe src=x></iframe>')).toBe('');
  });
});
