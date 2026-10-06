import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Inbox as InboxIcon, Trash2, Mail, MailOpen, CheckCheck, Copy, QrCode } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCard } from '@/components/ui/skeleton-card';
import { ChannelQr } from '@/components/channels/ChannelQr';
import { api } from '@/lib/api';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } as const } };

interface InboxMessage {
  id: number;
  title: string;
  body: string;
  source: string;
  channel: string | null;
  sender_label: string | null;
  is_read: boolean;
  created_at: string;
}

const sourceLabels: Record<string, string> = {
  inbound: '外部推送',
  notification: '提醒通知',
  broadcast: '广播',
};

import { formatRelativeTime } from '@/lib/format-time';

export default function Inbox() {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  // v2.27：展开正文的消息集合 / 错误提示（此前失败只进 console，用户无感知）
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [pendingMarkId, setPendingMarkId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  // v2.27：分页游标 = 上次成功页 offset + 该页行数（与本地删除无关，
  // 否则删除后再加载更多会因 offset 前移造成重复行）
  const nextOffsetRef = useRef(0);


  // v2.27 F42/F49：文本搜索 + 只看未读（后端 ?q= / ?unread=1 直接支持）
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  // v2.30：来源标签页 / 批量选择 / 收件地址卡
  const [sourceTab, setSourceTab] = useState<'all' | 'inbound' | 'broadcast'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [showReceiveCard, setShowReceiveCard] = useState(false);
  const [receiveUrl, setReceiveUrl] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  useEffect(() => {
    api.get<{ receiveUrl: string | null; retentionDays: number }>('/inbox/info')
      .then((info) => {
        setReceiveUrl(info.receiveUrl);
        setRetentionDays(info.retentionDays);
      })
      .catch(() => undefined);
  }, []);

  // v2.30：竞态守卫——快速切换筛选（搜索防抖/未读/标签页）时旧响应后到会覆盖新状态
  const fetchSeqRef = useRef(0);

  const fetchMessages = async (offset = 0, q = debouncedSearch, unread = unreadOnly, source = sourceTab) => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100', offset: String(offset), source });
      if (q.trim()) params.set('q', q.trim());
      if (unread) params.set('unread', '1');
      const res = await api.getRaw<InboxMessage[]>(`/inbox?${params.toString()}`);
      if (seq !== fetchSeqRef.current) return; // 已有更新的请求，丢弃旧响应
      const page = res.data || [];
      setTotal((res.pagination?.total as number) || 0);
      setUnreadCount((res.pagination?.unreadCount as number) || 0);
      // v2.27 A-8：加载更多 —— offset>0 时追加而不是替换
      setMessages((prev) => (offset > 0 ? [...prev, ...page] : page));
      nextOffsetRef.current = offset + page.length;
    } catch (error) {
      if (seq !== fetchSeqRef.current) return;
      console.error('Failed to fetch inbox:', error);
      if (offset === 0) setMessages([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchMessages();
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
    fetchMessages(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, unreadOnly, sourceTab]);

  const markRead = async (id: number) => {
    setPendingMarkId(id);
    setActionError('');
    try {
      await api.patch(`/inbox/${id}/read`, {});
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, is_read: true } : m)));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (error) {
      console.error('Failed to mark read:', error);
      setActionError(error instanceof Error ? error.message : '标记已读失败');
    } finally {
      setPendingMarkId(null);
    }
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      await api.post('/inbox/read-all', {});
      setMessages((prev) => prev.map((m) => ({ ...m, is_read: true })));
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all read:', error);
    } finally {
      setMarkingAll(false);
    }
  };

  const deleteMessage = async (id: number) => {
    if (!confirm('确定删除此消息？')) return;
    try {
      await api.delete(`/inbox/${id}`);
      const removed = messages.find((m) => m.id === id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      if (removed && !removed.is_read) setUnreadCount((c) => Math.max(0, c - 1));
    } catch (error) {
      console.error('Failed to delete message:', error);
      setActionError(error instanceof Error ? error.message : '删除失败');
    }
  };

  // v2.30：批量已读 / 批量删除
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchRun = async (op: 'read' | 'delete') => {
    if (selectedIds.size === 0) return;
    if (op === 'delete' && !confirm(`确定删除选中的 ${selectedIds.size} 条消息？`)) return;
    setBatchBusy(true);
    setActionError('');
    try {
      const res = await api.post<{ affected: number }>(`/inbox/batch-${op}`, { ids: [...selectedIds] });
      if (op === 'delete') {
        setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)));
        setTotal((t) => Math.max(0, t - (res.affected ?? 0)));
      } else {
        setMessages((prev) => prev.map((m) => (selectedIds.has(m.id) ? { ...m, is_read: true } : m)));
      }
      setUnreadCount((c) => Math.max(0, c - (op === 'read' ? selectedIds.size : 0)));
      setSelectedIds(new Set());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '批量操作失败');
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <PageHeader
        title="收件箱"
        subtitle={`共 ${total} 条消息${retentionDays ? ` · 保留 ${retentionDays} 天` : ''}`}
        actions={
          <>
            {unreadCount > 0 && <Badge variant="destructive" className="scale-90">{unreadCount}</Badge>}
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setShowReceiveCard((v) => !v)}>
              <QrCode size={16} className="mr-1" />
              收件地址
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full" onClick={markAllRead} disabled={markingAll || unreadCount === 0}>
              <CheckCheck size={16} className="mr-1" />
              全部已读
            </Button>
          </>
        }
        onRefresh={() => fetchMessages()}
        refreshing={loading}
      />
      {showReceiveCard && (
        <div className="max-w-4xl mx-auto px-6 mt-3">
          <div className="glass-panel rounded-3xl p-5 ring-1 ring-black/5 dark:ring-white/10 flex flex-col sm:flex-row items-center gap-5">
            {receiveUrl ? (
              <>
                <ChannelQr url={receiveUrl} name="收件地址" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-1">外部系统推送地址</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 break-all font-mono">{receiveUrl}</p>
                  <p className="text-xs text-slate-400 mt-2">
                    POST JSON {"{ title, body, sender? }"} 即可推送到此收件箱；签名密钥在「设置 → 集成」中查看。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full mt-3"
                    onClick={() => navigator.clipboard.writeText(receiveUrl).catch(() => undefined)}
                  >
                    <Copy size={14} className="mr-1" /> 复制地址
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">收件地址加载中…</p>
            )}
          </div>
        </div>
      )}
      <div className="max-w-4xl mx-auto px-6 mt-3 flex flex-wrap gap-2 items-center">
        <div className="flex rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden" role="tablist" aria-label="消息来源">
          {([['all', '全部'], ['inbound', '外部推送'], ['broadcast', '广播']] as const).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={sourceTab === key}
              onClick={() => setSourceTab(key)}
              className={`px-3 h-11 text-sm transition-colors ${sourceTab === key ? 'bg-primary-500/10 text-primary-600 dark:text-primary-300 font-semibold' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索标题或正文…"
          className="h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm flex-1 min-w-[12rem]"
          aria-label="搜索收件箱"
        />
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
            className="h-4 w-4 accent-primary-500"
          />
          只看未读
        </label>
      </div>
      {selectedIds.size > 0 && (
        <div className="max-w-4xl mx-auto px-6 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary-200/60 dark:border-primary-800/50 bg-primary-50/60 dark:bg-primary-900/20 px-4 py-2">
          <span className="text-sm text-slate-600 dark:text-slate-300">已选 {selectedIds.size} 条</span>
          <Button size="sm" variant="outline" className="rounded-full" disabled={batchBusy} onClick={() => batchRun('read')}>
            <CheckCheck size={14} className="mr-1" /> 批量已读
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full text-red-500" disabled={batchBusy} onClick={() => batchRun('delete')}>
            <Trash2 size={14} className="mr-1" /> 批量删除
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full text-slate-400" onClick={() => setSelectedIds(new Set())}>
            取消选择
          </Button>
        </div>
      )}
      <main className="max-w-4xl mx-auto px-6 py-10 mt-2">
        {actionError && (
          <div className="mb-4 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {actionError}
          </div>
        )}
        {loading ? (
          <SkeletonCard count={4} />
        ) : messages.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="收件箱为空"
            description="外部系统通过收件 API 推送的消息将显示在此处（不含您自己发出的提醒）"
          />
        ) : (
          <motion.div variants={containerVariants} initial="hidden" animate="visible" className="relative">
            <div className="absolute left-[2.25rem] top-8 bottom-8 w-px bg-gradient-to-b from-primary-500/40 via-slate-200 dark:via-slate-700 to-transparent z-0"></div>
            <div className="space-y-6 relative z-10">
              {messages.map((msg) => (
                <motion.div key={msg.id} variants={itemVariants} className="flex gap-6 items-start">
                  {/* v2.30：批量选择框 */}
                  <input
                    type="checkbox"
                    checked={selectedIds.has(msg.id)}
                    onChange={() => toggleSelect(msg.id)}
                    aria-label={`选择消息：${msg.title}`}
                    className="mt-6 h-4 w-4 shrink-0 accent-primary-500"
                  />
                  <div className={`w-16 h-16 rounded-[1.5rem] shrink-0 flex items-center justify-center shadow-md border backdrop-blur-md ${msg.is_read ? 'bg-white/90 dark:bg-slate-800/90 text-slate-400 border-white/60 dark:border-white/10' : 'bg-primary-50/90 dark:bg-primary-900/40 text-primary-600 border-primary-100 dark:border-primary-800/50'}`}>
                    {msg.is_read ? <MailOpen size={26} /> : <Mail size={26} />}
                  </div>
                  <div className={`glass-panel rounded-[2.5rem] p-6 flex-1 hover:shadow-xl transition-all ring-1 ring-black/5 dark:ring-white/10 ${!msg.is_read ? 'ring-primary-200/50 dark:ring-primary-800/30' : ''}`}>
                    <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <h3 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
                            {msg.title}
                          </h3>
                          {!msg.is_read && <Badge variant="default" className="scale-90">未读</Badge>}
                          <Badge variant="outline" className="scale-90">{sourceLabels[msg.source] || msg.source}</Badge>
                        </div>
                        {/* v2.27 A-7/E-5：正文可展开/收起 + 一键复制 */}
                        <p className={`text-sm text-slate-600 dark:text-slate-300 mt-2 whitespace-pre-wrap break-words ${expandedIds.has(msg.id) ? '' : 'line-clamp-4'}`}>{msg.body}</p>
                        {(msg.body.length > 160 || expandedIds.has(msg.id)) && (
                          <button
                            type="button"
                            className="text-xs text-indigo-500 mt-1 hover:underline"
                            onClick={() => setExpandedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                              return next;
                            })}
                          >
                            {expandedIds.has(msg.id) ? '收起' : '展开全文'}
                          </button>
                        )}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs font-medium text-slate-500 dark:text-slate-400">
                          {msg.sender_label && <span>来自 {msg.sender_label}</span>}
                          {msg.channel && <span>渠道 {msg.channel}</span>}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <div className="text-sm font-bold text-slate-400 whitespace-nowrap bg-slate-100/50 dark:bg-slate-800/50 px-3 py-1 rounded-lg">
                          {formatRelativeTime(msg.created_at)}
                        </div>
                        <div className="flex gap-1">
                          {!msg.is_read && (
                            <Button size="sm" variant="outline" className="rounded-full text-xs" disabled={pendingMarkId === msg.id} onClick={() => markRead(msg.id)}>
                              {pendingMarkId === msg.id ? '处理中…' : '标为已读'}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-full text-xs text-slate-400"
                            aria-label="复制正文"
                            title="复制正文"
                            onClick={() => navigator.clipboard.writeText(msg.body).catch(() => undefined)}
                          >
                            <Copy size={14} />
                          </Button>
                          <Button size="sm" variant="ghost" className="rounded-full text-xs text-red-500" aria-label="删除消息" onClick={() => deleteMessage(msg.id)}>
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
        {/* v2.27 A-8：分页加载更多 */}
        {!loading && messages.length < total && (
          <div className="text-center mt-6">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full min-h-11"
              onClick={() => fetchMessages(nextOffsetRef.current)}
            >
              加载更多（已加载 {messages.length}/{total}）
            </Button>
          </div>
        )}
      </main>
    </motion.div>
  );
}
