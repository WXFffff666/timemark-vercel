/**
 * 极简 IndexedDB KV（模仿知屋 Dexie 的 noteEmbeddings 表，但不引入依赖）。
 * 只需要 put/get/getAll/delete 四个操作；所有回调都把错误转成 rejection。
 */

const DB_NAME = 'timemark-local-ai';
const DB_VERSION = 1;
const STORE = 'kb-vectors';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
    });
  } finally {
    db.close();
  }
}

export type KbVectorRow = {
  id: string;
  contentHash: string;
  vector: number[];
  updatedAt: string;
};

export async function getVectorRow(id: string): Promise<KbVectorRow | undefined> {
  return withStore<KbVectorRow | undefined>('readonly', (s) => s.get(id) as IDBRequest<KbVectorRow | undefined>);
}

export async function getAllVectorRows(): Promise<KbVectorRow[]> {
  return withStore<KbVectorRow[]>('readonly', (s) => s.getAll() as IDBRequest<KbVectorRow[]>);
}

export async function putVectorRow(row: KbVectorRow): Promise<void> {
  await withStore('readwrite', (s) => s.put(row));
}

export async function clearVectorRows(): Promise<void> {
  await withStore('readwrite', (s) => s.clear());
}

/** 稳定的内容哈希（djb2 变体；只用于"内容变没变"的比对，不做安全用途） */
export function hashText(...parts: string[]): string {
  const text = parts.join('\u0000');
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}
