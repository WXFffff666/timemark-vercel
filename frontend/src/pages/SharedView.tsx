import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';

/**
 * Public, read-only share page (task 148).
 *
 * Fetches `/api/share/:token` directly (the authenticated `api` client is not
 * used on a public route). When the share carries a passcode the endpoint
 * answers 401 `passcode_required`; the page then shows a passcode prompt and
 * retries with the `X-Share-Passcode` header. Nothing is ever written.
 */
interface SharedEvent {
  id: number;
  name: string;
  type: string;
  date: string;
  calendar_type: string | null;
  person_name: string | null;
  tags: unknown;
}

interface SharedContact {
  id: number;
  name: string;
  nickname: string | null;
  relationship: string | null;
  gender: string | null;
}

interface ScopedView {
  scopeType: 'profile' | 'tag';
  scopeLabel: string;
  events: SharedEvent[];
  contacts: SharedContact[];
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string');
}

export default function SharedView() {
  const { token } = useParams();
  const [data, setData] = useState<ScopedView | null>(null);
  const [error, setError] = useState('');
  const [needPasscode, setNeedPasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (code?: string) => {
      if (!token) {
        setError('分享链接无效');
        return;
      }
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`/api/share/${encodeURIComponent(token)}`, {
          headers: code ? { 'X-Share-Passcode': code } : undefined,
        });
        const json = (await response.json().catch(() => null)) as
          | { success: boolean; data?: ScopedView; error?: string; code?: string }
          | null;

        if (json?.success && json.data) {
          setData(json.data);
          setNeedPasscode(false);
          return;
        }

        if (response.status === 401 && (json?.code === 'passcode_required' || json?.code === 'passcode_invalid')) {
          setNeedPasscode(true);
          setError(json.code === 'passcode_invalid' ? '访问密码错误' : '');
          return;
        }

        setError(json?.error || '无法加载分享内容');
      } catch {
        setError('加载失败');
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const submitPasscode = (event: FormEvent) => {
    event.preventDefault();
    void load(passcode.trim());
  };

  if (needPasscode && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <form
          onSubmit={submitPasscode}
          className="glass-panel w-full max-w-sm rounded-[2.5rem] p-8 text-center"
          data-testid="shared-view-passcode"
        >
          <p className="text-sm font-bold text-slate-900 dark:text-white">受保护的分享</p>
          <p className="mt-1 text-xs text-hint">请输入访问密码查看内容</p>
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            className="mt-4 w-full rounded-xl border border-slate-200/70 bg-white/70 px-4 py-3 text-sm dark:border-white/10 dark:bg-black/20"
            placeholder="访问密码"
            aria-label="访问密码"
          />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={loading || passcode.trim().length === 0}
            className="mt-4 w-full rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? '验证中…' : '查看'}
          </button>
        </form>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-panel w-full max-w-md rounded-[2.5rem] p-10 text-center" data-testid="shared-view-error">
          <p className="text-slate-700 dark:text-slate-200">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="min-h-screen flex items-center justify-center text-hint">加载中…</div>;
  }

  return (
    <div className="min-h-screen flex items-start justify-center p-6">
      <article className="glass-panel w-full max-w-2xl rounded-[2.5rem] p-8 shadow-xl" data-testid="shared-view">
        <header className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-extrabold text-white shadow-lg">
            T
          </span>
          <div>
            <p className="text-sm font-bold text-slate-900 dark:text-white">TimeMark</p>
            <p className="text-xs text-hint">
              {data.scopeType === 'profile' ? '家庭档案' : '标签'} · {data.scopeLabel}
            </p>
          </div>
        </header>

        <section aria-label="事件">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">事件</h2>
          {data.events.length === 0 ? (
            <p className="mt-2 text-sm text-hint">暂无事件</p>
          ) : (
            <ul className="mt-2 space-y-2" data-testid="shared-view-events">
              {data.events.map((event) => {
                const tags = tagsOf(event.tags);
                return (
                  <li
                    key={event.id}
                    className="rounded-2xl bg-white/60 px-4 py-3 ring-1 ring-black/5 dark:bg-black/20 dark:ring-white/10"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-slate-900 dark:text-white">{event.name}</span>
                      <span className="text-xs text-hint">{event.date}</span>
                    </div>
                    {event.person_name && <p className="mt-1 text-xs text-hint">相关人：{event.person_name}</p>}
                    {tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-600 dark:text-indigo-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {data.contacts.length > 0 && (
          <section aria-label="联系人" className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">联系人</h2>
            <ul className="mt-2 space-y-2" data-testid="shared-view-contacts">
              {data.contacts.map((contact) => (
                <li
                  key={contact.id}
                  className="flex items-center justify-between rounded-2xl bg-white/60 px-4 py-3 ring-1 ring-black/5 dark:bg-black/20 dark:ring-white/10"
                >
                  <span className="font-medium text-slate-900 dark:text-white">
                    {contact.name}
                    {contact.nickname ? `（${contact.nickname}）` : ''}
                  </span>
                  {contact.relationship && <span className="text-xs text-hint">{contact.relationship}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-8 border-t border-slate-200/70 pt-4 dark:border-white/10">
          <p className="text-xs text-hint">由 TimeMark 只读分享生成</p>
        </div>
      </article>
    </div>
  );
}
