import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { NotificationAccount } from '@timemark/shared';

interface NotificationAccountResponse {
  id: number;
  user_id: number;
  type: string;
  name: string;
  webhook: string | null;
  token: string | null;
  secret: string | null;
  chat_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function AccountSettings() {
  const [accounts, setAccounts] = useState<NotificationAccountResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<Partial<NotificationAccountResponse>>({
    type: 'feishu',
    name: '',
  });

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const data = await api.get<NotificationAccountResponse[]>('/config/accounts');
      setAccounts(data);
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const addAccount = async () => {
    if (!formData.name || !formData.type) return;
    
    try {
      const newAccount = await api.post<NotificationAccountResponse>('/config/accounts', {
        type: formData.type,
        name: formData.name,
        webhook: formData.webhook,
        token: formData.token,
        secret: formData.secret,
        chatId: formData.chat_id,
      });
      
      setAccounts([...accounts, newAccount]);
      setFormData({ type: 'feishu', name: '' });
      setShowForm(false);
    } catch (error) {
      console.error('Failed to add account:', error);
    }
  };

  const deleteAccount = async (id: number) => {
    try {
      await api.delete(`/config/accounts/${id}`);
      setAccounts(accounts.filter(a => a.id !== id));
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
  };

  const getTypeLabel = (type: string) => {
    const labels = {
      feishu: '🚀 Feishu',
      dingtalk: '💼 DingTalk',
      wecom: '💬 企业微信',
      telegram: '✈️ Telegram',
      slack: '💬 Slack',
      discord: '🎮 Discord',
      google_chat: '💼 Google Chat',
      microsoft_teams: '👥 Microsoft Teams',
      mattermost: '🧩 Mattermost',
      matrix: '🔷 Matrix',
      line: '🟩 LINE',
      nextcloud_talk: '☁️ Nextcloud Talk',
      irc: '🧵 IRC',
      signal: '🔒 Signal',
      whatsapp: '🟢 WhatsApp',
      imessage: '💙 iMessage',
      bluebubbles: '🔵 BlueBubbles',
      nostr: '⚡ Nostr',
      synology_chat: '🗂️ Synology Chat',
      tlon: '🌐 Tlon',
      twitch: '🟣 Twitch',
      zalo: '🇻🇳 Zalo',
      zalo_personal: '🇻🇳 Zalo Personal',
      wechat: '🟢 微信(WxPusher)',
      qq: '🐧 QQ(Qmsg)',
      network_chat: '🌍 网络聊天',
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
                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                className="h-10"
              >
                <option value="feishu">Feishu</option>
                <option value="dingtalk">DingTalk</option>
                <option value="wecom">企业微信</option>
                <option value="telegram">Telegram</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="google_chat">Google Chat</option>
                <option value="microsoft_teams">Microsoft Teams</option>
                <option value="mattermost">Mattermost</option>
                <option value="matrix">Matrix</option>
                <option value="line">LINE</option>
                <option value="nextcloud_talk">Nextcloud Talk</option>
                <option value="irc">IRC</option>
                <option value="signal">Signal</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="imessage">iMessage</option>
                <option value="bluebubbles">BlueBubbles</option>
                <option value="nostr">Nostr</option>
                <option value="synology_chat">Synology Chat</option>
                <option value="tlon">Tlon</option>
                <option value="twitch">Twitch</option>
                <option value="zalo">Zalo</option>
                <option value="zalo_personal">Zalo Personal</option>
                <option value="wechat">微信(WxPusher)</option>
                <option value="qq">QQ(Qmsg)</option>
                <option value="network_chat">网络聊天</option>
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
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">暂无账户，点击上方按钮添加</p>
          ) : (
            accounts.map(account => (
              <div key={account.id} className="flex items-center justify-between p-3 rounded-lg glass border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <Badge variant="secondary">{getTypeLabel(account.type)}</Badge>
                  <span className="font-medium">{account.name}</span>
                  {!account.is_active && <Badge variant="destructive">已禁用</Badge>}
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
