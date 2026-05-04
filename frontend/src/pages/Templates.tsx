import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Plus, Edit2, Trash2, Calendar, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';

interface EventTemplate {
  id: number;
  event_type: string;
  template_content: string;
  created_at: string;
  updated_at: string;
}

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const itemVariants = { hidden: { opacity: 0, y: 20, scale: 0.95 }, visible: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

export default function Templates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<EventTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EventTemplate | null>(null);
  const [formData, setFormData] = useState({ event_type: '', template_content: '' });

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const data = await api.get<EventTemplate[]>('/config/templates');
      setTemplates(data || []);
    } catch (error) {
      console.error('Failed to load templates:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!formData.event_type.trim() || !formData.template_content.trim()) {
      alert('请填写事件类型和模板内容');
      return;
    }

    try {
      // POST with same event_type will update existing template
      await api.post('/config/templates', formData);
      setShowModal(false);
      setEditingTemplate(null);
      setFormData({ event_type: '', template_content: '' });
      loadTemplates();
    } catch (error) {
      console.error('Failed to save template:', error);
      alert('保存失败');
    }
  };

  const handleDelete = async (eventType: string) => {
    if (!confirm('确定要删除此模板吗？')) return;
    
    try {
      await api.delete(`/config/templates/${eventType}`);
      loadTemplates();
    } catch (error) {
      console.error('Failed to delete template:', error);
      alert('删除失败');
    }
  };

  const handleEdit = (template: EventTemplate) => {
    setEditingTemplate(template);
    setFormData({ event_type: template.event_type, template_content: template.template_content });
    setShowModal(true);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-3xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex items-center gap-4 ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </Button>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">事件模板</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">管理常用事件模板</p>
          </div>
          <Button 
            variant="vision" 
            className="ml-auto rounded-full px-5"
            onClick={() => { setEditingTemplate(null); setFormData({ event_type: '', template_content: '' }); setShowModal(true); }}
          >
            <Plus size={16} className="mr-1" />
            添加模板
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 mt-2">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-slate-300 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
              <Calendar className="w-10 h-10 text-slate-400" />
            </div>
            <h3 className="text-xl font-semibold text-slate-700 dark:text-slate-300 mb-2">暂无事件模板</h3>
            <p className="text-slate-500 dark:text-slate-400 mb-6 max-w-md mx-auto">
              创建常用事件模板，快速创建重复事件（如驾照到期、保险续费、会员续费等）
            </p>
            <Button 
              variant="vision" 
              className="rounded-full px-6"
              onClick={() => { setEditingTemplate(null); setFormData({ event_type: '', template_content: '' }); setShowModal(true); }}
            >
              <Plus size={16} className="mr-2" />
              创建第一个模板
            </Button>
          </div>
        ) : (
          <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-4">
            {templates.map(template => (
              <motion.div key={template.id} variants={itemVariants}>
                <div className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="secondary" className="text-xs">
                          {template.event_type}
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
                        {template.template_content}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(template)}>
                        <Edit2 size={14} />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-red-500" onClick={() => handleDelete(template.event_type)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>

      {/* 模板编辑弹窗 */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-w-lg rounded-[2rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white">
              {editingTemplate ? '编辑模板' : '添加模板'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                事件类型
              </label>
              <Input
                placeholder="例如：驾照到期、保险续费、会员续费"
                value={formData.event_type}
                onChange={(e) => setFormData({ ...formData, event_type: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                模板内容
              </label>
              <textarea
                placeholder="例如：妈妈的生日还有3天，记得准备礼物哦！"
                value={formData.template_content}
                onChange={(e) => setFormData({ ...formData, template_content: e.target.value })}
                className="w-full h-32 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              />
              <div className="mt-2 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">💡 智能变量（可选，系统会自动替换）</p>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-500">
                  <span><code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{'{{事件名}}'}</code> → 妈妈生日</span>
                  <span><code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{'{{日期}}'}</code> → 2026-05-04</span>
                  <span><code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{'{{类型}}'}</code> → 生日</span>
                  <span><code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{'{{被提醒人}}'}</code> → 妈妈</span>
                  <span><code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{'{{天数}}'}</code> → 3</span>
                  <span><code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">{'{{祝福语}}'}</code> → 生日快乐</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-2">不写变量也行，直接写文字也可以！</p>
              </div>
            </div>
            <div className="flex gap-3 pt-4">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => setShowModal(false)}>
                取消
              </Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold" onClick={handleSave}>
                <Save size={16} className="mr-2" />
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
