/**
 * 本地 AI 会话持久化（v2.26 E）：对话历史存 IndexedDB，刷新/重进页面不丢。
 *
 * 为什么不用 localStorage：对话正文可能几百 KB（RAG 摘要 + sources），localStorage
 * 5MB 上限会被整页索引挤爆；IndexedDB 与向量索引同一存储层。写法是「整体快照、
 * 变化即写、上限 100 条」——对话是低频操作，不值得做 per-entry 增量。
 */

const DB_NAME = 'timemark-local-ai';
const STORE_NAME = 'chat-history';
const MAX_ENTRIES = 100;

export type PersistedChatEntry = {
  question: string;
  answer: string;
  /** 与 RagAnswer['sources'] 同形（id/title/snippet），恢复会话时不丢来源徽章 */
  sources: Array<{ id: string; title: string; snippet: string }>;
  mode: 'local-ai' | 'retrieval-only' | 'no-engine';
  at: number;
};

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function loadChatHistory(): Promise<PersistedChatEntry[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get('entries');
    req.onsuccess = () => {
      const value = req.result;
      resolve(Array.isArray(value) ? (value as PersistedChatEntry[]) : []);
    };
    req.onerror = () => resolve([]);
  });
}

export async function saveChatHistory(entries: PersistedChatEntry[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const capped = entries.slice(-MAX_ENTRIES);
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(capped, 'entries');
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearChatHistory(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('entries');
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
