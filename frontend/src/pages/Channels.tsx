import { useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { MessageCircle, Mail, Webhook, MessageSquare, AlertCircle, CheckCircle2, Link2Off, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 20, scale: 0.95 }, visible: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 24 } } };
type ChannelStatus = 'connected' | 'disconnected' | 'error';
interface Channel { id: string; name: string; description: string; icon: React.ElementType; status: ChannelStatus; enabled: boolean; lastSync?: string; errorMessage?: string; }

export default function Channels() {
  const navigate = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([
    { id: 'wechat', name: '微信公众号 (WeChat)', description: '绑定微信公众号，通过模板消息接收倒计时提醒。', icon: MessageCircle, status: 'connected', enabled: true, lastSync: '刚刚' },
    { id: 'dingtalk', name: '钉钉机器人 (DingTalk)', description: '接入钉钉群聊机器人，适合工作群组倒计时同步。', icon: MessageSquare, status: 'disconnected', enabled: false },
    { id: 'email', name: '电子邮件 (Email)', description: '通过SMTP服务发送重要节点提醒至您的邮箱。', icon: Mail, status: 'connected', enabled: true, lastSync: '2小时前' },
    { id: 'webhook', name: '自定义 Webhook', description: '向指定的URL发送POST请求，适用于自动化集成。', icon: Webhook, status: 'error', enabled: true, errorMessage: 'HTTP 401 Unauthorized', lastSync: '昨天 14:30' }
  ]);

  const toggleChannel = (id: string) => setChannels(channels.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c));
  const getStatusDisplay = (status: ChannelStatus) => {
    switch (status) {
      case 'connected': return <Badge variant="success" className="gap-1.5 px-3 py-1"><CheckCircle2 size={14} /> 已连接</Badge>;
      case 'disconnected': return <Badge variant="secondary" className="gap-1.5 px-3 py-1"><Link2Off size={14} /> 未连接</Badge>;
      case 'error': return <Badge variant="destructive" className="gap-1.5 px-3 py-1"><AlertCircle size={14} /> 异常</Badge>;
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-4 z-50 px-4 max-w-7xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-4 flex justify-between items-center ring-1 ring-white/20 dark:ring-white/10">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">通知渠道管理</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">配置您的提醒接收方式</p>
            </div>
          </div>
          <Button variant="vision" className="shadow-lg shadow-primary-500/25 hidden sm:flex">添加自定义渠道</Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 mt-4">
        <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-6" variants={containerVariants} initial="hidden" animate="visible">
          {channels.map((channel) => {
            const Icon = channel.icon;
            return (
              <motion.div key={channel.id} variants={itemVariants}>
                <div className={`relative glass-panel rounded-3xl p-6 overflow-hidden transition-all duration-300 ring-1 ${channel.enabled ? 'ring-primary-500/30 shadow-lg shadow-primary-500/5' : 'ring-white/20 dark:ring-white/10 opacity-80'} hover:opacity-100`}>
                  {channel.enabled && channel.status === 'connected' && <div className="absolute -right-20 -top-20 w-40 h-40 bg-primary-500/10 rounded-full blur-3xl pointer-events-none"></div>}
                  {channel.status === 'error' && <div className="absolute -right-20 -top-20 w-40 h-40 bg-red-500/10 rounded-full blur-3xl pointer-events-none"></div>}
                  <div className="flex justify-between items-start mb-6 relative z-10">
                    <div className="flex items-center gap-4">
                      <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner ${channel.enabled ? 'bg-gradient-to-br from-primary-400 to-primary-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-500'}`}><Icon size={28} /></div>
                      <div><h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">{channel.name}</h3><div className="mt-1.5">{getStatusDisplay(channel.status)}</div></div>
                    </div>
                    <Switch checked={channel.enabled} onCheckedChange={() => toggleChannel(channel.id)} />
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 text-sm mb-6">{channel.description}</p>
                  {channel.status === 'error' && channel.errorMessage && <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 text-sm text-red-600 dark:text-red-400">{channel.errorMessage}</div>}
                  <div className="flex items-center justify-between pt-4 border-t border-slate-200/50 dark:border-slate-700/50">
                    <div className="text-xs text-slate-500 dark:text-slate-400">{channel.lastSync ? `最后同步: ${channel.lastSync}` : '尚未建立连接'}</div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" className="rounded-lg">配置</Button>
                      {channel.status === 'connected' ? <Button variant="outline" size="sm" className="rounded-lg border-red-200 text-red-600 hover:bg-red-50">断开</Button> : <Button variant="default" size="sm" className="rounded-lg">去授权</Button>}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </main>
    </motion.div>
  );
}
