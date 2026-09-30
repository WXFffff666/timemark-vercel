import { useState } from 'react';
import { AlertTriangle, ChevronDown, Info, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { DataHealthFinding, DataHealthKind } from './types';

function formatExample(example: Record<string, unknown>): string {
  return Object.entries(example)
    .map(([key, value]) => `${key}=${value == null ? '∅' : String(value)}`)
    .join(' · ');
}

export interface FindingCardProps {
  finding: DataHealthFinding;
  repairing: boolean;
  onRepair: (kind: DataHealthKind, confirm: boolean) => Promise<unknown>;
}

/** One detector result: count, examples, and its one-click repair action. */
export function FindingCard({ finding, repairing, onRepair }: FindingCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const clean = finding.count === 0;

  const runRepair = async (confirm: boolean) => {
    await onRepair(finding.kind, confirm).catch(() => undefined);
    setConfirmOpen(false);
  };

  return (
    <Card className="rounded-3xl p-5">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
            clean
              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
              : finding.severity === 'warning'
                ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
                : 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
          }`}
          aria-hidden
        >
          {clean ? <Info size={18} /> : <AlertTriangle size={18} />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-slate-900 dark:text-white">{finding.title}</h3>
            <Badge variant={clean ? 'success' : finding.severity === 'warning' ? 'destructive' : 'secondary'} className="text-[10px]">
              {clean ? '正常' : `${finding.count} 处`}
            </Badge>
            {finding.repair.destructive && !clean && (
              <Badge variant="outline" className="text-[10px]">需确认</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-hint">{finding.description}</p>

          {!clean && finding.examples.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 dark:text-primary-400"
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronDown size={14} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden />
                示例（{finding.examples.length}）
              </button>
              {expanded && (
                <ul className="mt-1 space-y-1">
                  {finding.examples.map((example, index) => (
                    <li key={index} className="truncate rounded-lg bg-slate-100/70 px-2 py-1 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                      {formatExample(example)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!clean && (
            <div className="mt-3">
              <Button
                variant={finding.repair.destructive ? 'outline' : 'default'}
                size="sm"
                className="rounded-full"
                disabled={repairing}
                onClick={() => (finding.repair.destructive ? setConfirmOpen(true) : void runRepair(false))}
              >
                <Wrench size={14} aria-hidden /> {repairing ? '修复中…' : finding.repair.label}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认修复：{finding.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600 dark:text-slate-300">{finding.repair.hint}</p>
          <p className="text-sm text-destructive">该操作会删除数据，且无法自动撤销。</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="rounded-full" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" className="rounded-full" disabled={repairing} onClick={() => void runRepair(true)}>
              {repairing ? '修复中…' : '确认修复'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
