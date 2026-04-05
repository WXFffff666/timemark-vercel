import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MessageCircle, Mail, Webhook, MessageSquare, AlertCircle, CheckCircle2, Link2Off, ArrowLeft, Plus, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { NotificationAccount } from '@timemark/shared';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 20, scale: 0.95 }, visible: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

type ChannelStatus = 'connected' | 'disconnected' | 'error';

interface Channel {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  status: ChannelStatus;
  enabled: boolean;
  lastSync?: string;
  errorMessage?: string;
  type?: string;
  webhook?: string;
  token?: string;
}

// Mock icons for different channel types
const getChannelIcon = (id: string) => {
  switch (id) {
    case 'wechat': return MessageCircle;
    case 'dingtalk': return MessageSquare;
    case 'email': return Mail;
    case 'webhook': return Webhook;
    case 'feishu': return MessageSquare;
    case 'telegram': return MessageCircle;
    case 'slack': return MessageSquare;
    default: return Webhook;
  }
};

export default function Channels() {
  const navigate = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [configForm, setConfigForm] = useState({ webhook: '', token: '', name: '' });

  useEffect(() => {
    fetchChannels();
  }, []);

  const fetchAccounts = async (): Promise<NotificationAccount[]> => {
    try {
      return await api.get<NotificationAccount[]>('/config/accounts');
    } catch {
      return [];
    }
  };

  const fetchChannels = async () => {
    setLoading(true);
    try {
      const accounts = await fetchAccounts();
      
      // Transform accounts to channels
      const channelList: Channel[] = accounts.map(account => ({
        id: account.id,
        name: account.name,
        description: `${account.type} 通知渠道`,
        icon: getChannelIcon(account.type),
        status: account.webhook ? 'connected' : 'disconnected',
        enabled: true,
        lastSync: '刚刚',
        type: account.type,
        webhook: account.webhook,
        token: account.token,
      }));

      // Add default channels if none exist
      if (channelList.length === 0) {
        channelList.push(
          { id: 'wechat', name: '微信公众号 (WeChat)', description: '绑定微信公众号，通过模板消息接收倒计时提醒。', icon: MessageCircle, status: 'disconnected', enabled: false },
          { id: 'dingtalk', name: '钉钉机器人 (DingTalk)', description: '接入钉钉群聊机器人，适合工作群组倒计时同步。', icon: MessageSquare, status: 'disconnected', enabled: false },
          { id: 'email', name: '电子邮件 (Email)', description: '通过SMTP服务发送重要节点提醒至您的邮箱。', icon: Mail, status: 'disconnected', enabled: false },
          { id: 'webhook', name: '自定义 Webhook', description: '向指定的URL发送POST请求，适用于自动化集成。', icon: Webhook, status: 'disconnected', enabled: false }
        );
      }
      
      setChannels(channelList);
    } catch (error) {
      console.error('Failed to fetch channels:', error);
      // Use default mock data on error
      setChannels([
        { id: 'wechat', name: '微信公众号 (WeChat)', description: '绑定微信公众号，通过模板消息接收倒计时提醒。', icon: MessageCircle, status: 'disconnected', enabled: false },
        { id: 'dingtalk', name: '钉钉机器人 (DingTalk)', description: '接入钉钉群聊机器人，适合工作群组倒计时同步。', icon: MessageSquare, status: 'disconnected', enabled: false },
        { id: 'email', name: '电子邮件 (Email)', description: '通过SMTP服务发送重要节点提醒至您的邮箱。', icon: Mail, status: 'disconnected', enabled: false },
        { id: 'webhook', name: '自定义 Webhook', description: '向指定的URL发送POST请求，适用于自动化集成。', icon: Webhook, status: 'disconnected', enabled: false }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const toggleChannel = async (id: string) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return;

    // Optimistic update
    setChannels(channels.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c));

    // If it's a saved account, update it
    if (channel.type) {
      try {
        await api.put(`/config/accounts/${id}`, { enabled: !channel.enabled });
      } catch (error) {
        console.error('Failed to toggle channel:', error);
        // Revert on error
        setChannels(channels.map(c => c.id === id ? { ...c, enabled: channel.enabled } : c));
      }
    }
  };

  const openConfig = (channel: Channel) => {
    setSelectedChannel(channel);
    setConfigForm({
      name: channel.name,
      webhook: channel.webhook || '',
      token: channel.token || '',
    });
    setShowConfigModal(true);
  };

  const saveConfig = async () => {
    if (!selectedChannel) return;

    try {
      const accountData = {
        name: configForm.name,
        type: selectedChannel.type || 'webhook',
        webhook: configForm.webhook,
        token: configForm.token,
        enabled: true,
      };

      if (selectedChannel.id && channels.find(c => c.id === selectedChannel.id && c.type)) {
        // Update existing
        await api.put(`/config/accounts/${selectedChannel.id}`, accountData);
      } else {
        // Create new
        await api.post('/config/accounts', accountData);
      }

      setShowConfigModal(false);
      fetchChannels();
    } catch (error) {
      console.error('Failed to save config:', error);
      alert('保存配置失败，请检查输入格式');
    }
  };

  const handleDisconnect = async (id: string) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return;

    try {
      await api.delete(`/config/accounts/${id}`);
      setChannels(channels.map(c => c.id === id ? { ...c, status: 'disconnected', enabled: false } : c));
    } catch (error) {
      console.error('Failed to disconnect:', error);
      // Still update UI locally
      setChannels(channels.map(c => c.id === id ? { ...c, status: 'disconnected', enabled: false } : c));
    }
  };

  const handleAddChannel = async () => {
    if (!configForm.name.trim() || !configForm.webhook.trim()) {
      alert('请填写渠道名称和Webhook地址');
      return;
    }

    try {
      await api.post('/config/accounts', {
        name: configForm.name,
        type: 'webhook',
        webhook: configForm.webhook,
        token: configForm.token,
        enabled: true,
      });
      setShowAddModal(false);
      setConfigForm({ name: '', webhook: '', token: '' });
      fetchChannels();
    } catch (error) {
      console.error('Failed to add channel:', error);
      alert('添加渠道失败');
    }
  };

  const getStatusDisplay = (status: ChannelStatus) => {
    switch (status) {
      case 'connected': return <Badge variant="success" className="gap-1.5 px-3 py-1"><CheckCircle2 size={14} /> 已连接</Badge>;
      case 'disconnected': return <Badge variant="secondary" className="gap-1.5 px-3 py-1"><Link2Off size={14} /> 未连接</Badge>;
      case 'error': return <Badge variant="destructive" className="gap-1.5 px-3 py-1"><AlertCircle size={14} /> 异常</Badge>;
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-[90rem] mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">通知渠道</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">配置您的提醒接收方式</p>
            </div>
          </div>
          <Button variant="vision" className="shadow-md shadow-primary-500/20 flex rounded-full px-5" onClick={() => { setConfigForm({ name: '', webhook: '', token: '' }); setShowAddModal(true); }}>
             <Plus size={16} className="mr-1.5"/> 添加渠道
          </Button>
        </div>
      </header>

      <main className="max-w-[90rem] mx-auto px-6 py-10 mt-2">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="glass-panel rounded-[2.5rem] p-7 animate-pulse h-48">
                <div className="h-6 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-2/3 mb-6"></div>
                <div className="h-14 bg-slate-200/60 dark:bg-slate-700/50 rounded-2xl w-full mb-4"></div>
                <div className="h-4 bg-slate-200/60 dark:bg-slate-700/50 rounded-full w-1/3"></div>
              </div>
            ))}
          </div>
        ) : (
          <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-6" variants={containerVariants} initial="hidden" animate="visible">
            {channels.map((channel) => {
              const Icon = channel.icon;
              return (
                <motion.div key={channel.id} variants={itemVariants}>
                  <div className={`relative glass-panel rounded-[2.5rem] p-7 overflow-hidden transition-all duration-300 ring-1 ${channel.enabled ? 'ring-primary-500/30 shadow-xl shadow-primary-500/5' : 'ring-black/5 dark:ring-white/10 opacity-90'}`}>
                    {/* 背景微光修饰 */}
                    {channel.enabled && channel.status === 'connected' && <div className="absolute -right-10 -top-10 w-32 h-32 bg-primary-500/10 rounded-full blur-3xl pointer-events-none"></div>}
                    {channel.status === 'error' && <div className="absolute -right-10 -top-10 w-32 h-32 bg-red-500/10 rounded-full blur-3xl pointer-events-none"></div>}
                    
                    <div className="flex justify-between items-start mb-6 relative z-10">
                      <div className="flex items-center gap-4">
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner ${channel.enabled ? 'bg-gradient-to-br from-primary-400 to-primary-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-400'}`}>
                          <Icon size={26} />
                        </div>
                        <div>
                          <h3 className="text-xl font-bold text-slate-900 dark:text-white">{channel.name}</h3>
                          <div className="mt-2">{getStatusDisplay(channel.status)}</div>
                        </div>
                      </div>
                      <Switch checked={channel.enabled} onCheckedChange={() => toggleChannel(channel.id)} />
                    </div>
                    <p className="text-slate-600 dark:text-slate-400 text-sm mb-6 leading-relaxed min-h-[40px] relative z-10">{channel.description}</p>
                    {channel.status === 'error' && channel.errorMessage && <div className="mb-6 p-3 rounded-xl bg-red-50/80 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 text-sm text-red-600 dark:text-red-400 font-mono relative z-10">{channel.errorMessage}</div>}
                    <div className="flex items-center justify-between pt-5 border-t border-slate-200/60 dark:border-slate-700/50 relative z-10">
                      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{channel.lastSync ? `最后同步: ${channel.lastSync}` : '尚未建立连接'}</div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" className="rounded-xl px-4" onClick={() => openConfig(channel)}>配置</Button>
                        {channel.status === 'connected' ? <Button variant="outline" size="sm" className="rounded-xl border-red-200 text-red-600 hover:bg-red-50 px-4" onClick={() => handleDisconnect(channel.id)}>断开</Button> : <Button variant="secondary" size="sm" className="rounded-xl px-4" onClick={() => openConfig(channel)}>授权</Button>}
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </main>

      {/* 添加渠道弹窗 */}
      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent className="glass-panel rounded-[2.5rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                <Plus size={20} />
              </div>
              添加自定义渠道
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">渠道名称</label>
              <Input 
                placeholder="例如：工作钉钉群" 
                value={configForm.name}
                onChange={(e) => setConfigForm({ ...configForm, name: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Webhook URL</label>
              <Input 
                placeholder="https://..." 
                value={configForm.webhook}
                onChange={(e) => setConfigForm({ ...configForm, webhook: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Token (可选)</label>
              <Input 
                placeholder="认证Token" 
                value={configForm.token}
                onChange={(e) => setConfigForm({ ...configForm, token: e.target.value })}
                className="h-12"
              />
            </div>
            <div className="pt-4 flex gap-3">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => setShowAddModal(false)}>取消</Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30" onClick={handleAddChannel}>保存配置</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 配置渠道弹窗 */}
      <Dialog open={showConfigModal} onOpenChange={setShowConfigModal}>
        <DialogContent className="glass-panel rounded-[2.5rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                <ExternalLink size={20} />
              </div>
              配置 {selectedChannel?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">渠道名称</label>
              <Input 
                value={configForm.name}
                onChange={(e) => setConfigForm({ ...configForm, name: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Webhook URL</label>
              <Input 
                placeholder="https://..." 
                value={configForm.webhook}
                onChange={(e) => setConfigForm({ ...configForm, webhook: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Token (可选)</label>
              <Input 
                placeholder="认证Token" 
                value={configForm.token}
                onChange={(e) => setConfigForm({ ...configForm, token: e.target.value })}
                className="h-12"
              />
            </div>
            <div className="pt-4 flex gap-3">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => setShowConfigModal(false)}>取消</Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30" onClick={saveConfig}>保存修改</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}