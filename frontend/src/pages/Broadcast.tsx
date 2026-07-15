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
          <p className="text-sm text-slate-500">基于 Resend 账户，每批最多 100 封</p>
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
        {contacts.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">从固定联系人选择（有邮箱的）</p>
            <div className="flex flex-wrap gap-2">
              {contacts.filter((c) => c.email).map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant={selectedIds.includes(c.id) ? 'default' : 'outline'}
                  onClick={() => toggleContact(c.id)}
                >
                  {c.name}
                </Button>
              ))}
            </div>
          </div>
        )}
        <Button className="w-full" disabled={sending || !subject || !html} onClick={send}>
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
