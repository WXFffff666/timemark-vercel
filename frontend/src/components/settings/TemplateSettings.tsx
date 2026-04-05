import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Plus, Trash2 } from 'lucide-react';
import type { RelationshipMapping } from '@timemark/shared';

export function TemplateSettings() {
  const [mappings, setMappings] = useState<RelationshipMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [fromRelation, setFromRelation] = useState('');
  const [toRelation, setToRelation] = useState('');

  const addMapping = () => {
    if (!fromRelation || !toRelation) return;
    
    const newMapping: RelationshipMapping = {
      id: Date.now().toString(),
      fromRelation,
      toRelation,
    };
    
    setMappings([...mappings, newMapping]);
    setFromRelation('');
    setToRelation('');
    setShowForm(false);
  };

  const deleteMapping = (id: string) => {
    setMappings(mappings.filter(m => m.id !== id));
  };

  return (
    <Card className="glass">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>关系映射配置</CardTitle>
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
              <label className="block text-sm font-medium mb-1.5">事件对象关系</label>
              <Input
                value={fromRelation}
                onChange={(e) => setFromRelation(e.target.value)}
                placeholder="如：我妈"
                className="h-10"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">转换为（提醒对象）</label>
              <Input
                value={toRelation}
                onChange={(e) => setToRelation(e.target.value)}
                placeholder="如：妻子"
                className="h-10"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addMapping} disabled={!fromRelation || !toRelation}>保存</Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {mappings.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">暂无映射，点击上方按钮添加</p>
          ) : (
            mappings.map(mapping => (
              <div key={mapping.id} className="flex items-center justify-between p-3 rounded-lg glass border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{mapping.fromRelation}</Badge>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="secondary">{mapping.toRelation}</Badge>
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
