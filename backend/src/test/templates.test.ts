import { describe, it, expect } from 'vitest';
import { renderTemplate, PRESET_TEMPLATES, EVENT_TYPE_TEMPLATES } from '@timemark/shared/templates';

describe('Templates', () => {
  it('renders variables', () => {
    const r = renderTemplate('{{event_name}} in {{days_until}} days', { event_name: 'Birthday', days_until: '3' });
    expect(r).toBe('Birthday in 3 days');
  });

  it('all event types have templates', () => {
    const types = ['birthday', 'exam', 'anniversary', 'holiday', 'meeting', 'deadline', 'travel', 'graduation', 'wedding', 'medical'];
    for (const t of types) {
      expect(EVENT_TYPE_TEMPLATES[t]).toBeDefined();
      expect(EVENT_TYPE_TEMPLATES[t].length).toBeGreaterThan(0);
    }
  });

  it('preset templates array is not empty', () => {
    expect(PRESET_TEMPLATES.length).toBeGreaterThan(10);
  });
});
