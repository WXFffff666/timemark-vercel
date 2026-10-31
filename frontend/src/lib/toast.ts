/**
 * v2.40 R18 清零了原生 confirm；本文件清零原生 alert——轻量 toast 通知
 * （Sonner 模式：模块级 store + 全局函数 + App 根部挂一个 <ToastHost/>）。
 *
 * 零依赖：不引第三方库。错误 5s、成功/信息 3.5s 自动消失；同屏最多 4 条，
 * 超出立即挤掉最旧的。Host 组件见 components/ui/toast-host.tsx。
 */

export type ToastKind = 'success' | 'error' | 'info';

/** v2.42 R23：toast 可携带单个操作按钮（撤销删除等） */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

type Listener = (items: ToastItem[]) => void;

const MAX_VISIBLE = 4;
const DURATION_MS: Record<ToastKind, number> = { success: 3500, info: 3500, error: 5000 };
/** 带 action 的 toast 停留更久（用户需要看到并点击撤销） */
const ACTION_DURATION_MS = 8000;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  const snapshot = [...items];
  for (const l of listeners) l(snapshot);
}

function push(kind: ToastKind, text: string, action?: ToastAction) {
  const trimmed = typeof text === 'string' ? text.trim() : String(text ?? '');
  if (!trimmed) return;
  const item: ToastItem = { id: ++seq, kind, text: trimmed, ...(action ? { action } : {}) };
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  setTimeout(() => dismiss(item.id), action ? ACTION_DURATION_MS : DURATION_MS[kind]);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (text: string, action?: ToastAction) => push('success', text, action),
  error: (text: string, action?: ToastAction) => push('error', text, action),
  info: (text: string, action?: ToastAction) => push('info', text, action),
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
