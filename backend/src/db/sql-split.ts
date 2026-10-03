/**
 * 按 `;` 切分 SQL，但不看穿注释与字面量。
 *
 * 之前 `scripts/migrate-db.ts` 只有一句 `schemaSql.split(';')`，于是 schema 里任何一处
 * 出现在注释或字符串里的分号都会把语句切成两半。`shared/src/schema.pg.sql` 的 v51 注释里
 * 正好有一个 `runMigrations();`：fresh 部署跑到 `CREATE TABLE event_trigger_logs` 时，前半截
 * 被当完整语句提交（少一个右括号，语法错），后半截从注释中间开头，根本不成句，于是整库 bootstrap
 * 失败在第 24 条。线上没暴露是因为生产是靠应用冷启动的增量迁移长大的，而 `runMigrations()`
 * 不读这个 schema 文件 —— 只有「照 README 新部署」才会踩到。
 *
 * 注释会原样留在所属语句里，失败时打印的 SQL 仍然带上下文。
 */

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  const takePlain = (end: number): void => {
    current += sql.slice(i, end);
    i = end;
  };

  while (i < sql.length) {
    const rest = sql.slice(i);

    // -- 行注释：到行尾为止，里面的分号不算语句结束
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      takePlain(nl === -1 ? sql.length : nl);
      continue;
    }

    // /* 块注释 */：同样整体跳过
    if (rest.startsWith('/*')) {
      const close = sql.indexOf('*/', i + 2);
      takePlain(close === -1 ? sql.length : close + 2);
      continue;
    }

    // '...' 字面量与 "..." 标识符：内部的分号不算语句结束，'' / "" 是转义不是闭合
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      takePlain(Math.min(j + 1, sql.length));
      continue;
    }

    // $tag$ ... $tag$（函数体），tag 可以为空即 $$
    const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      takePlain(close === -1 ? sql.length : close + tag.length);
      continue;
    }

    if (sql[i] === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += sql[i];
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** 语句去掉注释后是否还有内容 —— 只有注释的「语句」提交上去必然语法错。 */
export function isExecutableSql(statement: string): boolean {
  const withoutComments = statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return withoutComments.trim().length > 0;
}