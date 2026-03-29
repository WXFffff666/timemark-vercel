import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { Plus, Trash2 } from 'lucide-react';
import type { NotificationAccount } from '@timemark/shared';

export function AccountSettings() {
  const [accounts, setAccounts] = useState<NotificationAccount[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<Partial<NotificationAccount>>({
    type: 'feishu',
    name: '',
  });

  const addAccount = () => {
    if (!formData.name || !formData.type) return;
    
    const newAccount: NotificationAccount = {
      id: Date.now().toString(),
      type: formData.type as any,
      name: formData.name,
      webhook: formData.webhook,
      token: formData.token,
      chatId: formData.chatId,
    };
    
    setAccounts([...accounts, newAccount]);
    setFormData({ type: 'feishu', name: '' });
    setShowForm(false);
  };

  const deleteAccount = (id: string) => {
    setAccounts(accounts.filter(a => a.id !== id));
  };

  const getTypeLabel = (type: string) => {
    const labels = {
      feishu: '🚀 飞书',
      dingtalk: '💼 钉钉',
      wecom: '💬 企业微信',
      telegram: '✈️ Telegram',
    };
    return labels[type as keyof typeof labels] || type;
  };

  return (
    <Card className="glass">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>通知账户管理</CardTitle>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="w-4 h-4 mr-1" />
            添加账户
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="p-4 rounded-lg glass border border-gray-200 dark:border-gray-700 space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">账户类型</label>
              <Select
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                className="h-10"
              >
                <option value="feishu">飞书</option>
                <option value="dingtalk">钉钉</option>
                <option value="wecom">企业微信</option>
                <option value="telegram">Telegram</option>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">账户名称</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="如：工作飞书、个人飞书"
                className="h-10"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Webhook URL</label>
              <Input
                value={formData.webhook || ''}
                onChange={(e) => setFormData({ ...formData, webhook: e.target.value })}
                placeholder="输入 Webhook 地址"
                className="h-10"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addAccount} disabled={!formData.name}>保存</Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">暂无账户，点击上方按钮添加</p>
          ) : (
            accounts.map(account => (
              <div key={account.id} className="flex items-center justify-between p-3 rounded-lg glass border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <Badge variant="secondary">{getTypeLabel(account.type)}</Badge>
                  <span className="font-medium">{account.name}</span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => deleteAccount(account.id)} className="text-red-500 hover:text-red-600">
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
