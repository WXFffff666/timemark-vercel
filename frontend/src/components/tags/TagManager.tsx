import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Tag as TagIcon, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  TAG_ENTITY_TYPES,
  createTag,
  deleteTag,
  listTaggedEntities,
  listTags,
  type TagEntityType,
  type TagFilterMode,
  type TagRecord,
  type TaggedEntity,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * checkbox 134: cross-entity tag UI (vocabulary manager + chips + the AND/OR smart filter).
 *
 * A self-contained unit that later pages (dashboard 136, bulk actions 139) can mount: it owns
 * no route, only the tag vocabulary (`GET/POST/DELETE /api/tags`) and the smart filter
 * (`GET /api/tags/entities`). The filter COMPOSES - the entity-type checkboxes and the limit
 * are additional filters on top of the tag selection, never a replacement for page filters.
 */

const ENTITY_LABELS: Record<TagEntityType, string> = {
  event: '事件',
  contact: '联系人',
  document: '证件',
  expiry: '到期',
  inventory: '库存',
  maintenance: '维护',
  habit: '习惯',
  goal: '目标',
};

/** Read-only chips; `onRemove` adds a small × (used by detail pages). */
export function TagChips({
  tags,
  onRemove,
  className,
}: {
  tags: TagRecord[];
  onRemove?: (tag: TagRecord) => void;
  className?: string;
}) {
  if (tags.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid="tag-chips">
      {tags.map((tag) => (
        <Badge key={tag.id} variant="secondary" className="gap-1 normal-case" data-testid="tag-chip">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: tag.color ?? '#64748b' }}
          />
          {tag.name}
          {onRemove ? (
            <button
              type="button"
              aria-label={`移除标签 ${tag.name}`}
              className="ml-0.5 rounded-full px-0.5 hover:text-red-500"
              onClick={() => onRemove(tag)}
            >
              ×
            </button>
          ) : null}
        </Badge>
      ))}
    </div>
  );
}

export function TagManager() {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [mode, setMode] = useState<TagFilterMode>('and');
  const [entityTypes, setEntityTypes] = useState<TagEntityType[]>([...TAG_ENTITY_TYPES]);
  const [results, setResults] = useState<TaggedEntity[]>([]);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTags(await listTags());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '标签加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = newName.trim();
      if (!name) return;
      try {
        await createTag({ name });
        setNewName('');
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : '标签创建失败');
      }
    },
    [newName, refresh],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await deleteTag(id);
        setSelectedIds((current) => current.filter((value) => value !== id));
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : '标签删除失败');
      }
    },
    [refresh],
  );

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }, []);

  const toggleEntityType = useCallback((type: TagEntityType) => {
    setEntityTypes((current) =>
      current.includes(type) ? current.filter((value) => value !== type) : [...current, type],
    );
  }, []);

  const runFilter = useCallback(async () => {
    setSearching(true);
    try {
      setResults(
        await listTaggedEntities({
          tagIds: selectedIds,
          mode,
          entityTypes,
          limit: 100,
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '筛选失败');
    } finally {
      setSearching(false);
    }
  }, [selectedIds, mode, entityTypes]);

  const grouped = useMemo(() => {
    const byType = new Map<TagEntityType, TaggedEntity[]>();
    for (const entity of results) {
      const list = byType.get(entity.entity_type);
      if (list) list.push(entity);
      else byType.set(entity.entity_type, [entity]);
    }
    return [...byType.entries()];
  }, [results]);

  const tagNameById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.name])), [tags]);

  return (
    <section className="glass-panel space-y-4 p-4" data-testid="tag-manager">
      <header className="flex items-center gap-2">
        <TagIcon className="h-4 w-4" aria-hidden="true" />
        <h2 className="text-sm font-semibold">标签</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {tags.length > 0 ? `共 ${tags.length} 个` : ''}
        </span>
      </header>

      {error ? (
        <p role="alert" className="text-xs text-red-500" data-testid="tag-error">
          {error}
        </p>
      ) : null}

      <form onSubmit={handleCreate} className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="新建标签名称（最长 32 字）"
          aria-label="新建标签名称"
          maxLength={64}
        />
        <Button type="submit" size="sm" disabled={newName.trim() === ''}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          新建
        </Button>
      </form>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" data-testid="tag-loading">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> 加载中…
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="tag-list">
          {tags.map((tag) => {
            const selected = selectedIds.includes(tag.id);
            return (
              <li key={tag.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`筛选标签 ${tag.name}`}
                  onClick={() => toggleSelected(tag.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    selected
                      ? 'border-blue-400 bg-blue-100 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/20 dark:text-blue-300'
                      : 'border-slate-200 bg-white/40 text-slate-600 hover:bg-white/70 dark:border-slate-600 dark:bg-black/20 dark:text-slate-300',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color ?? '#64748b' }}
                  />
                  {tag.name}
                  <span className="text-[10px] opacity-70">{tag.link_count ?? 0}</span>
                </button>
                <button
                  type="button"
                  aria-label={`删除标签 ${tag.name}`}
                  className="rounded-full p-1 text-slate-400 hover:text-red-500"
                  onClick={() => void handleDelete(tag.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2 border-t border-white/10 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium">匹配方式</span>
          {(['and', 'or'] as const).map((value) => (
            <label key={value} className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                name="tag-filter-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {value === 'and' ? '同时包含 (AND)' : '任一包含 (OR)'}
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">实体类型</span>
          {TAG_ENTITY_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={entityTypes.includes(type)}
                onChange={() => toggleEntityType(type)}
              />
              {ENTITY_LABELS[type]}
            </label>
          ))}
        </div>

        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={selectedIds.length === 0 || entityTypes.length === 0 || searching}
          onClick={() => void runFilter()}
        >
          {searching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          筛选
        </Button>

        <div data-testid="tag-filter-results">
          {grouped.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">没有匹配的实体</p>
          ) : (
            grouped.map(([type, entities]) => (
              <div key={type} className="mt-2">
                <p className="text-xs font-semibold">
                  {ENTITY_LABELS[type]}（{entities.length}）
                </p>
                <ul className="mt-1 space-y-1 text-xs">
                  {entities.map((entity) => (
                    <li key={`${entity.entity_type}-${entity.entity_id}`} className="flex gap-2">
                      <span>#{entity.entity_id}</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {entity.tag_ids
                          .map((id) => tagNameById.get(id) ?? String(id))
                          .join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
