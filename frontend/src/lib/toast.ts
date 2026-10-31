/**
 * v2.40 R18 清零了原生 confirm；本文件清零原生 alert——轻量 toast 通知
 * （Sonner 模式：模块级 store + 全局函数 + App 根部挂一个 <ToastHost/>）。
 *
 * 零依赖：不引第三方库。错误 5s、成功/信息 3.5s 自动消失；同屏最多 4 条，
 * 超出立即挤掉最旧的。Host 组件见 components/ui/toast-host.tsx。
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

type Listener = (items: ToastItem[]) => void;

const MAX_VISIBLE = 4;
const DURATION_MS: Record<ToastKind, number> = { success: 3500, info: 3500, error: 5000 };

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  const snapshot = [...items];
  for (const l of listeners) l(snapshot);
}

function push(kind: ToastKind, text: string) {
  const trimmed = typeof text === 'string' ? text.trim() : String(text ?? '');
  if (!trimmed) return;
  const item: ToastItem = { id: ++seq, kind, text: trimmed };
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  setTimeout(() => dismiss(item.id), DURATION_MS[kind]);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (text: string) => push('success', text),
  error: (text: string) => push('error', text),
  info: (text: string) => push('info', text),
  dismiss,
};

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener([...items]);
  return () => listeners.delete(listener);
}

/** 测试专用：清空模块级状态（toast store 是单例，测试间会互相污染） */
export function __resetToastsForTests() {
  items = [];
  emit();
}
