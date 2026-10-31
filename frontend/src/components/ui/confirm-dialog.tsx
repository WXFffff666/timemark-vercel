import { ReactNode, useCallback, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * v2.40 R18：统一确认弹窗——替代原生 confirm()。
 *
 * 原生弹窗的问题：无法样式化（暗色/移动端割裂）、字体小、iOS 上标题是域名。
 * 本组件与全站 glass-panel 设计语言一致；danger 变体红色主按钮；
 * requireText 模式（如输入 RESTORE）用于不可逆危险操作。
 *
 * useConfirm() 返回 Promise 化的 confirm()：调用点与原生几乎同形——
 * `if (!confirm('…')) return;` → `if (!(await confirm({ title: '…', tone: 'danger' }))) return;`
 */

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger = 红色主按钮（删除/清空/恢复类）；默认主色 */
  tone?: 'danger' | 'default';
  /** 要求用户输入该文本才能点确认（不可逆操作双保险） */
  requireText?: string;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/** 弹窗本体（hooks 必须无条件调用，故拆出独立组件） */
function ConfirmDialogBody({ state, onDone }: { state: ConfirmState; onDone: (ok: boolean) => void }) {
  const [text, setText] = useState('');
  const danger = state.tone === 'danger';
  const gated = state.requireText ? text.trim() === state.requireText : true;

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base font-bold">
          {danger && <AlertTriangle size={18} className="text-red-500 shrink-0" aria-hidden />}
          {state.title}
        </DialogTitle>
      </DialogHeader>
      {state.description && (
        <p className="text-sm text-slate-600 dark:text-slate-300">{state.description}</p>
      )}
      {state.requireText && (
        <div>
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5" htmlFor="confirm-dialog-gate">
            输入 <span className="font-mono font-bold text-red-500">{state.requireText}</span> 以确认
          </label>
          <input
            id="confirm-dialog-gate"
            data-testid="confirm-dialog-gate"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            className="h-10 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 text-sm font-mono"
          />
        </div>
      )}
      {/* dialog.tsx 无 DialogFooter 导出——按钮行用普通容器（v2.40 R18） */}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" className="rounded-full min-h-11" onClick={() => onDone(false)}>
          {state.cancelLabel ?? '取消'}
        </Button>
        <Button
          type="button"
          variant={danger ? 'destructive' : 'vision'}
          className="rounded-full min-h-11"
          disabled={!gated}
          data-testid="confirm-dialog-confirm"
          onClick={() => onDone(true)}
        >
          {state.confirmLabel ?? '确认'}
        </Button>
      </div>
    </DialogContent>
  );
}

export function ConfirmDialog({ state, onDone }: { state: ConfirmState | null; onDone: (ok: boolean) => void }) {
  if (!state) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(false); }}>
      <ConfirmDialogBody state={state} onDone={onDone} />
    </Dialog>
  );
}

/**
 * 页面用法：
 *   const { confirm, confirmDialog } = useConfirm();
 *   if (!(await confirm({ title: '删除？', tone: 'danger' }))) return;
 *   ...jsx 尾部 {confirmDialog}
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const stateRef = useRef<ConfirmState | null>(null);
  stateRef.current = state;

  const onDone = useCallback((ok: boolean) => {
    stateRef.current?.resolve(ok);
    setState(null);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve });
    });
  }, []);

  const confirmDialog: ReactNode = <ConfirmDialog state={state} onDone={onDone} />;
  return { confirm, confirmDialog };
}
