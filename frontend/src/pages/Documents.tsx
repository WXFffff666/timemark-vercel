import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  Eye,
  FileText,
  Paperclip,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSmartBack } from '@/hooks/useSmartBack';
import { api } from '@/lib/api';
import {
  base64PayloadFromDataUrl,
  documentCountdown,
  documentKindLabel,
  formatBytes,
  maskedDocumentNumber,
  validateAttachment,
  type AttachmentUploadBody,
  type DocumentAttachment,
  type DocumentItem,
} from '@/lib/document-utils';
import {
  DOCUMENT_KINDS,
  createDocumentSchema,
  type AttachmentContentType,
  type CreateDocumentInput,
  type DocumentKind,
} from '@timemark/shared';

/**
 * 证件保险箱（D2，todo 56）。全部请求走既有 fetch 封装；形状对齐 backend 的
 * `/api/documents` 与 `/api/attachments`（todo 54）。
 *
 * 安全/失败优先：
 * - 列表响应只有 `numberConfigured` 布尔标志；明文号码仅在「显示」对话框里
 *   一次性拉取，关闭即清空，不写 store / localStorage / 日志。
 * - 附件 2 MB 上限 + 白名单 + 魔数嗅探全部在**发请求之前**客户端强制；
 *   重命名的 `.exe`（浏览器声明 application/pdf）会被嗅探拦下，零网络请求。
 * - 无 `expires_at` 渲染「无到期日」而不是 NaN；API 报错只显示错误、不崩溃。
 */

const KIND_OPTIONS = DOCUMENT_KINDS.map((kind) => ({ value: kind, label: documentKindLabel(kind) }));
const ATTACHMENT_ACCEPT =
  'application/pdf,image/png,image/jpeg,image/webp,text/plain,.pdf,.png,.jpg,.jpeg,.webp,.txt';
const UPLOAD_OWNER_TYPE = 'document' as const;

interface DocumentForm {
  kind: DocumentKind;
  title: string;
  issuer: string;
  documentNumber: string;
  issuedAt: string;
  expiresAt: string;
  country: string;
  notes: string;
  isActive: boolean;
}

const emptyForm = (): DocumentForm => ({
  kind: 'passport',
  title: '',
  issuer: '',
  documentNumber: '',
  issuedAt: '',
  expiresAt: '',
  country: '',
  notes: '',
  isActive: true,
});

function toForm(item: DocumentItem): DocumentForm {
  const kind = (DOCUMENT_KINDS as readonly string[]).includes(item.kind)
    ? (item.kind as DocumentKind)
    : 'other';
  return {
    kind,
    title: item.title,
    issuer: item.issuer ?? '',
    // 号码永不回显：编辑时留空表示「保持不变」。
    documentNumber: '',
    issuedAt: item.issued_at ?? '',
    expiresAt: item.expires_at ?? '',
    country: item.country ?? '',
    notes: item.notes ?? '',
    isActive: item.is_active,
  };
}

function buildCreatePayload(form: DocumentForm): CreateDocumentInput {
  return {
    kind: form.kind,
    title: form.title.trim(),
    issuer: form.issuer.trim() || null,
    documentNumber: form.documentNumber.trim() || null,
    issuedAt: form.issuedAt || null,
    expiresAt: form.expiresAt || null,
    country: form.country.trim() || null,
    notes: form.notes.trim() || null,
    isActive: form.isActive,
  };
}

/** PATCH 只发送改动字段；号码仅在用户输入了新值时才提交（留空=不变）。 */
function buildUpdatePayload(form: DocumentForm): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: form.kind,
    title: form.title.trim(),
    issuer: form.issuer.trim() || null,
    issuedAt: form.issuedAt || null,
    expiresAt: form.expiresAt || null,
    country: form.country.trim() || null,
    notes: form.notes.trim() || null,
    isActive: form.isActive,
  };
  const number = form.documentNumber.trim();
  if (number) payload.documentNumber = number;
  return payload;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function SummaryCard({
  testId,
  label,
  value,
  hint,
  tone,
}: {
  testId: string;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'destructive';
}) {
  return (
    <div
      data-testid={testId}
      data-count={typeof value === 'number' ? value : undefined}
      className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10"
    >
      <p className="text-xs text-hint">{label}</p>
      <p className={`text-2xl font-extrabold mt-1 ${tone === 'destructive' ? 'text-destructive' : 'text-slate-900 dark:text-slate-100'}`}>
        {value}
      </p>
      {hint && <p className="text-[10px] text-hint mt-1">{hint}</p>}
    </div>
  );
}

function AttachmentRow({
  attachment,
  deleting,
  onDelete,
}: {
  attachment: DocumentAttachment;
  deleting: boolean;
  onDelete: (attachment: DocumentAttachment) => void;
}) {
  return (
    <li
      data-testid={`attachment-row-${attachment.id}`}
      className="flex items-center gap-2 rounded-xl px-2 py-1.5 bg-white/50 dark:bg-black/20"
    >
      <FileText className="w-4 h-4 shrink-0 text-hint" aria-hidden />
      <span data-testid={`attachment-name-${attachment.id}`} className="flex-1 min-w-0 truncate text-xs">
        {attachment.filename}
      </span>
      <span className="text-[10px] text-hint shrink-0">{formatBytes(attachment.byte_size)}</span>
      <a
        href={attachment.download_url}
        className="text-primary-600 dark:text-primary-400 underline text-[11px] shrink-0"
        aria-label={`下载 ${attachment.filename}`}
      >
        <Download className="w-3.5 h-3.5" aria-hidden />
      </a>
      <Button
        variant="ghost"
        size="icon"
        className="min-h-8 min-w-8 h-8 w-8"
        disabled={deleting}
        onClick={() => onDelete(attachment)}
        aria-label={`删除附件 ${attachment.filename}`}
      >
        <Trash2 className="w-3.5 h-3.5 text-destructive" aria-hidden />
      </Button>
    </li>
  );
}

function DocumentRow({
  item,
  now,
  attachments,
  onReveal,
  onEdit,
  onDelete,
  deletingAttachmentId,
  onDeleteAttachment,
}: {
  item: DocumentItem;
  now: Date;
  attachments: DocumentAttachment[];
  onReveal: (item: DocumentItem) => void;
  onEdit: (item: DocumentItem) => void;
  onDelete: (item: DocumentItem) => void;
  deletingAttachmentId: number | null;
  onDeleteAttachment: (attachment: DocumentAttachment) => void;
}) {
  const countdown = documentCountdown(item.expires_at, now);
  const isOverdue = countdown.kind === 'overdue';

  return (
    <div
      data-testid={`document-item-${item.id}`}
      data-overdue={isOverdue ? 'true' : undefined}
      className={`glass-panel rounded-2xl px-3 py-3 ${isOverdue ? 'ring-1 ring-destructive/30' : 'ring-1 ring-black/5 dark:ring-white/10'}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span data-testid={`document-title-${item.id}`} className="font-semibold truncate">{item.title}</span>
            <Badge variant="secondary" className="text-[10px]">{documentKindLabel(item.kind)}</Badge>
            {isOverdue && (
              <span
                data-testid={`document-overdue-badge-${item.id}`}
                data-token="destructive"
                className="inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-destructive"
              >
                已过期
              </span>
            )}
            {item.is_active === false && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
          </div>
          <p className="text-xs text-hint mt-1">
            <span data-testid={`document-expiry-${item.id}`}>{item.expires_at ?? '—'}</span>
            {item.issuer ? ` · ${item.issuer}` : ''}
            {item.country ? ` · ${item.country}` : ''}
          </p>
          <p
            data-testid={`document-countdown-${item.id}`}
            data-kind={countdown.kind}
            className={`text-xs mt-1 font-semibold ${isOverdue ? 'text-destructive' : 'text-primary-600 dark:text-primary-400'}`}
          >
            {countdown.text}
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-hint">证件号码</span>
            <span
              data-testid={`document-number-${item.id}`}
              data-masked={item.numberConfigured ? 'true' : 'false'}
              className="font-mono text-xs tracking-widest text-slate-700 dark:text-slate-200"
            >
              {maskedDocumentNumber(item.numberConfigured)}
            </span>
            {item.numberConfigured && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 min-h-8 text-xs"
                onClick={() => onReveal(item)}
                aria-label={`显示 ${item.title} 的证件号码`}
              >
                <Eye className="w-3.5 h-3.5 mr-1" aria-hidden />
                显示
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onEdit(item)} aria-label={`编辑 ${item.title}`}>
            <Pencil className="w-4 h-4" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => onDelete(item)} aria-label={`删除 ${item.title}`}>
            <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
          </Button>
        </div>
      </div>

      {attachments.length > 0 && (
        <ul
          data-testid={`document-attachments-${item.id}`}
          aria-label={`${item.title} 的附件`}
          className="mt-2 space-y-1"
        >
          {attachments.map((attachment) => (
            <AttachmentRow
              key={attachment.id}
              attachment={attachment}
              deleting={deletingAttachmentId === attachment.id}
              onDelete={onDeleteAttachment}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Documents() {
  const navigate = useNavigate();
  const goBack = useSmartBack('/dashboard');

  const [items, setItems] = useState<DocumentItem[]>([]);
  const [allItems, setAllItems] = useState<DocumentItem[]>([]);
  const [expiringCount, setExpiringCount] = useState(0);
  const [attachments, setAttachments] = useState<DocumentAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const [kind, setKind] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [searchInput, setSearchInput] = useState('');
  // （search 由 useDebouncedValue 派生，见下方）

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<DocumentForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [attachmentError, setAttachmentError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 明文号码只活在「显示」对话框里：关闭即清空，绝不进 store / storage / 日志。
  const [revealTarget, setRevealTarget] = useState<DocumentItem | null>(null);
  const [revealedNumber, setRevealedNumber] = useState<string | null>(null);
  const [revealError, setRevealError] = useState('');
  const [revealing, setRevealing] = useState(false);

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // v2.27 E-11：防抖统一走共享 hook（原手写 setTimeout 版已删）
  const search = useDebouncedValue(searchInput, 300);

  const loadFiltered = useCallback(async () => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (active) params.set('active', active);
    if (search.trim()) params.set('q', search.trim());
    params.set('limit', '200');
    const data = await api.get<DocumentItem[]>(`/documents?${params.toString()}`);
    setItems(Array.isArray(data) ? data : []);
  }, [kind, active, search]);

  const loadSummary = useCallback(async () => {
    try {
      const [all, expiring] = await Promise.all([
        api.get<DocumentItem[]>('/documents?limit=200'),
        api.get<DocumentItem[]>('/documents/expiring?days=90'),
      ]);
      setAllItems(Array.isArray(all) ? all : []);
      setExpiringCount(Array.isArray(expiring) ? expiring.length : 0);
    } catch {
      // 汇总失败绝不空屏或崩溃。
      setAllItems([]);
      setExpiringCount(0);
    }
  }, []);

  const loadAttachments = useCallback(async () => {
    const data = await api.get<DocumentAttachment[]>('/attachments?limit=200');
    setAttachments(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadFiltered()
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadFiltered]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadAttachments().catch(() => {
      // 附件列表失败不阻塞证件列表。
      setAttachments([]);
    });
  }, [loadAttachments]);

  const attachmentsByOwner = useMemo(() => {
    const map = new Map<number, DocumentAttachment[]>();
    for (const attachment of attachments) {
      if (attachment.owner_type !== UPLOAD_OWNER_TYPE || attachment.owner_id == null) continue;
      const list = map.get(attachment.owner_id) ?? [];
      list.push(attachment);
      map.set(attachment.owner_id, list);
    }
    return map;
  }, [attachments]);

  const groups = useMemo(() => {
    const order = DOCUMENT_KINDS as readonly string[];
    const map = new Map<string, DocumentItem[]>();
    for (const item of items) {
      const key = order.includes(item.kind) ? item.kind : 'other';
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [items]);

  const configuredCount = useMemo(
    () => allItems.filter((item) => item.numberConfigured).length,
    [allItems],
  );
  const overdueCount = useMemo(
    () => allItems.filter((item) => documentCountdown(item.expires_at, now).kind === 'overdue').length,
    [allItems, now],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldErrors({});
    setAttachmentError('');
    setOpen(true);
  };

  const openEdit = (item: DocumentItem) => {
    setEditingId(item.id);
    setForm(toForm(item));
    setFieldErrors({});
    setAttachmentError('');
    setOpen(true);
  };

  const closeEdit = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setAttachmentError('');
      setEditingId(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const save = async () => {
    setFieldErrors({});
    setSaving(true);
    try {
      if (editingId != null) {
        const payload = buildUpdatePayload(form);
        await api.patch<DocumentItem>(`/documents/${editingId}`, payload);
        setStatus('证件已更新');
      } else {
        const payload = buildCreatePayload(form);
        const parsed = createDocumentSchema.safeParse(payload);
        if (!parsed.success) {
          const nextErrors: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const key = String(issue.path[0] ?? 'form');
            if (!nextErrors[key]) nextErrors[key] = issue.message;
          }
          setFieldErrors(nextErrors);
          return;
        }
        await api.post<DocumentItem>('/documents', payload);
        setStatus('证件已创建');
      }
      closeEdit(false);
      await Promise.all([loadFiltered(), loadSummary()]);
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: DocumentItem) => {
    if (!window.confirm(`确定删除「${item.title}」？`)) return;
    setError('');
    try {
      await api.delete(`/documents/${item.id}`);
      setStatus(`已删除「${item.title}」`);
      await Promise.all([loadFiltered(), loadSummary(), loadAttachments()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const reveal = async (item: DocumentItem) => {
    setRevealTarget(item);
    setRevealedNumber(null);
    setRevealError('');
    setRevealing(true);
    try {
      // 一次性拉取明文；只留在对话框 state 里。
      const data = await api.get<{ number: string }>(`/documents/${item.id}/number`);
      setRevealedNumber(data?.number ?? '');
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setRevealing(false);
    }
  };

  const closeReveal = (next: boolean) => {
    if (!next) {
      // 关闭即抹掉明文。
      setRevealedNumber(null);
      setRevealError('');
      setRevealTarget(null);
    }
  };

  const processAttachment = async (file: File) => {
    setAttachmentError('');
    const id = editingId;
    if (id == null) {
      setAttachmentError('请先保存证件后再上传附件');
      return;
    }
    // 客户端预检：大小 + 白名单 + 魔数，必须在任何网络请求之前。
    const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    const validationError = validateAttachment({ name: file.name, type: file.type, size: file.size }, head);
    if (validationError) {
      setAttachmentError(validationError);
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const body: AttachmentUploadBody = {
        ownerType: UPLOAD_OWNER_TYPE,
        ownerId: id,
        filename: file.name,
        contentType: file.type as AttachmentContentType,
        dataBase64: base64PayloadFromDataUrl(dataUrl),
      };
      await api.post<DocumentAttachment>('/attachments', body);
      setStatus('附件已上传');
      await loadAttachments();
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAttachment = async (attachment: DocumentAttachment) => {
    setDeletingAttachmentId(attachment.id);
    setError('');
    try {
      await api.delete(`/attachments/${attachment.id}`);
      setStatus(`已删除附件「${attachment.filename}」`);
      await loadAttachments();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除附件失败');
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  const editingAttachments = editingId != null ? attachmentsByOwner.get(editingId) ?? [] : [];

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto" role="banner" aria-label="证件保险箱顶部导航">
        <div className="glass-panel rounded-full px-4 py-3 flex items-center gap-3 ring-1 ring-black/5 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={goBack} aria-label="返回上一页">
            <ArrowLeft size={20} aria-hidden />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">证件保险箱</h1>
            <p className="text-xs text-hint truncate">护照 · 身份证 · 驾照 · 签证 · 保单</p>
          </div>
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建证件">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        </div>
      </header>

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        <section aria-label="证件概览" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard testId="documents-summary-total" label="全部证件" value={allItems.length} hint="当前用户全部项" />
          <SummaryCard testId="documents-summary-configured" label="已配置号码" value={configuredCount} hint="号码加密保存" />
          <SummaryCard testId="documents-summary-expiring" label="临期" value={expiringCount} hint="90 天内（含已过期）" />
          <SummaryCard testId="documents-summary-overdue" label="已过期" value={overdueCount} hint="需尽快处理" tone="destructive" />
        </section>

        <section aria-label="筛选" className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="documents-filter-kind">类型</label>
              <Select id="documents-filter-kind" aria-label="类型筛选" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">全部类型</option>
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="documents-filter-active">状态</label>
              <Select id="documents-filter-active" aria-label="启用状态筛选" value={active} onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')}>
                <option value="">全部状态</option>
                <option value="true">仅启用</option>
                <option value="false">仅停用</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-hint mb-1 block" htmlFor="documents-filter-search">搜索</label>
              <Input
                id="documents-filter-search"
                aria-label="搜索名称或签发机构"
                placeholder="搜索名称 / 签发机构"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          </div>
        </section>

        {error && (
          <p className="text-sm text-destructive glass-panel rounded-2xl px-4 py-3" role="alert">{error}</p>
        )}
        {status && (
          <p className="text-sm text-hint glass-panel rounded-2xl px-4 py-3" role="status">{status}</p>
        )}

        {loading ? (
          <p className="text-hint text-sm" role="status">加载中…</p>
        ) : items.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-3xl">
            <ShieldCheck className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" aria-hidden />
            <p className="font-semibold text-slate-700 dark:text-slate-200">暂无证件</p>
            <p className="text-sm text-hint mt-1">集中保存护照、身份证、驾照与保单，到期前自动提醒</p>
            <Button className="mt-4 rounded-full" variant="outline" onClick={openCreate}>
              新建证件
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(([groupKind, groupItems]) => (
              <section
                key={groupKind}
                data-testid={`documents-group-${groupKind}`}
                aria-label={documentKindLabel(groupKind)}
                className="space-y-2"
              >
                <h2 className="text-sm font-bold px-1 text-hint">
                  {documentKindLabel(groupKind)} · {groupItems.length}
                </h2>
                {groupItems.map((item) => (
                  <DocumentRow
                    key={item.id}
                    item={item}
                    now={now}
                    attachments={attachmentsByOwner.get(item.id) ?? []}
                    onReveal={reveal}
                    onEdit={openEdit}
                    onDelete={remove}
                    deletingAttachmentId={deletingAttachmentId}
                    onDeleteAttachment={removeAttachment}
                  />
                ))}
              </section>
            ))}
          </div>
        )}

        <p className="text-[11px] text-hint text-center">
          <Paperclip className="w-3 h-3 inline-block mr-1" aria-hidden />
          共 {allItems.length} 项证件 · 附件上限 2 MB ·
          <button type="button" className="text-primary-600 dark:text-primary-400 underline mx-1" onClick={() => navigate('/dashboard')}>
            返回首页
          </button>
        </p>
      </main>

      <MobileBottomNav />

      {/* 编辑 / 上传对话框 */}
      <Dialog open={open} onOpenChange={closeEdit}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑证件' : '新建证件'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="document-title">名称 *</label>
              <Input
                id="document-title"
                aria-label="名称"
                placeholder="例如：中国护照"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              />
              {fieldErrors.title && <p className="text-xs text-destructive mt-1">{fieldErrors.title}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="document-kind">类型</label>
                <Select
                  id="document-kind"
                  aria-label="类型"
                  value={form.kind}
                  onChange={(e) => setForm((prev) => ({ ...prev, kind: e.target.value as DocumentKind }))}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="document-issuer">签发机构</label>
                <Input
                  id="document-issuer"
                  aria-label="签发机构"
                  placeholder="可选"
                  value={form.issuer}
                  onChange={(e) => setForm((prev) => ({ ...prev, issuer: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="document-number-input">证件号码</label>
              <Input
                id="document-number-input"
                aria-label="证件号码"
                placeholder={editingId != null ? '留空保持不变' : '可选，加密保存'}
                autoComplete="off"
                value={form.documentNumber}
                onChange={(e) => setForm((prev) => ({ ...prev, documentNumber: e.target.value }))}
              />
              <p className="text-[10px] text-hint mt-1">号码加密落库，列表只显示掩码，可随时点击「显示」查看一次。</p>
              {fieldErrors.documentNumber && <p className="text-xs text-destructive mt-1">{fieldErrors.documentNumber}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="document-issued">签发日期</label>
                <Input
                  id="document-issued"
                  aria-label="签发日期"
                  type="date"
                  value={form.issuedAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, issuedAt: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="document-expires">到期日</label>
                <Input
                  id="document-expires"
                  aria-label="到期日"
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, expiresAt: e.target.value }))}
                />
                {fieldErrors.expiresAt && <p className="text-xs text-destructive mt-1">{fieldErrors.expiresAt}</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="document-country">国家/地区</label>
                <Input
                  id="document-country"
                  aria-label="国家或地区"
                  placeholder="可选，例如 中国"
                  value={form.country}
                  onChange={(e) => setForm((prev) => ({ ...prev, country: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-sm mt-6">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={form.isActive}
                  onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                />
                启用
              </label>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="document-notes">备注</label>
              <textarea
                id="document-notes"
                aria-label="备注"
                className="w-full min-h-[72px] rounded-2xl border border-slate-300 dark:border-white/10 bg-white/70 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20"
                value={form.notes}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              />
            </div>

            {editingId != null && (
              <section aria-label="附件" className="space-y-2 rounded-2xl p-3 ring-1 ring-black/5 dark:ring-white/10">
                <p className="text-sm font-medium">附件（PDF / PNG / JPEG / WebP / TXT，单个 ≤ 2 MB）</p>
                <label
                  htmlFor="document-attachment-input"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0];
                    if (file) void processAttachment(file);
                  }}
                  className="flex flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-slate-300 dark:border-white/15 px-4 py-6 text-center cursor-pointer text-hint"
                >
                  <Upload className="w-5 h-5" aria-hidden />
                  <span className="text-xs">点击选择或拖拽文件到此处</span>
                </label>
                <input
                  ref={fileInputRef}
                  id="document-attachment-input"
                  data-testid="document-attachment-input"
                  type="file"
                  accept={ATTACHMENT_ACCEPT}
                  className="sr-only"
                  aria-label="选择附件文件"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void processAttachment(file);
                  }}
                />
                {uploading && <p className="text-xs text-hint" role="status">上传中…</p>}
                {attachmentError && (
                  <p data-testid="attachment-error" className="text-xs text-destructive" role="alert">
                    {attachmentError}
                  </p>
                )}
                {editingAttachments.length > 0 && (
                  <ul data-testid="attachment-upload-list" aria-label="已上传附件" className="space-y-1">
                    {editingAttachments.map((attachment) => (
                      <AttachmentRow
                        key={attachment.id}
                        attachment={attachment}
                        deleting={deletingAttachmentId === attachment.id}
                        onDelete={removeAttachment}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {fieldErrors.form && <p className="text-sm text-destructive">{fieldErrors.form}</p>}
            <Button className="w-full min-h-11" onClick={save} disabled={saving} aria-label="保存证件">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 一次性显示号码 */}
      <Dialog open={revealTarget !== null} onOpenChange={closeReveal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>证件号码</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-hint">
              {revealTarget?.title} · 仅此一次显示，关闭后即清除，不写入本地存储。
            </p>
            {revealing ? (
              <p className="text-sm text-hint" role="status">读取中…</p>
            ) : revealedNumber !== null ? (
              <p
                data-testid="revealed-number"
                className="font-mono text-lg tracking-widest text-slate-900 dark:text-slate-100 break-all"
              >
                {revealedNumber}
              </p>
            ) : (
              <p data-testid="reveal-error" className="text-sm text-destructive" role="alert">{revealError}</p>
            )}
            <Button className="w-full min-h-11" variant="outline" onClick={() => closeReveal(false)} aria-label="关闭号码显示">
              关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
