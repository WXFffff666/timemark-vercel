import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../hooks/use-toast';

interface RelationshipMapping {
  id: number;
  user_id: number;
  event_id: number;
  from_relation: string;
  to_relation: string;
  recipient_email?: string;
  recipient_type?: string;
  created_at: string;
  updated_at: string;
}

interface Event {
  id: number;
  name: string;
}

// 预设关系类型
const PRESET_RELATIONS = [
  { value: 'me', label: '我本人' },
  { value: 'father', label: '父亲' },
  { value: 'mother', label: '母亲' },
  { value: 'wife', label: '妻子' },
  { value: 'husband', label: '丈夫' },
  { value: 'son', label: '儿子' },
  { value: 'daughter', label: '女儿' },
  { value: 'brother', label: '兄弟' },
  { value: 'sister', label: '姐妹' },
  { value: 'friend', label: '朋友' },
  { value: 'colleague', label: '同事' },
];

export function RelationshipSettings() {
  const { toast } = useToast();
  const [mappings, setMappings] = useState<RelationshipMapping[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    eventId: '',
    fromRelation: '我妈',
    toRelation: '母亲',
    recipientEmail: '',
    recipientType: '',
  });

  useEffect(() => {
    loadMappings();
    loadEvents();
  }, []);

  const loadMappings = async () => {
    try {
      const data = await api.get<RelationshipMapping[]>('/config/relationships');
      setMappings(data);
    } catch (error) {
      console.error('Failed to load mappings:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadEvents = async () => {
    try {
      const data = await api.get<Event[]>('/events');
      setEvents(data);
    } catch (error) {
      console.error('Failed to load events:', error);
    }
  };

  const addMapping = async () => {
    if (!formData.eventId || !formData.fromRelation || !formData.toRelation) {
      toast({ title: '请填写完整信息', variant: 'destructive' });
      return;
    }
    
    try {
      const newMapping = await api.post<RelationshipMapping>('/config/relationships', {
        event_id: parseInt(formData.eventId),
        from_relation: formData.fromRelation,
        to_relation: formData.toRelation,
        recipient_email: formData.recipientEmail || undefined,
        recipient_type: formData.recipientType || undefined,
      });
      
      setMappings([...mappings, newMapping]);
      setFormData({ eventId: '', fromRelation: '我妈', toRelation: '母亲', recipientEmail: '', recipientType: '' });
      setShowForm(false);
      toast({ title: '关系映射已添加' });
    } catch (error) {
      console.error('Failed to add mapping:', error);
      toast({ title: '添加失败', variant: 'destructive' });
    }
  };

  const deleteMapping = async (id: number) => {
    try {
      await api.delete(`/config/relationships/${id}`);
      setMappings(mappings.filter(m => m.id !== id));
      toast({ title: '关系映射已删除' });
    } catch (error) {
      console.error('Failed to delete mapping:', error);
      toast({ title: '删除失败', variant: 'destructive' });
    }
  };

  const getEventName = (eventId: number) => {
    const event = events.find(e => e.id === eventId);
    return event?.name || `事件 #${eventId}`;
  };

  return (
    <Card className="glass">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>关系映射设置</CardTitle>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="w-4 h-4 mr-1" />
            添加映射
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="p-4 rounded-lg glass border border-slate-200 dark:border-slate-700 space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">选择事件</label>
              <Select
                value={formData.eventId}
                onChange={(e) => setFormData({ ...formData, eventId: e.target.value })}
                className="h-10"
              >
                <option value="">请选择事件</option>
                {events.map(event => (
                  <option key={event.id} value={event.id}>{event.name}</option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">原始称呼</label>
                <Input
                  value={formData.fromRelation}
                  onChange={(e) => setFormData({ ...formData, fromRelation: e.target.value })}
                  placeholder="如：我妈、老婆"
                  className="h-10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">转换后称呼</label>
                <Input
                  value={formData.toRelation}
                  onChange={(e) => setFormData({ ...formData, toRelation: e.target.value })}
                  placeholder="如：母亲、妻子"
                  className="h-10"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">收件人邮箱（可选）</label>
                <Input
                  value={formData.recipientEmail}
                  onChange={(e) => setFormData({ ...formData, recipientEmail: e.target.value })}
                  placeholder="用于邮件区分"
                  className="h-10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">收件人类型（可选）</label>
                <Select
                  value={formData.recipientType}
                  onChange={(e) => setFormData({ ...formData, recipientType: e.target.value })}
                  className="h-10"
                >
                  <option value="">不限定</option>
                  {PRESET_RELATIONS.map(rel => (
                    <option key={rel.value} value={rel.value}>{rel.label}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addMapping} disabled={!formData.eventId}>保存</Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : mappings.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              暂无关系映射<br />
              <span className="text-xs">例如："我妈" → "妻子"</span>
            </p>
          ) : (
            mappings.map(mapping => (
              <div key={mapping.id} className="flex items-center justify-between p-3 rounded-lg glass border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-3">
                  <span className="font-medium">{mapping.from_relation}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-medium text-primary-500">{mapping.to_relation}</span>
                  <Badge variant="outline">{getEventName(mapping.event_id)}</Badge>
                  {mapping.recipient_email && (
                    <Badge variant="secondary">{mapping.recipient_email}</Badge>
                  )}
                </div>
                <Button size="sm" variant="ghost" onClick={() => deleteMapping(mapping.id)} className="text-red-500 hover:text-red-600">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
