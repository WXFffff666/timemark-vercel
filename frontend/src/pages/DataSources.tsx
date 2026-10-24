import { useCallback, useEffect, useState } from 'react';
import { UploadCloud, DatabaseBackup, Loader2, Plus, RefreshCw, Rss, Trash2, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.38 R15c（方面 4+6）：数据源与备份页。
 * - feeds 源管理（18 端点此前零 UI）：ICS/邮件源 CRUD + 手动同步
 * - 远端备份配置（12 端点此前零 UI）：WebDAV/S3 目标 + 手动运行 + 历史记录
 */

interface FeedSource {
  id: number;
  kind: 'ics' | 'mail';
  name: string;
  url: string | null;
  mail_address: string | null;
  enabled: boolean;
  last_synced_at: string | null;
  created_at: string;
}

interface BackupConfig {
  targetType: 'webdav' | 's3' | null;
  endpoint: string | null;
  pathPrefix: string | null;
  bucket: string | null;
  region: string | null;
  username: string | null;
  enabled: boolean;
  retentionCount: number | null;
}

interface BackupRecord {
  id: number;
  status: string;
  key: string | null;
  sizeBytes: number | null;
  message: string | null;
  createdAt: string;
}

const fmtTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const fmtSize = (bytes: number | null): string => {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export default function DataSources() {
  // feeds
  const [sources, setSources] = useState<FeedSource[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(true);
  const [showFeedForm, setShowFeedForm] = useState(false);
  const [feedKind, setFeedKind] = useState<'ics' | 'mail'>('ics');
  const [feedName, setFeedName] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [feedMail, setFeedMail] = useState('');
  const [feedBusy, setFeedBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // backup
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [records, setRecords] = useState<BackupRecord[]>([]);
  const [backupLoading, setBackupLoading] = useState(true);
  const [targetType, setTargetType] = useState<'webdav' | 's3'>('webdav');
  const [endpoint, setEndpoint] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const loadFeeds = useCallback(() => {
    setFeedsLoading(true);
    api
      .get<FeedSource[]>('/feeds')
      .then((d) => setSources(Array.isArray(d) ? d : []))
      .catch(() => setSources([]))
      .finally(() => setFeedsLoading(false));
  }, []);

  const loadBackup = useCallback(() => {
    setBackupLoading(true);
    api
      .get<{ config: BackupConfig | null; records: BackupRecord[] }>('/remote-backup')
      .then((d) => {
        setConfig(d.config ?? null);
        setRecords(d.records ?? []);
        if (d.config) {
          setTargetType(d.config.targetType ?? 'webdav');
          setEndpoint(d.config.endpoint ?? '');
          setPathPrefix(d.config.pathPrefix ?? '');
          setUsername(d.config.username ?? '');
          setBucket(d.config.bucket ?? '');
          setRegion(d.config.region ?? '');
          setEnabled(d.config.enabled);
        }
      })
      .catch(() => undefined)
      .finally(() => setBackupLoading(false));
  }, []);

  useEffect(() => {
    loadFeeds();
    loadBackup();
  }, [loadFeeds, loadBackup]);

  const addFeed = async () => {
    setError('');
    if (feedKind === 'ics' && !/^https?:\/\//.test(feedUrl.trim())) {
      setError('ICS 订阅需要 http(s) URL');
      return;
    }
    if (feedKind === 'mail' && !feedMail.trim().includes('@')) {
      setError('请填写入站邮件地址');
      return;
    }
    setFeedBusy('add');
    try {
      await api.post('/feeds', {
        kind: feedKind,
        name: feedName.trim() || undefined,
        ...(feedKind === 'ics' ? { url: feedUrl.trim() } : { mailAddress: feedMail.trim() }),
      });
      setFeedName('');
      setFeedUrl('');
      setFeedMail('');
      setShowFeedForm(false);
      loadFeeds();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setFeedBusy(null);
    }
  };

  const deleteFeed = async (id: number, name: string) => {
    if (!confirm(`删除数据源「${name}」？`)) return;
    setFeedBusy(`del-${id}`);
    try {
      await api.delete(`/feeds/${id}`);
      setSources((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setFeedBusy(null);
    }
  };

  const syncFeed = async (id: number) => {
    setFeedBusy(`sync-${id}`);
    setNotice(null);
    try {
      await api.post(`/feeds/${id}/sync`, {});
      setNotice({ ok: true, text: '同步已触发，提案将出现在数据健康的待审批列表' });
      loadFeeds();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '同步失败' });
    } finally {
      setFeedBusy(null);
    }
  };

  const saveConfig = async () => {
    setError('');
    if (!endpoint.trim()) {
      setError('请填写目标地址');
      return;
    }
    setBackupBusy('save');
    setNotice(null);
    try {
      await api.put('/remote-backup/config', {
        targetType,
        endpoint: endpoint.trim(),
        pathPrefix: pathPrefix.trim() || null,
        username: username.trim() || null,
        password: password || null,
        bucket: bucket.trim() || null,
        region: region.trim() || null,
        enabled,
      });
      setPassword('');
      setNotice({ ok: true, text: '备份配置已保存' });
      loadBackup();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setBackupBusy(null);
    }
  };

  const runBackup = async () => {
    setBackupBusy('run');
    setNotice(null);
    try {
      const res = await api.post<{ status: string; message?: string }>('/remote-backup/run', { dryRun: false });
      setNotice({ ok: true, text: `备份完成（${res.status}${res.message ? `：${res.message}` : ''}）` });
      loadBackup();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '备份失败' });
    } finally {
      setBackupBusy(null);
    }
  };

  const removeConfig = async () => {
    if (!confirm('删除备份配置？历史记录保留但不再自动备份。')) return;
    setBackupBusy('remove');
    try {
      await api.delete('/remote-backup/config');
      setConfig(null);
      setEndpoint('');
      setNotice({ ok: true, text: '备份配置已删除' });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '删除失败' });
    } finally {
      setBackupBusy(null);
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="数据源与备份"
        subtitle="ICS/邮件订阅源 · 远端备份（WebDAV/S3）"
        back="smart"
        onRefresh={() => { loadFeeds(); loadBackup(); }}
        refreshing={feedsLoading || backupLoading}
      />

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {error && (
          <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className={`rounded-xl px-4 py-2 text-sm ${notice.ok ? 'border border-emerald-200/60 bg-emerald-50/60 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/10 dark:text-emerald-300' : 'border border-red-200/60 bg-red-50/60 text-red-600 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300'}`}>
            {notice.text}
          </p>
        )}

        {/* 数据源 */}
        <section aria-labelledby="feeds-heading">
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 id="feeds-heading" className="text-sm font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Rss size={14} aria-hidden /> 订阅数据源（{sources.length}）
            </h2>
            <Button size="sm" variant="outline" className="rounded-full" onClick={() => setShowFeedForm((v) => !v)} aria-label="添加数据源">
              {showFeedForm ? '收起' : <><Plus size={13} className="mr-1" aria-hidden /> 添加</>}
            </Button>
          </div>

          {showFeedForm && (
            <div className="glass-panel rounded-3xl p-4 mb-3 space-y-2">
              <div className="flex flex-wrap gap-2 items-end">
                <select value={feedKind} onChange={(e) => setFeedKind(e.target.value as 'ics' | 'mail')} aria-label="数据源类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                  <option value="ics">ICS 日历订阅</option>
                  <option value="mail">入站邮件</option>
                </select>
                <Input value={feedName} onChange={(e) => setFeedName(e.target.value)} placeholder="名称（可选）" aria-label="数据源名称" className="w-36" />
                {feedKind === 'ics' ? (
                  <Input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="https://…/calendar.ics" aria-label="ICS URL" className="flex-1 min-w-[12rem]" />
                ) : (
                  <Input value={feedMail} onChange={(e) => setFeedMail(e.target.value)} placeholder="入站邮件地址" aria-label="邮件地址" className="flex-1 min-w-[12rem]" />
                )}
                <Button onClick={() => void addFeed()} disabled={feedBusy === 'add'} aria-label="保存数据源">
                  {feedBusy === 'add' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
                  保存
                </Button>
              </div>
              <p className="text-xs text-slate-400">同步产生的条目不会直接入库——先出现在「数据健康 → 待审批提议」，你采纳后才生效。</p>
            </div>
          )}

          {feedsLoading ? (
            <SkeletonCard count={2} />
          ) : sources.length === 0 ? (
            <EmptyState icon={Rss} title="还没有订阅数据源" description="添加外部 ICS 日历或入站邮件地址，内容经你审批后入库" />
          ) : (
            <ul className="space-y-2">
              {sources.map((s) => (
                <li key={s.id} className="glass-panel rounded-2xl px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{s.name}</span>
                      <Badge variant="outline" className="scale-90">{s.kind === 'ics' ? 'ICS' : '邮件'}</Badge>
                      {s.enabled !== false ? (
                        <Badge variant="secondary" className="scale-90">启用</Badge>
                      ) : (
                        <Badge variant="outline" className="scale-90">停用</Badge>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">
                      {s.url ?? s.mail_address ?? '—'} · 上次同步 {fmtTime(s.last_synced_at)}
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" variant="outline" className="rounded-full h-8" disabled={feedBusy !== null} onClick={() => void syncFeed(s.id)} aria-label={`同步「${s.name}」`}>
                      {feedBusy === `sync-${s.id}` ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} className="mr-1" aria-hidden />}
                      同步
                    </Button>
                    <Button size="icon" variant="ghost" className="min-h-8 min-w-8 text-red-500" aria-label={`删除「${s.name}」`} disabled={feedBusy !== null} onClick={() => void deleteFeed(s.id, s.name)}>
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 远端备份 */}
        <section aria-labelledby="backup-heading">
          <h2 id="backup-heading" className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2 px-1 flex items-center gap-1.5">
            <DatabaseBackup size={14} aria-hidden /> 远端备份（WebDAV / S3）
          </h2>

          <div className="glass-panel rounded-3xl p-5 space-y-3">
            <div className="flex flex-wrap gap-2 items-end">
              <select value={targetType} onChange={(e) => setTargetType(e.target.value as 'webdav' | 's3')} aria-label="备份目标类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                <option value="webdav">WebDAV</option>
                <option value="s3">S3 兼容</option>
              </select>
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={targetType === 'webdav' ? 'https://dav.example.com/backup' : 's3.amazonaws.com'} aria-label="目标地址" className="flex-1 min-w-[12rem]" />
              <Input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="路径前缀（可选）" aria-label="路径前缀" className="w-36" />
            </div>
            <div className="flex flex-wrap gap-2 items-end">
              {targetType === 'webdav' ? (
                <>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" aria-label="WebDAV 用户名" className="w-32" />
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={config ? '密码（留空=不改）' : '密码'} aria-label="WebDAV 密码" type="password" className="w-36" />
                </>
              ) : (
                <>
                  <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="Bucket" aria-label="S3 bucket" className="w-28" />
                  <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Region（可选）" aria-label="S3 region" className="w-28" />
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="AccessKeyId" aria-label="AccessKeyId" className="w-32" />
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={config ? 'SecretKey（留空=不改）' : 'SecretKey'} aria-label="SecretKey" type="password" className="w-40" />
                </>
              )}
              <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-primary-500" />
                启用
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveConfig()} disabled={backupBusy !== null} aria-label="保存备份配置">
                {backupBusy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
                {config ? '更新配置' : '保存配置'}
              </Button>
              {config?.enabled && (
                <Button variant="outline" onClick={() => void runBackup()} disabled={backupBusy !== null} aria-label="立即备份">
                  {backupBusy === 'run' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <UploadCloud className="w-4 h-4 mr-1" aria-hidden />}
                  立即备份
                </Button>
              )}
              {config && (
                <Button variant="ghost" className="text-red-500" onClick={() => void removeConfig()} disabled={backupBusy !== null} aria-label="删除备份配置">
                  删除配置
                </Button>
              )}
            </div>
          </div>

          {/* 备份历史 */}
          {records.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-bold text-hint mb-1.5 px-1">备份历史（{records.length}）</h3>
              <ul className="glass-panel rounded-3xl p-4 space-y-1.5 ring-1 ring-black/5 dark:ring-white/10">
                {records.slice(0, 10).map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.status === 'success' ? 'bg-emerald-500' : r.status === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-red-500'}`} aria-hidden />
                    <span className="tabular-nums text-slate-500 shrink-0">{fmtTime(r.createdAt)}</span>
                    <span className="truncate">{r.key ?? r.message ?? r.status}</span>
                    <span className="text-slate-400 ml-auto shrink-0 tabular-nums">{fmtSize(r.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
