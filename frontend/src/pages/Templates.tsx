import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Plus, Edit2, Trash2, Calendar, Save, X, Eye } from 'lucide-react';
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
  const [debouncedPreview, setDebouncedPreview] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Debounced preview update
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedPreview(previewTemplate(formData.template_content));
    }, 300);
    return () => clearTimeout(timer);
  }, [formData.template_content]);

  // Available template variables as clickable chips
  const templateVariables = [
    { key: '{{事件名}}', label: '事件名' },
    { key: '{{日期}}', label: '日期' },
    { key: '{{类型}}', label: '类型' },
    { key: '{{被提醒人}}', label: '被提醒人' },
    { key: '{{天数}}', label: '天数' },
    { key: '{{祝福语}}', label: '祝福语' },
    { key: '{{时间}}', label: '时间' },
  ];

  // Insert variable at cursor position in textarea
  const insertVariable = useCallback((variable: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setFormData(prev => ({ ...prev, template_content: prev.template_content + variable }));
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const content = formData.template_content;
    const newContent = content.substring(0, start) + variable + content.substring(end);
    setFormData(prev => ({ ...prev, template_content: newContent }));
    // Restore cursor position after insertion
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + variable.length;
    }, 0);
  }, [formData.template_content]);

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

  // 预览模板内容
  const previewTemplate = (content: string): string => {
    if (!content) return '';
    
    const sampleData: Record<string, string> = {
      '{{事件名}}': '妈妈生日',
      '{{日期}}': '2026-05-04',
      '{{类型}}': '生日',
      '{{被提醒人}}': '妈妈',
      '{{天数}}': '3',
      '{{祝福语}}': '生日快乐',
      '{{时间}}': '09:00',
      '{{event_name}}': '妈妈生日',
      '{{event_date}}': '2026-05-04',
      '{{event_type}}': '生日',
      '{{person_name}}': '妈妈',
      '{{days_until}}': '3',
      '{{blessing}}': '生日快乐',
      '{{reminder_time}}': '09:00',
    };
    
    let result = content;
    for (const [key, value] of Object.entries(sampleData)) {
      result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
    }
    return result;
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
                ref={textareaRef}
                placeholder="例如：妈妈的生日还有3天，记得准备礼物哦！"
                value={formData.template_content}
                onChange={(e) => setFormData({ ...formData, template_content: e.target.value })}
                className="w-full h-32 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              />
              
              {/* 可点击变量标签 */}
              <div className="mt-2 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">💡 点击插入变量（系统会自动替换）</p>
                <div className="flex flex-wrap gap-2">
                  {templateVariables.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => insertVariable(v.key)}
                      className="px-2.5 py-1 text-xs rounded-full bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-800/60 transition-colors cursor-pointer border border-primary-200 dark:border-primary-700"
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-400 mt-2">不写变量也行，直接写文字也可以！</p>
              </div>

              {/* 实时预览 */}
              {formData.template_content && (
                <div className="mt-3 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2 mb-2">
                    <Eye size={14} className="text-green-600 dark:text-green-400" />
                    <span className="text-xs font-semibold text-green-600 dark:text-green-400">预览效果</span>
                  </div>
                  <p className="text-sm text-green-700 dark:text-green-300 whitespace-pre-wrap">
                    {debouncedPreview}
                  </p>
                </div>
              )}
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
