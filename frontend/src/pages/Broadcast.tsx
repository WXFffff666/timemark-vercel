import { useState, useEffect } from 'react';
import { ArrowLeft, Send, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { BROADCAST_PRESET_TEMPLATES } from '@timemark/shared/templates';

interface Contact {
  id: number;
  name: string;
  email?: string;
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
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('<p>您好，</p><p>这是一条来自 TimeMark 的消息。</p>');
  const [totpCode, setTotpCode] = useState('');
  const [manualEmails, setManualEmails] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  useEffect(() => {
    api.get<Contact[]>('/contacts').then((d) => setContacts(d || [])).catch(() => {});
    api.get<EmailAccount[]>('/config/accounts').then((d) => {
      const email = (d || []).filter((a) => a.is_active !== false && ['resend', 'email', 'smtp'].includes(a.type));
      setEmailAccounts(email);
      if (email.length > 0) setAccountId(email[0].id);
    }).catch(() => {});
    api.get<Campaign[]>('/broadcast/campaigns').then((d) => setCampaigns(d || [])).catch(() => {});
  }, []);

  const toggleContact = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const send = async () => {
    setSending(true);
    setMessage('');
    try {
      const emails = manualEmails.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
      const result = await api.post<{
        recipientCount: number;
        successCount: number;
        failedCount: number;
        status: string;
      }>('/broadcast/email', {
        subject,
        html,
        contactIds: selectedIds.length ? selectedIds : undefined,
        recipientEmails: emails.length ? emails : undefined,
        accountId: accountId || undefined,
        totpCode: totpCode || undefined,
      });
      setMessage(`发送完成：${result.successCount}/${result.recipientCount} 成功，状态 ${result.status}`);
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
        <Button variant="ghost" size="icon" onClick={() => navigate('/settings')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Mail className="w-6 h-6" />批量邮件</h1>
          <p className="text-sm text-slate-500">选择通知渠道，向联系人快捷群发</p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border bg-white/70 dark:bg-slate-900/70 p-4">
        <div>
          <label className="text-sm font-medium">快速模板</label>
          <div className="flex flex-wrap gap-2 mt-2">
            {BROADCAST_PRESET_TEMPLATES.map((t) => (
              <Button key={t.id} variant="outline" size="sm" onClick={() => setHtml(t.content)}>
                {t.name}
              </Button>
            ))}
          </div>
        </div>
        {emailAccounts.length > 0 ? (
          <div>
            <label className="text-sm font-medium">通知渠道</label>
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
            请先在<a href="/channels" className="underline mx-1">通知渠道</a>配置 Resend 或 SMTP 邮件账号
          </p>
        )}
        <Input placeholder="邮件主题" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea
          className="w-full min-h-[120px] rounded-md border p-3 text-sm bg-transparent"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
        />
        <Input
          placeholder="手动邮箱（逗号分隔，可选）"
          value={manualEmails}
          onChange={(e) => setManualEmails(e.target.value)}
        />
        <Input
          placeholder="TOTP 验证码（已开启 2FA 时必填）"
          value={totpCode}
          onChange={(e) => setTotpCode(e.target.value)}
        />
        {contacts.filter((c) => c.email).length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">从固定联系人选择</p>
            <div className="flex flex-wrap gap-2">
              {contacts.filter((c) => c.email).map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant={selectedIds.includes(c.id) ? 'default' : 'outline'}
                  onClick={() => toggleContact(c.id)}
                  title={c.email}
                >
                  {c.name}
                  {(c.channel_account_ids?.length ?? 0) > 0 && ' ✓'}
                </Button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">带 ✓ 表示已绑定通知渠道</p>
          </div>
        )}
        <Button className="w-full" disabled={sending || !subject || !html || emailAccounts.length === 0} onClick={send}>
          <Send className="w-4 h-4 mr-2" />{sending ? '发送中…' : '发送'}
        </Button>
        {message && <p className="text-sm text-center text-slate-600">{message}</p>}
      </div>

      {campaigns.length > 0 && (
        <div className="mt-8">
          <h2 className="font-semibold mb-3">发送记录</h2>
          <div className="space-y-2">
            {campaigns.map((c) => (
              <div key={c.id} className="text-sm rounded-lg border p-3 flex justify-between">
                <span>{c.subject}</span>
                <span className="text-slate-500">{c.success_count}/{c.recipient_count} · {c.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
