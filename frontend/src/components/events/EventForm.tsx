import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { CalendarClock, Type, AlignLeft, Globe } from 'lucide-react';

interface EventFormProps { open: boolean; onClose: () => void; onSubmit: (data: any) => Promise<void>; event?: any; }

export function EventForm({ open, onClose, onSubmit, event }: EventFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ title: '', targetTime: '', description: '', timezone: 'Asia/Shanghai' });

  useEffect(() => {
    if (event) {
      const date = new Date(event.targetTime);
      const tzOffset = date.getTimezoneOffset() * 60000;
      const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
      setFormData({ title: event.title || '', targetTime: localISOTime, description: event.description || '', timezone: event.timezone || 'Asia/Shanghai' });
    } else {
      setFormData({ title: '', targetTime: '', description: '', timezone: 'Asia/Shanghai' });
    }
  }, [event, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const submissionData = { ...formData, targetTime: new Date(formData.targetTime).toISOString() };
      await onSubmit(submissionData);
      onClose();
    } catch (error) { alert('保存失败，请检查输入格式'); } finally { setLoading(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-2xl">
            <div className="p-2 bg-primary-100 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
              <CalendarClock size={24} />
            </div>
            {event ? '编辑倒计时' : '创建新倒计时'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><Type size={16} /> 事件名称</label>
            <Input required placeholder="例如：产品发布会 / 纪念日" value={formData.title} onChange={e => setFormData({ ...formData, title: e.target.value })} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><CalendarClock size={16} /> 目标时间</label>
            <Input required type="datetime-local" value={formData.targetTime} onChange={e => setFormData({ ...formData, targetTime: e.target.value })} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><Globe size={16} /> 时区</label>
            <Select value={formData.timezone} onChange={e => setFormData({ ...formData, timezone: e.target.value })}>
              <option value="Asia/Shanghai">中国标准时间 (Asia/Shanghai)</option>
              <option value="UTC">协调世界时 (UTC)</option>
              <option value="America/New_York">美国东部时间 (America/New_York)</option>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><AlignLeft size={16} /> 备注描述</label>
            <textarea placeholder="添加详细信息..." value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} className="flex min-h-[100px] w-full rounded-2xl border border-white/20 dark:border-white/10 bg-white/40 dark:bg-black/20 px-4 py-3 text-sm backdrop-blur-md transition-all placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 focus-visible:bg-white/80 dark:focus-visible:bg-gray-900/80 shadow-inner resize-none" />
          </div>
          <div className="pt-4 flex gap-3">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>取消</Button>
            <Button type="submit" variant="vision" className="flex-1 shadow-lg shadow-primary-500/25" disabled={loading}>{loading ? '保存中...' : '确认保存'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
