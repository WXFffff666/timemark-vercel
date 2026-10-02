export function createTestEvent(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    user_id: 1,
    name: '测试事件',
    type: 'birthday',
    date: '2026-06-01',
    calendar_type: 'gregorian',
    notification_channels: '[]',
    notification_account_ids: '[]',
    reminder_time: '09:00',
    reminder_days_before: '[1, 3, 7]',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createTestUser(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    username: 'testuser',
    password_hash: '$2a$10$fakehash',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createMockQueryResult(rows: any[] = []) {
  return { rows, rowCount: rows.length };
}

/** Parsed from the `migrations` array literal only. Anchored to the array's 6-space
 *  `version:` line so the `Register as: { version: N, ... }` doc comments that b7c9122
 *  folded in from backend/src/db/pending/*.sql are never matched. */
export function registeredMigrationVersions(source: string): number[] {
  const start = source.indexOf('const migrations:');
  if (start < 0) throw new Error('migrations array literal not found in migrate.ts');
  const end = source.indexOf('\n  ];', start);
  if (end < 0) throw new Error('migrations array literal is unterminated in migrate.ts');
  return [...source.slice(start, end).matchAll(/^ {6}version: (\d+),$/gm)].map((m) => Number(m[1]));
}

/** Newline-agnostic SQL extraction for one named migration. Replaces the six copies of
 *  the old `migrationSql()` helper and the CRLF-only indexOf in migration-v59-v71. */
export function migrationSqlFor(source: string, name: string): string {
  const nameIndex = source.indexOf(`name: '${name}'`);
  if (nameIndex < 0) throw new Error(`migration ${name} not found in migrate.ts`);
  const open = 'sql: `';
  const sqlStart = source.indexOf(open, nameIndex);
  if (sqlStart < 0) throw new Error(`migration ${name} has no sql template in migrate.ts`);
  const bodyStart = sqlStart + open.length;
  // The folded pending SQL quotes identifiers with escaped backticks, so the template only
  // ends at the first backtick that is not itself escaped.
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === '`') return source.slice(bodyStart, i);
  }
  throw new Error(`migration ${name} sql template is unterminated in migrate.ts`);
}
