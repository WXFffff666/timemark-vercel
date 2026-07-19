import { describe, it, expect } from 'vitest';
import { applyRelationshipMapping, COMMON_RELATIONS } from '../relationship';
import { renderTemplate, previewTemplate, getEventTypeLabel } from '../templates';
import { getBlessing } from '../blessings';

describe('Relationship Mapping', () => {
  it('should return original name when no mappings', () => {
    const result = applyRelationshipMapping('妈妈生日', []);
    expect(result).toBe('妈妈生日');
  });

  it('should apply relationship mapping by recipient type', () => {
    const mappings = [{
      id: 1,
      user_id: 1,
      event_id: 1,
      from_relation: '妈妈',
      to_relation: '母亲',
      recipient_type: 'wife',
    }];
    
    const result = applyRelationshipMapping('妈妈生日', mappings, undefined, 'wife');
    expect(result).toBe('母亲生日');
  });

  it('should apply relationship mapping by recipient email', () => {
    const mappings = [{
      id: 1,
      user_id: 1,
      event_id: 1,
      from_relation: '妈妈',
      to_relation: '母亲',
      recipient_email: 'wife@example.com',
    }];
    
    const result = applyRelationshipMapping('妈妈生日', mappings, 'wife@example.com');
    expect(result).toBe('母亲生日');
  });

  it('should apply fuzzy matching', () => {
    const mappings = [{
      id: 1,
      user_id: 1,
      event_id: 1,
      from_relation: '我妈',
      to_relation: '母亲',
    }];
    
    const result = applyRelationshipMapping('我妈生日', mappings);
    expect(result).toBe('母亲生日');
  });
});

describe('Templates', () => {
  it('should render template with variables', () => {
    const template = '{{event_name}} 还有 {{days_until}} 天';
    const data = { event_name: '妈妈生日', days_until: '3' };
    
    const result = renderTemplate(template, data);
    expect(result).toBe('妈妈生日 还有 3 天');
  });

  it('should handle missing variables', () => {
    const template = '{{event_name}} 还有 {{days_until}} 天';
    const data = { event_name: '妈妈生日' };
    
    const result = renderTemplate(template, data);
    expect(result).toBe('妈妈生日 还有  天');
  });

  it('should preview template with sample data', () => {
    const template = '{{event_name}} 还有 {{days_until}} 天';
    
    const result = previewTemplate(template);
    expect(result).toBe('妈妈生日 还有 3 天');
  });

  it('should return event type label', () => {
    expect(getEventTypeLabel('birthday')).toBe('生日');
    expect(getEventTypeLabel('exam')).toBe('考试');
    expect(getEventTypeLabel('anniversary')).toBe('纪念日');
    expect(getEventTypeLabel('holiday')).toBe('节日');
    expect(getEventTypeLabel('other')).toBe('其他');
    expect(getEventTypeLabel('unknown')).toBe('unknown');
  });
});

describe('Blessings', () => {
  it('should return blessing for event type', () => {
    const blessing = getBlessing('birthday');
    expect(blessing).toBeDefined();
    expect(typeof blessing).toBe('string');
    expect(blessing.length).toBeGreaterThan(0);
  });

  it('should return blessing for different event types', () => {
    const types = ['birthday', 'exam', 'anniversary', 'holiday', 'other'];
    
    for (const type of types) {
      const blessing = getBlessing(type);
      expect(blessing).toBeDefined();
      expect(typeof blessing).toBe('string');
    }
  });
});
