/**
 * 本地知识库（KB）：用户自己的 事件 + 文档 + 联系人。
 * 文档构建 → IndexedDB 增量向量化（内容哈希未变即跳过）→ 余弦检索。
 * 检索失败/未建索引时降级关键词匹配，永不抛错到 UI 层。
 */
import { api } from '@/lib/api';
import { getAllVectorRows, getVectorRow, putVectorRow, hashText } from './idb';
import {
  EMBEDDING_MIN_SCORE,
  embedTextLocal,
  sliceForEmbedding,
  vectorCosine,
  type AiStatusCallback,
} from './embeddings';

export type KbDoc = {
  id: string;
  kind: 'event' | 'document';
  title: string;
  /** 给向量模型的正文（标题 + 关键字段拼接） */
  text: string;
};

/** KB 规模护栏：个人数据规模足够，同时防 IndexedDB 失控 */
export const KB_MAX_DOCS = 600;

/** 事件 → KB 文档文本 */
export function eventDocText(e: {
  name?: unknown;
  type?: unknown;
  date?: unknown;
  personName?: unknown;
  reminderConfig?: { customMessage?: unknown } | null;
}): string {
  const custom = typeof e.reminderConfig?.customMessage === 'string' ? e.reminderConfig.customMessage : '';
  return [
    `事件：${String(e.name ?? '')}`,
    `类型：${String(e.type ?? '')}`,
    `日期：${String(e.date ?? '')}`,
    e.personName ? `相关人：${String(e.personName)}` : '',
    custom ? `备注：${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 文档（证件/保修等）→ KB 文档文本 */
export function documentDocText(d: {
  title?: unknown;
  kind?: unknown;
  notes?: unknown;
  expiry_date?: unknown;
  owner_name?: unknown;
}): string {
  return [
    `文档：${String(d.title ?? '')}`,
    d.kind ? `类别：${String(d.kind)}` : '',
    d.owner_name ? `归属：${String(d.owner_name)}` : '',
    d.expiry_date ? `到期：${String(d.expiry_date)}` : '',
    d.notes ? `备注：${String(d.notes)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 拉取并构建 KB 文档（事件 + 文档；失败的字段静默跳过） */
export async function collectKbDocs(): Promise<KbDoc[]> {
  const docs: KbDoc[] = [];
  try {
    const events = asArray<Record<string, unknown>>(await api.get('/events'));
    for (const e of events) {
      const name = String(e?.name ?? '');
      if (!name) continue;
      docs.push({
        id: `event:${e.id}`,
        kind: 'event',
        title: name,
        text: eventDocText(e as Parameters<typeof eventDocText>[0]),
      });
    }
  } catch {
    /* 事件拉取失败不阻断文档部分 */
  }
  try {
    const docsRes = await api.get<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>('/documents');
    const items = Array.isArray(docsRes) ? docsRes : asArray<Record<string, unknown>>(docsRes?.items);
    for (const d of items) {
      const title = String(d?.title ?? '');
      if (!title) continue;
      docs.push({
        id: `document:${d.id}`,
        kind: 'document',
        title,
        text: documentDocText(d as Parameters<typeof documentDocText>[0]),
      });
    }
  } catch {
    /* 文档拉取失败不阻断事件部分 */
  }
  return docs.slice(0, KB_MAX_DOCS);
}

/** 关键词匹配得分：查询词在标题/正文中的命中（降级路径；纯函数便于单测） */
export function keywordScore(query: string, doc: KbDoc): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return 0;
  const title = doc.title.toLowerCase();
  const text = doc.text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 2;
    else if (text.includes(term)) score += 1;
  }
  return score / terms.length;
}

export type KbHit = { doc: KbDoc; score: number };

/** 增量构建 KB 向量索引：哈希未变跳过；返回 {built, skipped, total, failed} */
export async function buildKbIndex(
  onStatus?: AiStatusCallback,
): Promise<{ built: number; skipped: number; total: number; failed: number }> {
  const docs = await collectKbDocs();
  let built = 0;
  let skipped = 0;
  let failed = 0;
  const total = docs.length;
  if (total === 0) {
    onStatus?.('知识库为空（没有事件/文档可索引）', 0);
    return { built: 0, skipped: 0, total: 0, failed: 0 };
  }
  for (let i = 0; i < total; i++) {
    const doc = docs[i]!;
    try {
      const hash = hashText(doc.title, doc.text);
      const existing = await getVectorRow(doc.id);
      if (existing?.contentHash === hash) {
        skipped++;
        continue;
      }
      const vector = await embedTextLocal(sliceForEmbedding(doc.text), (msg, p) =>
        onStatus?.(`[向量] ${msg}`, p),
      );
      await putVectorRow({ id: doc.id, contentHash: hash, vector, updatedAt: new Date().toISOString() });
      built++;
    } catch (err) {
      failed++;
      onStatus?.(
        `「${doc.title}」向量生成失败：${err instanceof Error ? err.message : '未知错误'}`,
        Math.round(((i + 1) / total) * 100),
      );
    }
    onStatus?.(`已索引 ${i + 1 - failed}/${total}`, Math.round(((i + 1) / total) * 100));
  }
  onStatus?.(`索引完成：新建 ${built}，跳过 ${skipped}，失败 ${failed}，共 ${total}`, 100);
  return { built, skipped, total, failed };
}

/** 余弦检索：查询向量对全部索引行打分，映射回文档 */
export function rankDocsByVectors(
  queryVector: number[],
  rows: { id: string; vector: number[] }[],
  docs: KbDoc[],
  limit = 6,
  minScore = EMBEDDING_MIN_SCORE,
): KbHit[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows
    .map((r) => ({ doc: byId.get(r.id), score: vectorCosine(queryVector, r.vector) }))
    .filter((x): x is KbHit => x.doc !== undefined)
    .filter((x) => x.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 混合检索：有向量索引 → 余弦检索；否则 → 关键词匹配。
 * 文档拉取失败时返回 []（UI 显示"知识库不可用"）。
 */
export async function searchKb(query: string, limit = 6): Promise<{ hits: KbHit[]; mode: 'vector' | 'keyword' }> {
  const docs = await collectKbDocs();
  if (docs.length === 0) return { hits: [], mode: 'keyword' };
  try {
    const rows = await getAllVectorRows();
    if (rows.length > 0) {
      const qv = await embedTextLocal(sliceForEmbedding(query));
      const hits = rankDocsByVectors(qv, rows, docs, limit);
      if (hits.length > 0) return { hits, mode: 'vector' };
      // 向量无命中（阈值过滤后为空）→ 关键词兜底
    }
  } catch {
    /* 向量路径失败 → 关键词兜底 */
  }
  const hits = docs
    .map((doc) => ({ doc, score: keywordScore(query, doc) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { hits, mode: 'keyword' };
}
