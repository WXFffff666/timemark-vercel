import { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, Send, Mail, ChevronRight, Eye, Users } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSmartBack } from '@/hooks/useSmartBack';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import {
  BROADCAST_TEMPLATE_CATEGORIES,
  buildBroadcastEmail,
  type BroadcastTemplateCategory,
} from '@timemark/shared';
import { contactHasAnyEmail, getContactEmailList } from '@/lib/contact-utils';
import { sanitizeHtmlPreview } from '@timemark/shared';
import type { ContactLabeledEntry } from '@timemark/shared';

interface Contact {
  id: number;
  name: string;
  email?: string;
  emails?: ContactLabeledEntry[];
  channel_account_ids?: number[];
}

interface EmailAccount {
  id: number;
  name: string;
  type: string;
  is_active?: boolean;
}

interface Campaign {
  id: number;
  subject: string;
  recipient_count: number;
  success_count: number;
  failed_count: number;
  status: string;
  created_at: string;
}

export default function Broadcast() {
  const navigate = useNavigate();
  const goBack = useSmartBack('/dashboard');
  // v2.26 C：联系人页「快捷发信」深链进来（/broadcast?contact=<id>），预选该联系人。
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkContactId = Number(searchParams.get('contact') ?? '') || null;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [manualEmails, setManualEmails] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  // v2.30：发送确认闸门（群发是真发出去的邮件，点一下就该出去太危险）+ 服务端渲染预览
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlPreview: string } | null>(null);

  const [activeCategory, setActiveCategory] = useState<BroadcastTemplateCategory | null>(null);
  const [selectedGreetingId, setSelectedGreetingId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const contactsWithEmail = useMemo(
    () => contacts.filter((c) => contactHasAnyEmail(c)),
    [contacts],
  );

  const recipientCount = useMemo(() => {
    const manual = manualEmails.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes('@'));
    const fromContacts = contactsWithEmail
      .filter((c) => selectedIds.includes(c.id))
      .flatMap((c) => getContactEmailList(c));
    return new Set([...manual, ...fromContacts]).size;
  }, [manualEmails, selectedIds, contactsWithEmail]);

  useEffect(() => {
    api.get<Contact[]>('/contacts').then((d) => setContacts(d || [])).catch(() => {});
    api.get<EmailAccount[]>('/config/accounts').then((d) => {
      const email = (d || []).filter((a) => a.is_active !== false && ['resend', 'email', 'smtp'].includes(a.type));
      setEmailAccounts(email);
      if (email.length > 0) setAccountId(email[0].id);
    }).catch(() => {});
    api.get<Campaign[]>('/broadcast/campaigns').then((d) => setCampaigns(d || [])).catch(() => {});
  }, []);

  // 深链预选：联系人列表就绪后勾上目标联系人并消费掉 query，刷新/后退不再残留。
  useEffect(() => {
    if (deepLinkContactId === null || contacts.length === 0) return;
    const target = contacts.find((c) => c.id === deepLinkContactId);
    if (target && contactHasAnyEmail(target)) {
      setSelectedIds((prev) => (prev.includes(target.id) ? prev : [...prev, target.id]));
    }
    setSearchParams({}, { replace: true });
  }, [deepLinkContactId, contacts, setSearchParams]);

  const applyTemplate = (category: BroadcastTemplateCategory, greetingId: string) => {
    const built = buildBroadcastEmail(category, greetingId, subject || category.defaultSubject);
    setSubject(built.subject);
    setHtml(built.html);
    setActiveCategory(category);
    setSelectedGreetingId(greetingId);
    setShowPreview(false);
  };

  const toggleContact = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectAllContacts = () => {
    setSelectedIds(contactsWithEmail.map((c) => c.id));
  };

  const send = async () => {
    if (!subject.trim() || !html.trim()) {
      setMessage('请填写主题和正文');
      return;
    }
    if (emailAccounts.length === 0) {
      setMessage('请先配置邮件通知渠道');
      return;
    }
    const emails = manualEmails.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes('@'));
    if (selectedIds.length === 0 && emails.length === 0) {
      setMessage('请选择联系人或填写手动邮箱');
      return;
    }

    // v2.30：先出确认框——拉服务端预览（占位符已替换、HTML 已消毒），
    // 用户看到真实效果并确认后才真正发送。
    setPreviewData(null);
    setConfirmOpen(true);
    try {
      const preview = await api.post<{ subject: string; htmlPreview: string }>('/broadcast/preview', {
        subject: subject.trim(),
        html,
      });
      setPreviewData(preview);
    } catch {
      // 预览失败不阻塞确认（用户仍可按已有正文判断），但给出提示
      setPreviewData(null);
    }
  };

  const sendConfirmed = async () => {
    setConfirmOpen(false);
    if (!subject.trim() || !html.trim()) {
      setMessage('请填写主题和正文');
      return;
    }
    const emails = manualEmails.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes('@'));
    if (selectedIds.length === 0 && emails.length === 0) {
      setMessage('请选择联系人或填写手动邮箱');
      return;
    }

    setSending(true);
    setMessage('');
    try {
      const result = await api.post<{
        recipientCount: number;
        successCount: number;
        failedCount: number;
        status: string;
        errors?: string[];
      }>('/broadcast/email', {
        subject: subject.trim(),
        html,
        contactIds: selectedIds.length ? selectedIds : undefined,
        recipientEmails: emails.length ? emails : undefined,
        accountId: accountId || undefined,
        totpCode: totpCode || undefined,
      });
      const errHint = result.errors?.length ? `\n失败原因：${result.errors.slice(0, 3).join('；')}` : '';
      setMessage(`发送完成：${result.successCount}/${result.recipientCount} 成功，状态 ${result.status}${errHint}`);
      const list = await api.get<Campaign[]>('/broadcast/campaigns');
      setCampaigns(list || []);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={goBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Mail className="w-6 h-6" />批量邮件</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">选模板 → 选问候语 → 选收件人 → 发送</p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border bg-white/70 dark:bg-slate-900/70 p-4">
        {/* 一级：模板分类 */}
        <div>
          <label className="text-sm font-medium">1. 选择模板类型</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
            {BROADCAST_TEMPLATE_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setActiveCategory(cat);
                  setSelectedGreetingId(null);
                  if (!subject) setSubject(cat.defaultSubject);
                }}
                className={`text-left rounded-lg border p-3 transition hover:border-primary-400 ${
                  activeCategory?.id === cat.id
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 ring-1 ring-primary-400'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <span className="text-lg">{cat.emoji}</span>
                <p className="text-sm font-medium mt-1">{cat.name}</p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2">{cat.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* 二级：问候语变体 */}
        {activeCategory && (
          <div className="rounded-lg border border-primary-200 dark:border-primary-800 bg-primary-50/50 dark:bg-primary-950/30 p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-1">
              <ChevronRight className="w-4 h-4" />
              2. 选择问候语风格 · {activeCategory.name}
            </p>
            <div className="flex flex-wrap gap-2">
              {activeCategory.greetingVariants.map((v) => (
                <Button
                  key={v.id}
                  size="sm"
                  variant={selectedGreetingId === v.id ? 'default' : 'outline'}
                  onClick={() => applyTemplate(activeCategory, v.id)}
                >
                  {v.name}
                </Button>
              ))}
            </div>
            {selectedGreetingId && (
              <p className="text-xs text-green-600 dark:text-green-400">已应用模板，可继续编辑主题与正文</p>
            )}
          </div>
        )}

        {emailAccounts.length > 0 ? (
          <div>
            <label className="text-sm font-medium">3. 通知渠道</label>
            <select
              className="w-full mt-1 rounded-md border p-2 text-sm bg-transparent"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}
            >
              {emailAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type === 'smtp' ? 'SMTP' : 'Resend'})
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-sm text-amber-600">
            请先在<button type="button" className="underline mx-1" onClick={() => navigate('/channels')}>通知渠道</button>配置 Resend 或 SMTP 邮件账号
          </p>
        )}

        <div>
          <label className="text-sm font-medium">邮件主题</label>
          <Input className="mt-1" placeholder="邮件主题" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium">邮件正文（HTML）</label>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowPreview((p) => !p)}>
              <Eye className="w-3 h-3 mr-1" />{showPreview ? '编辑' : '预览'}
            </Button>
          </div>
          {showPreview ? (
            <div
              className="w-full min-h-[160px] rounded-md border p-4 text-sm bg-white dark:bg-slate-950 prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: sanitizeHtmlPreview(html) || '<p class="text-slate-400">暂无内容</p>' }}
            />
          ) : (
            <textarea
              className="w-full min-h-[160px] rounded-md border p-3 text-sm bg-transparent font-mono text-xs"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="支持 {{contact_name}} 变量，发送时自动替换为联系人姓名"
            />
          )}
          <p className="text-[10px] text-slate-400 mt-1">变量：<code>{'{{contact_name}}'}</code> 收件人姓名 · 预览中显示为「张三」示例</p>
        </div>

        <Input
          placeholder="手动邮箱（逗号/空格分隔，可选）"
          value={manualEmails}
          onChange={(e) => setManualEmails(e.target.value)}
        />

        {contactsWithEmail.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">4. 从固定联系人选择</p>
              <Button type="button" variant="ghost" size="sm" onClick={selectAllContacts}>
                <Users className="w-3 h-3 mr-1" />全选
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {contactsWithEmail.map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant={selectedIds.includes(c.id) ? 'default' : 'outline'}
                  onClick={() => toggleContact(c.id)}
                  title={getContactEmailList(c).join('、')}
                >
                  {c.name}
                  {(c.channel_account_ids?.length ?? 0) > 0 && ' ✓'}
                </Button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              已选 {selectedIds.length} 人 · 预计收件 {recipientCount} 个邮箱
              {recipientCount > 10 && ' · 超过 10 人需开启双因素认证'}
            </p>
          </div>
        )}

        <Input
          placeholder="TOTP 验证码（已开启 2FA 或大批量发送时必填）"
          value={totpCode}
          onChange={(e) => setTotpCode(e.target.value)}
        />

        <Button
          className="w-full"
          disabled={sending || !subject.trim() || !html.trim() || emailAccounts.length === 0}
          onClick={send}
        >
          <Send className="w-4 h-4 mr-2" />
          {sending ? '发送中…' : `发送${recipientCount > 0 ? `（${recipientCount} 人）` : ''}`}
        </Button>

        {/* v2.30：发送确认对话框——预览真实渲染效果 + 明确的收件规模警示 */}
        {confirmOpen && (
          <div role="dialog" aria-modal="true" aria-label="确认批量发送" className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="glass-panel rounded-3xl p-6 max-w-lg w-full ring-1 ring-black/10 dark:ring-white/10 max-h-[85vh] overflow-y-auto">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">确认批量发送？</h3>
              <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
                将向 <strong className="text-red-600">{recipientCount}</strong> 个邮箱真实发送邮件（每小时最多 10 次）。
                邮件发出后无法撤回，请确认内容无误。
              </p>
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 mb-4 bg-white dark:bg-slate-800/60">
                <p className="text-xs font-semibold text-slate-500 mb-1">主题预览</p>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  {previewData?.subject ?? subject.trim()}
                </p>
                {previewData?.htmlPreview && (
                  <>
                    <p className="text-xs font-semibold text-slate-500 mt-3 mb-1">正文预览（前 2000 字符，占位符已替换）</p>
                    <div
                      className="text-xs text-slate-600 dark:text-slate-300 max-h-40 overflow-y-auto [&_a]:text-blue-600"
                      // htmlPreview 由服务端 sanitizeHtmlPreview 消毒后返回
                      dangerouslySetInnerHTML={{ __html: previewData.htmlPreview }}
                    />
                  </>
                )}
                {!previewData && <p className="text-xs text-slate-400 mt-2">预览加载失败，可关闭后按已有正文判断。</p>}
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setConfirmOpen(false)}>再检查一下</Button>
                <Button variant="destructive" onClick={sendConfirmed}>确认发送（{recipientCount} 人）</Button>
              </div>
            </div>
          </div>
        )}

        {message && (
          <p className={`text-sm text-center whitespace-pre-wrap ${message.includes('失败') || message.includes('0/') ? 'text-red-600' : 'text-slate-600 dark:text-slate-400'}`}>
            {message}
          </p>
        )}
      </div>

      {campaigns.length > 0 ? (
        <div className="mt-8">
          <h2 className="font-semibold mb-3">发送记录</h2>
          <div className="space-y-2">
            {campaigns.map((c) => (
              <div key={c.id} className="text-sm rounded-lg border p-3 flex justify-between gap-2">
                <span className="truncate">{c.subject}</span>
                <span className="text-slate-500 dark:text-slate-400 shrink-0">{c.success_count}/{c.recipient_count} · {c.status}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-6 text-center text-sm text-slate-400">暂无批量发送记录，成功发送后会显示在页面底部</p>
      )}
    </div>
  );
}
