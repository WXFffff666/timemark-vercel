import { useEffect, useMemo, useState } from 'react';
import { Archive, CheckCheck, Loader2, Tag as TagIcon, Trash2, Shuffle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { api, listTags, type TagRecord, type TagEntityType } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Task 139 frontend contract; mirrors the backend service allowlists. */
export type BulkAction = 'delete' | 'tag' | 'archive' | 'complete' | 'change-type';

export type BulkEntityType = TagEntityType;

export interface BulkItemResult {
  entityType: BulkEntityType;
  id: number;
  ok: boolean;
  code: string;
  message?: string;
}

export interface BulkOutcome {
  action: BulkAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkItemResult[];
}

export interface BulkActionBarProps {
  entityType: BulkEntityType;
  selectedIds: number[];
  onClear: () => void;
  onCompleted?: (outcome: BulkOutcome) => void;
  /** Tag vocabulary; fetched lazily when omitted and the tag action is shown. */
  tags?: TagRecord[];
  /** Actions exposed for this page. Defaults to all five. */
  actions?: BulkAction[];
  className?: string;
}

const ACTION_META: Record<BulkAction, { label: string; icon: typeof Trash2; destructive?: boolean }> = {
  delete: { label: '删除', icon: Trash2, destructive: true },
  tag: { label: '打标签', icon: TagIcon },
  archive: { label: '归档', icon: Archive },
  complete: { label: '完成', icon: CheckCheck },
  'change-type': { label: '改类型', icon: Shuffle },
};

const ALL_ACTIONS: BulkAction[] = ['tag', 'archive', 'complete', 'change-type', 'delete'];

export function BulkActionBar({
  entityType,
  selectedIds,
  onClear,
  onCompleted,
  tags: tagsProp,
  actions = ALL_ACTIONS,
  className,
}: BulkActionBarProps) {
  const [busyAction, setBusyAction] = useState<BulkAction | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagRecord[]>(tagsProp ?? []);
  const [activeTagId, setActiveTagId] = useState<number | null>(null);
  const [toType, setToType] = useState('');

  const showTag = actions.includes('tag') && !tagsProp;
  const count = selectedIds.length;

  useEffect(() => {
    if (!showTag) return;
    let active = true;
    listTags()
      .then((rows) => {
        if (active) setTags(rows);
      })
      .catch(() => {
        /* tag vocabulary is optional; the tag button degrades to disabled */
      });
    return () => {
      active = false;
    };
  }, [showTag]);

  const failures = useMemo(
    () => (outcome ? outcome.results.filter((entry) => !entry.ok) : []),
    [outcome],
  );

  if (count === 0) return null;

  async function run(action: BulkAction) {
    if (action === 'delete') {
      const confirmed = window.confirm(`确认删除选中的 ${count} 个条目？此操作不可撤销。`);
      if (!confirmed) return;
    }
    const params: { tagId?: number; toType?: string } = {};
    if (action === 'tag') {
      if (activeTagId === null) {
        setError('请先选择一个标签');
        return;
      }
      params.tagId = activeTagId;
    }
    if (action === 'change-type') {
      const value = toType.trim();
      if (!value) {
        setError('请填写目标类型');
        return;
      }
      params.toType = value;
    }

    setError(null);
    setBusyAction(action);
    try {
      const result = await api.post<BulkOutcome>('/bulk', {
        action,
        items: [{ entityType, ids: selectedIds }],
        params,
      });
      setOutcome(result);
      onCompleted?.(result);
      // Honest follow-up: keep the failed rows selected for a retry, clear when clean.
      if (result.failed === 0) onClear();
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量操作失败');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-4xl flex-col gap-3 rounded-t-2xl border border-slate-200/70 bg-white/95 p-4 shadow-2xl backdrop-blur dark:border-white/10 dark:bg-zinc-900/95',
        className,
      )}
      role="region"
      aria-label="批量操作"
      data-testid="bulk-action-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="normal-case" data-testid="bulk-count">
          已选 {count} 项
        </Badge>

        {actions.map((action) => {
          const meta = ACTION_META[action];
          const Icon = meta.icon;
          const disabled = busyAction !== null || (action === 'tag' && tags.length === 0);
          return (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={meta.destructive ? 'destructive' : 'outline'}
              disabled={disabled}
              onClick={() => void run(action)}
              data-testid={`bulk-action-${action}`}
            >
              {busyAction === action ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Icon className="mr-1.5 h-4 w-4" />}
              {meta.label}
            </Button>
          );
        })}

        {actions.includes('tag') && tags.length > 0 ? (
          <select
            className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-white/10 dark:bg-zinc-800 dark:text-white"
            value={activeTagId ?? ''}
            onChange={(e) => setActiveTagId(e.target.value ? Number(e.target.value) : null)}
            aria-label="选择标签"
          >
            <option value="">选择标签…</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        ) : null}

        {actions.includes('change-type') ? (
          <Input
            className="h-9 w-40"
            placeholder="目标类型"
            value={toType}
            onChange={(e) => setToType(e.target.value)}
            aria-label="目标类型"
          />
        ) : null}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOutcome(null);
            setError(null);
            onClear();
          }}
        >
          <X className="mr-1.5 h-4 w-4" />
          取消选择
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="bulk-error">
          {error}
        </p>
      ) : null}

      {outcome ? (
        <div className="rounded-xl bg-slate-100/80 p-3 text-sm dark:bg-white/5" data-testid="bulk-outcome">
          <p className={failures.length > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}>
            成功 {outcome.succeeded} 项，失败 {outcome.failed} 项（共 {outcome.requested} 项）
          </p>
          {failures.length > 0 ? (
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto overscroll-contain text-xs text-slate-600 dark:text-slate-300">
              {failures.map((entry) => (
                <li key={`${entry.entityType}-${entry.id}`}>
                  #{entry.id}：{entry.message ?? entry.code}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
