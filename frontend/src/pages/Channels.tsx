import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { api } from '../lib/api';

type ConfigState = Record<string, any>;

const webhookBridgeChannels = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'google_chat', label: 'Google Chat' },
  { key: 'signal', label: 'Signal' },
  { key: 'imessage', label: 'iMessage' },
  { key: 'bluebubbles', label: 'BlueBubbles' },
  { key: 'irc', label: 'IRC' },
  { key: 'microsoft_teams', label: 'Microsoft Teams' },
  { key: 'matrix', label: 'Matrix' },
  { key: 'line', label: 'LINE' },
  { key: 'mattermost', label: 'Mattermost' },
  { key: 'nextcloud_talk', label: 'Nextcloud Talk' },
  { key: 'nostr', label: 'Nostr' },
  { key: 'synology_chat', label: 'Synology Chat' },
  { key: 'tlon', label: 'Tlon' },
  { key: 'twitch', label: 'Twitch' },
  { key: 'zalo', label: 'Zalo' },
  { key: 'zalo_personal', label: 'Zalo Personal' },
  { key: 'network_chat', label: '网络聊天' },
];

export default function Channels() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<ConfigState>({ channel_webhooks: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const data = await api.get<ConfigState>('/config');
      setConfig({ ...data, channel_webhooks: data?.channel_webhooks || {} });
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      setLoading(false);
    }
  };

  const channelStatus = useMemo(() => ([
    { name: 'Feishu', configured: !!config.feishu_webhook },
    { name: '企业微信', configured: !!config.wecom_webhook },
    { name: 'DingTalk', configured: !!config.dingtalk_webhook },
    { name: 'Telegram', configured: !!config.telegram_bot_token && !!config.telegram_chat_id },
    { name: 'Slack', configured: !!config.slack_webhook },
    { name: 'Discord', configured: !!config.discord_webhook },
    { name: '微信(WxPusher)', configured: !!config.wxpusher_app_token && !!config.wxpusher_uid },
    { name: 'QQ(Qmsg)', configured: !!config.qmsg_key },
    ...webhookBridgeChannels.map((ch) => ({ name: ch.label, configured: !!config.channel_webhooks?.[ch.key] })),
  ]), [config]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      await api.post('/config', config);
      await fetchConfig();
      alert('渠道配置已保存');
    } catch (error) {
      console.error(error);
      alert('保存失败，请检查输入');
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const updateBridgeWebhook = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, channel_webhooks: { ...(prev.channel_webhooks || {}), [key]: value } }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 dark:from-dark-bg dark:via-slate-900 dark:to-dark-bg">
      <header className="glass sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate('/dashboard')} className="w-10 h-10 p-0">←</Button>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">通知渠道配置</h1>
          <Button className="ml-auto" onClick={saveConfig} disabled={saving}>{saving ? '保存中...' : '保存全部'}</Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {loading ? <div className="text-center py-8 text-gray-500">加载中...</div> : (
          <>
            <Card className="glass">
              <CardHeader><CardTitle>渠道状态</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {channelStatus.map((item) => (
                  <div key={item.name} className="flex items-center justify-between rounded-lg border p-2 text-sm">
                    <span>{item.name}</span>
                    <span className={item.configured ? 'text-green-600' : 'text-gray-400'}>{item.configured ? '已配置' : '未配置'}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader><CardTitle>官方渠道凭据（直连）</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input placeholder="Feishu Webhook" value={config.feishu_webhook || ''} onChange={(e) => updateConfig('feishu_webhook', e.target.value)} />
                <Input placeholder="企业微信 Webhook" value={config.wecom_webhook || ''} onChange={(e) => updateConfig('wecom_webhook', e.target.value)} />
                <Input placeholder="DingTalk Webhook" value={config.dingtalk_webhook || ''} onChange={(e) => updateConfig('dingtalk_webhook', e.target.value)} />
                <Input placeholder="DingTalk Secret" value={config.dingtalk_secret || ''} onChange={(e) => updateConfig('dingtalk_secret', e.target.value)} />
                <Input placeholder="Telegram Bot Token" value={config.telegram_bot_token || ''} onChange={(e) => updateConfig('telegram_bot_token', e.target.value)} />
                <Input placeholder="Telegram Chat ID" value={config.telegram_chat_id || ''} onChange={(e) => updateConfig('telegram_chat_id', e.target.value)} />
                <Input placeholder="Slack Webhook" value={config.slack_webhook || ''} onChange={(e) => updateConfig('slack_webhook', e.target.value)} />
                <Input placeholder="Discord Webhook" value={config.discord_webhook || ''} onChange={(e) => updateConfig('discord_webhook', e.target.value)} />
                <Input placeholder="WxPusher AppToken" value={config.wxpusher_app_token || ''} onChange={(e) => updateConfig('wxpusher_app_token', e.target.value)} />
                <Input placeholder="WxPusher UID" value={config.wxpusher_uid || ''} onChange={(e) => updateConfig('wxpusher_uid', e.target.value)} />
                <Input placeholder="Qmsg Key" value={config.qmsg_key || ''} onChange={(e) => updateConfig('qmsg_key', e.target.value)} />
                <Input placeholder="Qmsg QQ(可选)" value={config.qmsg_qq || ''} onChange={(e) => updateConfig('qmsg_qq', e.target.value)} />
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader><CardTitle>Webhook桥接渠道（批量）</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {webhookBridgeChannels.map((ch) => (
                  <Input
                    key={ch.key}
                    placeholder={`${ch.label} Webhook`}
                    value={config.channel_webhooks?.[ch.key] || ''}
                    onChange={(e) => updateBridgeWebhook(ch.key, e.target.value)}
                  />
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
