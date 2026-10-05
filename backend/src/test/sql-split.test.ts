import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements, isExecutableSql } from '../db/sql-split.js';

/**
 * schema.pg.sql 的切分。
 *
 * 这不是洁癖：`scripts/migrate-db.ts` 原来只有 `schemaSql.split(';')`，而 schema 里
 * v51 那段注释含有 `runMigrations();`。于是一条 `CREATE TABLE event_trigger_logs` 被切成
 * 「少一个右括号的前半截」+「从注释中间开头的后半截」，fresh 部署必然在第 24 条语句上
 * `syntax error at end of input`。线上没暴露只是因为生产靠增量迁移长大，
 * 而 `runMigrations()` 根本不读这个文件 —— 照 README 新部署才会踩到。
 *
 * 所以这里直接拿真实的 schema 文件当断言对象，而不是只测人造样本。
 */

const SCHEMA = readFileSync(join(__dirname, '../../../shared/src/schema.pg.sql'), 'utf-8');

/** 去掉注释，只留可执行文本 —— 计数与「是否可执行」都以此为准。 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('splitSqlStatements', () => {
  it('注释里的分号不切分语句', () => {
    const sql = `-- 说明：调用 runMigrations(); 之后再看
CREATE TABLE t (id INT);
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE t (id INT)');
  });

  it('字符串字面量里的分号不切分语句', () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'a;b'");
  });

  it("'' 是转义的单引号，不算闭合", () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('it''s; fine');`);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("'it''s; fine'");
  });

  it('块注释里的分号不切分语句', () => {
    const statements = splitSqlStatements(`/* a; b; c; */ SELECT 1;`);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('SELECT 1');
  });

  it('美元引号函数体里的分号不切分语句', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;
SELECT 2;`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('RETURN 1; END;');
    expect(statements[1]).toBe('SELECT 2');
  });

  it('注释保留在所属语句里，失败时打印的 SQL 仍带上下文', () => {
    const statements = splitSqlStatements(`-- ctx\nSELECT 1;`);
    expect(statements[0]).toContain('-- ctx');
  });

  it('忽略空语句与多余空白', () => {
    expect(splitSqlStatements('  ;\n;\n SELECT 1 ;\n\n')).toEqual(['SELECT 1']);
  });

  describe('真实的 shared/src/schema.pg.sql', () => {
    const statements = splitSqlStatements(SCHEMA);

    it('每条语句都含可执行内容，没有「只有注释」的碎片', () => {
      // 旧实现切出的第 25 块正是从注释中间开头的残片
      const junk = statements.filter((s) => !isExecutableSql(s));
      expect(junk).toEqual([]);
    });

    it('event_trigger_logs 保持为一条完整语句', () => {
      const ddl = statements.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS event_trigger_logs'));
      expect(ddl).toHaveLength(1);
      // 列定义没有从句尾注释里断开，右括号闭合
      expect(ddl[0]).toContain('trigger_date TEXT NOT NULL');
      expect(ddl[0]).toContain('created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
      expect(ddl[0].trimEnd().endsWith(')')).toBe(true);
    });

    it('每条语句的括号都配平（切分点落在语句边界）', () => {
      const unbalanced = statements
        .map((statement, index) => {
          const code = stripComments(statement);
          return { index, opens: (code.match(/\(/g) || []).length, closes: (code.match(/\)/g) || []).length };
        })
        .filter((r) => r.opens !== r.closes);
      expect(unbalanced).toEqual([]);
    });

    it('不丢内容：拼回去与原文件去掉注释和分号后一致', () => {
      // 语句数应当**少于**朴素的 split(';')：注释/字面量里的分号不再切分。
      // schema.pg.sql 里有 12 行注释含分号，所以正好少 12 条（v80 新增注释含分号两行）。
      const naiveCount = SCHEMA.split(';').filter((s) => s.trim()).length;
      expect(naiveCount - statements.length).toBe(12);

      // 真正的「不丢内容」判据：去掉注释、分号、空白后，两者必须逐字相同。
      // 用 ';\n' 而不是 ';' 拼：schema 里有贴着分号的行尾注释（`...pgcrypto; -- ====`），
      // 不补换行的话注释会被粘到上一行末尾，按行剥离注释就认不出来了。
      const normalize = (text: string) =>
        stripComments(text).replace(/;/g, '').replace(/\s+/g, ' ').trim();
      expect(normalize(statements.join(';\n'))).toBe(normalize(SCHEMA));
    });
  });
});