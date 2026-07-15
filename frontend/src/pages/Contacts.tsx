import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Trash2, UserPlus, CheckCircle2, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';

interface FixedContact {
  id: number;
  name: string;
  nickname?: string;
  email?: string;
  phone?: string;
  telegram_chat_id?: string;
  qq?: string;
  wxpusher_uid?: string;
  validation_status?: string;
}

const emptyForm = {
  name: '',
  nickname: '',
  email: '',
  phone: '',
  telegramChatId: '',
  qq: '',
  wxpusherUid: '',
};

export default function Contacts() {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<FixedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await api.get<FixedContact[]>('/contacts');
      setContacts(data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setError('');
    try {
      await api.post('/contacts', form);
      setOpen(false);
      setForm(emptyForm);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  };

  const remove = async (id: number) => {
    if (!confirm('确定删除该联系人？')) return;
    await api.delete(`/contacts/${id}`);
    await load();
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-3xl mx-auto pb-24">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/settings')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">固定联系人</h1>
          <p className="text-sm text-slate-500">快捷用于提醒与批量邮件</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="w-4 h-4 mr-1" /> 添加
        </Button>
      </div>

      {loading ? (
        <p className="text-slate-500">加载中…</p>
      ) : contacts.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <UserPlus className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p>暂无联系人，点击右上角添加</p>
        </div>
      ) : (
        <div className="space-y-3">
          {contacts.map((c) => (
            <div key={c.id} className="rounded-xl border bg-white/70 dark:bg-slate-900/70 p-4 flex gap-3 items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{c.name}</span>
                  {c.nickname && <span className="text-sm text-slate-500">({c.nickname})</span>}
                  {c.validation_status === 'valid' ? (
                    <Badge className="bg-green-100 text-green-700"><CheckCircle2 className="w-3 h-3 mr-1" />已验证</Badge>
                  ) : (
                    <Badge variant="outline"><AlertCircle className="w-3 h-3 mr-1" />待验证</Badge>
                  )}
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1 space-y-0.5">
                  {c.email && <div>📧 {c.email}</div>}
                  {c.phone && <div>📱 {c.phone}</div>}
                  {c.telegram_chat_id && <div>✈️ Telegram {c.telegram_chat_id}</div>}
                  {c.qq && <div>🐧 QQ {c.qq}</div>}
                  {c.wxpusher_uid && <div>💬 WxPusher {c.wxpusher_uid}</div>}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove(c.id)}>
                <Trash2 className="w-4 h-4 text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加固定联系人</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="姓名 *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="昵称" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
            <Input placeholder="邮箱" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="手机" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="Telegram Chat ID" value={form.telegramChatId} onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })} />
            <Input placeholder="QQ 号" value={form.qq} onChange={(e) => setForm({ ...form, qq: e.target.value })} />
            <Input placeholder="WxPusher UID" value={form.wxpusherUid} onChange={(e) => setForm({ ...form, wxpusherUid: e.target.value })} />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button className="w-full" onClick={save}>保存并验证</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
