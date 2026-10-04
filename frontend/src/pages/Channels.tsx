import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { normalizeEmail, SMTP_PROVIDER_PRESETS, applySmtpProviderToForm, getSmtpProviderPreset, inferSmtpProviderId, inferSmtpEncryption } from '@timemark/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Webhook, MessageSquare, AlertCircle, CheckCircle2,
  Link2Off, ArrowLeft, Plus, ExternalLink, Settings,
  BookOpen, ChevronRight,
  Loader2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { fetchChannelTemplates, type CloudChannelTemplate } from '@/lib/channel-templates';
import { ChannelIcon } from '@/components/channels/ChannelIcon';
import type { NotificationAccount } from '@timemark/shared';

// Channel configuration method types (cloud deploy: webhook + token only)
type ConfigMethod = 'webhook' | 'token';

interface Account extends NotificationAccount {
  is_active?: boolean;
  suspended_until?: string | null;
  token?: string;
  chat_id?: string;
  secret?: string;
  webhook?: string;
  smtpProvider?: string | null;
  tokenConfigured?: boolean;
  secretConfigured?: boolean;
  sessionConfigured?: boolean;
  last_test_result?: 'success' | 'failed' | null;
  connection_status?: string | null;
}

/** 24h 失败暂停是否生效中（后端 v78：3 连败暂停而非硬禁用，测试成功/手动重试即恢复）。 */
function isAccountSuspended(account: Account): boolean {
  if (!account.suspended_until) return false;
  const until = new Date(account.suspended_until);
  return Number.isFinite(until.getTime()) && until.getTime() > Date.now();
}

const containerVariants = { 
  hidden: { opacity: 0 }, 
  visible: { 
    opacity: 1, 
    transition: { staggerChildren: 0.05 } 
  } 
};

const itemVariants = { 
  hidden: { opacity: 0, y: 20, scale: 0.95 }, 
  visible: { 
    opacity: 1, 
    y: 0, 
    scale: 1, 
    transition: { type: 'spring', stiffness: 300, damping: 24 } as const 
  } 
};

export default function Channels() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [templates, setTemplates] = useState<CloudChannelTemplate[]>([]);
  // 首屏才出骨架；保存/测试/删除后的刷新保留旧内容，不再整页转圈。
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // 单飞句柄：并发的 fetchData 复用同一次请求（连点保存/测试不会重复打接口）。
  const inflightRef = useRef<Promise<void> | null>(null);
  /** 请求进行中又来了一次刷新：排一次尾随刷新，而不是丢掉它 */
  const trailingRef = useRef(false);
  const [activeTab, setActiveTab] = useState<ConfigMethod>('webhook');
  
  // Modal navigation state - track the flow: list -> template -> config -> qr
  const [modalBackStack, setModalBackStack] = useState<string[]>([]);
  
  // Modals state
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<CloudChannelTemplate | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [configForm, setConfigForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState<string | null>(null);
  const [testingConfig, setTestingConfig] = useState(false);
  const [configTestMessage, setConfigTestMessage] = useState<string | null>(null);

  // Connection status tracking
  interface ConnectionTestResult {
    status: 'connected' | 'error' | 'testing' | 'untested';
    message?: string;
    timestamp?: number;
  }
  const [connectionStatus, setConnectionStatus] = useState<Record<string, ConnectionTestResult>>({});
  const [testingAll, setTestingAll] = useState(false);

  useEffect(() => {
    fetchData({ initial: true });
  }, []);

  /**
   * 拉取目录 + 账户。
   *
   * 之前有三个问题：两次请求串行（目录拿到才发账户）、每次都 `refresh: true` 把目录缓存
   * 彻底废掉、以及每次刷新都 setLoading(true) 让整页转圈——保存一次账户屏幕就白转一下。
   * 现在：两个请求并行；目录只在首屏强制刷新一次（会话内不变）；并发调用共享同一次请求。
   */
  const fetchData = async (options: { initial?: boolean } = {}): Promise<void> => {
    if (inflightRef.current) {
      // 不能直接丢弃：mutation 之后的刷新如果撞上正在进行的请求就会永远不发生，
      // 而正在进行的这次拿到的是保存前的响应 —— 界面上就留着旧账户列表，
      // 用户刚保存的账户凭空消失。标记一次尾随刷新，当前请求结束后补跑。
      trailingRef.current = true;
      return inflightRef.current;
    }

    const run = (async () => {
      if (options.initial) setInitialLoading(true);
      try {
        const [templatesRes, accountsRes] = await Promise.all([
          fetchChannelTemplates({ refresh: options.initial === true }),
          api.get<Account[]>('/config/accounts'),
        ]);
        setTemplates(templatesRes);
        setAccounts(accountsRes ?? []);
        setLoadFailed(false);
      } catch (error) {
        // 拉取失败不能显示成"你还没有配置渠道"——那是误导，要说出来。
        console.error('Failed to fetch data:', error);
        setLoadFailed(true);
      } finally {
        if (options.initial) setInitialLoading(false);
        inflightRef.current = null;
        if (trailingRef.current) {
          trailingRef.current = false;
          // 尾随刷新不带 initial：数据已经在屏上了，别再让整页转一次圈
          void fetchData();
        }
      }
    })();

    inflightRef.current = run;
    return run;
  };

  // Test a single account and update status
  const testAccountStatus = async (account: Account): Promise<ConnectionTestResult> => {
    setConnectionStatus(prev => ({ ...prev, [account.id]: { status: 'testing' } }));
    try {
      const result = await api.post<{ success: boolean; message: string }>(
        '/channels/test',
        { accountId: Number(account.id), type: account.type },
      );
      const status: ConnectionTestResult = {
        status: 'connected',
        message: result?.message || '连接成功',
        timestamp: Date.now(),
      };
      setConnectionStatus(prev => ({ ...prev, [account.id]: status }));
      return status;
    } catch (error: any) {
      const status: ConnectionTestResult = {
        status: 'error',
        message: error.message || '连接失败',
        timestamp: Date.now(),
      };
      setConnectionStatus(prev => ({ ...prev, [account.id]: status }));
      return status;
    }
  };

  const testAllAccounts = async () => {
    const testableAccounts = accounts.filter(a => a.is_active !== false);
    setTestingAll(true);
    for (const account of testableAccounts) {
      await testAccountStatus(account);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    setTestingAll(false);
  };



  // Get status indicator for an account
  const getStatusIndicator = (accountId: string) => {
    const result = connectionStatus[accountId];
    if (!result || result.status === 'untested') return { dot: '⚪', color: 'text-slate-400', label: '未测试' };
    if (result.status === 'testing') return { dot: '🟡', color: 'text-amber-500', label: '测试中...' };
    if (result.status === 'connected') return { dot: '🟢', color: 'text-green-500', label: '已连接' };
    return { dot: '🔴', color: 'text-red-500', label: '连接失败' };
  };

  const getMethodLabel = (method: ConfigMethod) => {
    switch (method) {
      case 'webhook': return 'Webhook';
      case 'token': return 'Token';
    }
  };

  const getMethodColor = (method: ConfigMethod) => {
    switch (method) {
      case 'webhook': return 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400';
      case 'token': return 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400';
    }
  };

  const getAccountStatus = (account: Account): 'disabled' | 'connected' | 'failed' | 'untested' => {
    if (!account.is_active) return 'disabled';
    const live = connectionStatus[account.id];
    if (live?.status === 'error') return 'failed';
    if (live?.status === 'connected') return 'connected';
    if (account.last_test_result === 'failed' || account.connection_status === 'unhealthy') return 'failed';
    if (account.last_test_result === 'success' || account.connection_status === 'healthy') return 'connected';
    return 'untested';
  };

  const getStatusBadge = (account: Account) => {
    const status = getAccountStatus(account);
    switch (status) {
      case 'connected':
        return { variant: 'success' as const, label: '已验证', icon: <CheckCircle2 size={12} /> };
      case 'failed':
        return { variant: 'destructive' as const, label: '测试失败', icon: <AlertCircle size={12} /> };
      case 'untested':
        return { variant: 'secondary' as const, label: '未测试', icon: null };
      default:
        return { variant: 'secondary' as const, label: '已禁用', icon: null };
    }
  };

  const openTemplateModal = () => {
    setModalBackStack(['main']);
    setShowTemplateModal(true);
  };

  const selectTemplate = (template: CloudChannelTemplate) => {
    setSelectedTemplate(template);
    setShowTemplateModal(false);
    setConfigTestMessage(null);
    
    const initialForm: Record<string, string> = { name: '' };
    template.fields.forEach(field => {
      initialForm[field.name] = '';
    });
    if (template.id === 'smtp') {
      initialForm.smtpProvider = '';
      initialForm.smtpEncryption = 'ssl';
    }
    setConfigForm(initialForm);
    
    // 延迟设置 back stack 和打开 config modal，确保状态正确更新
    setTimeout(() => {
      setModalBackStack([...modalBackStack, 'template', 'config']);
      setShowConfigModal(true);
    }, 0);
  };

  // Handle going back in modal navigation
  const goBackInModal = () => {
    const newStack = modalBackStack.slice(0, -1);
    const lastState = newStack[newStack.length - 1];
    setModalBackStack(newStack);
    
    if (lastState === 'main' || lastState === undefined) {
      setShowConfigModal(false);
      setShowTemplateModal(false);
    } else if (lastState === 'template') {
      setShowConfigModal(false);
      setShowTemplateModal(true);
    }
  };

  // Check if we can go back
  const canGoBack = modalBackStack.length > 1;

  const openEditModal = (account: Account) => {
    const template = templates.find(t => t.id === account.type);
    if (!template) return;
    
    setSelectedTemplate(template);
    setSelectedAccount(account);
    setConfigForm(buildConfigFormFromAccount(account, template));
    setConfigTestMessage(null);
    
    // Set modal back stack properly so cancel returns to main, not template
    setModalBackStack(['main', 'config']);
    setShowConfigModal(true);
  };

  const buildConfigFormFromAccount = (account: Account, template: CloudChannelTemplate): Record<string, string> => {
    const form: Record<string, string> = { name: account.name || '' };
    const chatId = String((account as any).chatId || (account as any).chat_id || '');

    for (const field of template.fields) {
      switch (field.name) {
        case 'webhook':
          form.webhook = account.webhook || '';
          break;
        case 'token':
          form.token = account.token || '';
          break;
        case 'chat_id':
          form.chat_id = chatId;
          break;
        case 'secret':
          form.secret = (account as any).secret || '';
          break;
        case 'homeserver':
          form.homeserver = account.webhook || '';
          break;
        case 'roomId':
          form.roomId = chatId;
          break;
        case 'priority':
          form.priority = chatId || '0';
          break;
        default:
          if (!(field.name in form)) form[field.name] = '';
      }
    }

    if (template.id === 'smtp') {
      const provider =
        account.smtpProvider ||
        inferSmtpProviderId(account.webhook, (account as any).secret) ||
        'custom';
      form.smtpProvider = provider;
      form.smtpEncryption = inferSmtpEncryption((account as any).secret);
    }

    return form;
  };

  const handleSmtpProviderChange = (providerId: string) => {
    setConfigForm((prev) => applySmtpProviderToForm(providerId as any, {
      ...prev,
      smtpEncryption: prev.smtpEncryption || 'ssl',
    }));
    setConfigTestMessage(null);
  };

  const handleSmtpEncryptionChange = (encryption: 'ssl' | 'starttls') => {
    setConfigForm((prev) => {
      const preset = getSmtpProviderPreset(prev.smtpProvider);
      const port = encryption === 'starttls' && preset.altPort ? preset.altPort : preset.port;
      return {
        ...prev,
        smtpEncryption: encryption,
        secret: preset.id === 'custom' ? prev.secret : String(port),
      };
    });
    setConfigTestMessage(null);
  };

  const testSmtpConfig = async () => {
    if (!selectedTemplate || selectedTemplate.id !== 'smtp') return;
    if (!configForm.smtpProvider) {
      alert('请先选择邮箱服务商');
      return;
    }
    if (!configForm.chat_id?.trim() || !configForm.webhook?.trim() || !configForm.secret?.trim()) {
      alert('请填写发件人邮箱、SMTP 服务器和端口');
      return;
    }
    if (!configForm.token?.trim() && !(selectedAccount?.tokenConfigured)) {
      alert('请填写授权码或应用专用密码');
      return;
    }

    setTestingConfig(true);
    setConfigTestMessage(null);
    try {
      const payload: Record<string, unknown> = {
        type: 'smtp',
        configMethod: 'token',
        webhook: configForm.webhook,
        secret: configForm.secret,
        chatId: configForm.chat_id.trim(),
      };
      if (configForm.token?.trim()) {
        payload.token = configForm.token;
      }
      if (selectedAccount?.id) {
        payload.accountId = Number(selectedAccount.id);
      }

      const result = await api.post<{ success: boolean; message: string }>('/channels/test', payload);
      setConfigTestMessage(result?.message || 'SMTP 连接成功');
    } catch (error: any) {
      setConfigTestMessage(error.message || 'SMTP 连接失败');
    } finally {
      setTestingConfig(false);
    }
  };

  const saveConfig = async () => {
    if (!selectedTemplate || !configForm.name.trim()) {
      alert('请填写渠道名称');
      return;
    }

    // Validate required fields
    for (const field of selectedTemplate.fields) {
      if (field.required && !configForm[field.name]?.trim()) {
        if (selectedAccount) {
          if (field.name === 'token' && selectedAccount.tokenConfigured) continue;
          if (field.name === 'secret' && selectedAccount.secretConfigured) continue;
        }
        alert(`请填写 ${field.label}`);
        return;
      }
    }

    setSaving(true);
    try {
      let webhook = configForm.webhook || undefined;
      let chatId = configForm.chat_id || undefined;

      if (selectedTemplate.id === 'matrix') {
        webhook = configForm.homeserver || undefined;
        chatId = configForm.roomId || undefined;
      } else if (selectedTemplate.id === 'pushover') {
        chatId = configForm.priority || '0';
      } else if (selectedTemplate.id === 'resend' || selectedTemplate.id === 'email') {
        chatId = chatId ? (normalizeEmail(chatId) ?? chatId.trim().toLowerCase()) : undefined;
      } else if (selectedTemplate.id === 'smtp') {
        if (!configForm.smtpProvider) {
          alert('请选择邮箱服务商');
          setSaving(false);
          return;
        }
      }
      
      const sessionData =
        selectedTemplate.id === 'smtp'
          ? {
              smtpProvider: configForm.smtpProvider || 'custom',
              smtpEncryption: configForm.smtpEncryption || 'ssl',
            }
          : configForm.sessionData || undefined;

      const accountData = {
        name: configForm.name,
        type: selectedTemplate.id,
        configMethod: selectedTemplate.configMethod,
        webhook: webhook,
        token: configForm.token || undefined,
        chatId: chatId,
        secret: configForm.secret || undefined,
        sessionData,
      };

      if (selectedAccount) {
        await api.put(`/config/accounts/${selectedAccount.id}`, accountData);
      } else {
        await api.post('/config/accounts', accountData);
      }

      setShowConfigModal(false);
      setSelectedTemplate(null);
      setSelectedAccount(null);
      setConfigForm({});
      await fetchData();
    } catch (error: unknown) {
      console.error('Failed to save config:', error);
      alert(error instanceof Error ? error.message : '保存配置失败，请检查输入格式');
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = async (account: Account) => {
    try {
      await api.put(`/config/accounts/${account.id}`, { 
        isActive: !account.is_active 
      });
      fetchData();
    } catch (error) {
      console.error('Failed to toggle account:', error);
    }
  };

  const deleteAccount = async (account: Account) => {
    if (!confirm(`确定要删除 ${account.name} 吗？`)) return;
    
    try {
      await api.delete(`/config/accounts/${account.id}`);
      fetchData();
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
  };

  const testConnection = async (account: Account) => {
    setTestingConnection(account.id);
    const result = await testAccountStatus(account);
    setTestingConnection(null);
    if (result.status === 'connected') {
      alert(`✅ ${result.message || '连接成功'}`);
    } else {
      alert(`❌ ${result.message || '测试失败'}`);
    }
  };

  const importAppriseUrls = async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = prompt('粘贴 Apprise 通知 URL（每行一个，如 tgram://...）') || '';
    }
    const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => /:\/\//.test(l));
    if (!lines.length) {
      alert('未解析到有效 URL');
      return;
    }
    setConfigForm((prev) => ({
      ...prev,
      token: lines.join('\n'),
      name: prev.name || 'Apprise 渠道',
    }));
  };

  const filteredTemplates = templates.filter(t => t.configMethod === activeTab);

  const connectedAccounts = accounts.filter(a => getAccountStatus(a) === 'connected');
  const failedAccounts = accounts.filter(a => getAccountStatus(a) === 'failed');
  const untestedAccounts = accounts.filter(a => getAccountStatus(a) === 'untested');
  const disabledAccounts = accounts.filter(a => getAccountStatus(a) === 'disabled');

  /**
   * 邮件送达健康检查卡（v78）：邮件进垃圾箱的根因几乎都在发件域名的认证配置，
   * 而不是正文内容。这里逐项列出检查点与当前 From 域名；DNS 实际验证需要用户
   * 在域名服务商处操作，页面给出可复制的记录要求。
   */
  const renderDeliverabilityCard = () => {
    const emailAccounts = accounts.filter((a) => (['resend', 'smtp'] as string[]).includes(String(a.type)) && a.is_active !== false);
    if (emailAccounts.length === 0) return null;
    const resendAccounts = emailAccounts.filter((a) => String(a.type) === 'resend');
    const fromDomains = new Set<string>();
    for (const a of resendAccounts) {
      const from = String(a.webhook || '').trim();
      const domain = from.includes('@') ? from.split('@').pop() : '';
      if (domain) fromDomains.add(domain);
    }
    for (const a of emailAccounts.filter((x) => x.type === 'smtp')) {
      const from = String(a.chat_id || '').trim();
      const domain = from.includes('@') ? from.split('@').pop() : '';
      if (domain) fromDomains.add(domain);
    }
    const usesResendDev = resendAccounts.some((a) => !String(a.webhook || '').includes('@'));
    return (
      <section className="mb-10">
        <div className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-blue-500" />
            邮件送达健康
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
            邮件进垃圾箱的根因几乎总在<strong>发件域名认证</strong>（SPF / DKIM / DMARC），不在正文。逐项核对：
          </p>
          {usesResendDev && (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 mb-4">
              检测到 Resend 渠道使用默认发件地址 <code>onboarding@resend.dev</code>：它只能发给 Resend 账号本人的邮箱，
              且几乎必然进垃圾箱。请在渠道配置里把「发件人邮箱」改为已验证域名下的地址（如 noreply@mail.你的域名）。
            </div>
          )}
          <ul className="text-sm space-y-2 text-slate-600 dark:text-slate-300">
            <li>1. 在 Resend 控制台添加发件域名，按提示在 DNS 加 <strong>SPF</strong>（TXT）与 <strong>DKIM</strong>（TXT，2048 位）记录并等待生效。</li>
            <li>2. 在 DNS 加一条 <strong>DMARC</strong> 记录：<code>_dmarc.你的域名</code> → <code>v=DMARC1; p=none; rua=mailto:dmarc@你的域名</code>（先观察，再收紧到 p=quarantine）。</li>
            <li>3. 保持 From 地址与 DKIM 签名域<strong>同域对齐</strong>（当前 From 域：{fromDomains.size > 0 ? [...fromDomains].join('、') : '未检测到'}）。</li>
            <li>4. 收件人侧把发件地址加入通讯录 / 标记「重要」；首次发送建议先发给自己并点「非垃圾邮件」。</li>
            <li>5. 设置 → 高级通知 里可切换<strong>邮件模板风格</strong>（卡片模板少链接、带纯文本部分，垃圾分更低）。</li>
          </ul>
        </div>
      </section>
    );
  };

  const renderAccountCard = (account: Account) => {
    const template = templates.find(t => t.id === account.type);
    const badge = getStatusBadge(account);
    const status = getAccountStatus(account);

    return (
      <motion.div key={account.id} variants={itemVariants}>
        <div className={`glass-panel rounded-3xl p-6 transition-all duration-300 ring-1 ${
          status === 'connected' ? 'ring-primary-500/30 shadow-lg shadow-primary-500/5' :
          status === 'failed' ? 'ring-red-500/30' : 'ring-slate-200/60 dark:ring-slate-700/50'
        }`}>
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 flex items-center justify-center">
                <ChannelIcon name={template?.icon} size={24} />
              </div>
              <div>
                <h3 className="font-semibold text-slate-900 dark:text-white">{account.name}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className={`text-xs ${getStatusIndicator(account.id).color}`} title={connectionStatus[account.id]?.message || getStatusIndicator(account.id).label}>
                    {getStatusIndicator(account.id).dot}
                  </span>
                  <Badge variant={badge.variant} className="gap-1 text-xs">
                    {badge.icon}
                    {badge.label}
                  </Badge>
                  {template && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${getMethodColor(template.configMethod)}`}>
                      {getMethodLabel(template.configMethod)}
                    </span>
                  )}
                  {account.is_active !== false && isAccountSuspended(account) && (
                    <span
                      className="text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
                      title="连续发送失败，已暂停投递 24 小时；测试成功或手动重试会立即恢复"
                    >
                      ⏸ 暂停中
                    </span>
                  )}
                  {connectionStatus[account.id]?.timestamp && (
                    <span className="text-[10px] text-slate-400" title={connectionStatus[account.id]?.message}>
                      {new Date(connectionStatus[account.id].timestamp!).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <Switch
              checked={account.is_active !== false}
              onCheckedChange={() => toggleAccount(account)}
              aria-label={`启用或停用渠道账户 ${account.name}`}
            />
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-slate-200/60 dark:border-slate-700/50">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              类型: {template?.name || account.type}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="rounded-lg min-h-11 min-w-11"
                onClick={() => testConnection(account)}
                disabled={testingConnection === account.id}
                aria-label="测试渠道连接"
              >
                {testingConnection === account.id ? (
                  <Loader2 size={14} className="mr-1 animate-spin" />
                ) : (
                  <Settings size={14} className="mr-1" />
                )}
                {testingConnection === account.id ? '测试中' : '测试'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-lg min-h-11"
                onClick={() => openEditModal(account)}
                aria-label="编辑渠道配置"
              >
                <Settings size={14} className="mr-1" /> 配置
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-lg text-red-500 hover:text-red-600 min-h-11 min-w-11"
                onClick={() => deleteAccount(account)}
                aria-label="删除渠道"
              >
                <Link2Off size={14} />
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
    );
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-[90rem] mx-auto" role="banner">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-xs">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={() => navigate(-1)} aria-label="返回上一页">
              <ArrowLeft size={20} aria-hidden />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">通知渠道</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">按需添加并绑定，不配置不影响核心提醒</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="rounded-full min-h-11 hidden sm:flex" onClick={() => navigate('/integrations-docs')} aria-label="查看 ntfy 与集成文档">
              ntfy 教程
            </Button>
            {accounts.length > 0 && (
              <Button
                variant="secondary"
                className="rounded-full px-4"
                onClick={testAllAccounts}
                disabled={testingAll}
              >
                {testingAll ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <CheckCircle2 size={14} className="mr-1.5" />}
                {testingAll ? '测试中...' : '全部测试'}
              </Button>
            )}
            <Button 
              variant="vision" 
              className="shadow-md shadow-primary-500/20 flex rounded-full px-5" 
              onClick={openTemplateModal}
            >
              <Plus size={16} className="mr-1.5"/> 添加渠道
            </Button>
          </div>
        </div>
      </header>

      <main id="main-content" className="max-w-[90rem] mx-auto px-6 py-10 mt-2" tabIndex={-1}>
        <p className="text-sm text-hint mb-8 max-w-3xl">
          通知渠道均为可选：愿意用哪种就添加并绑定哪种，不添加也能正常创建事件。需要时点击「添加渠道」；配置说明见
          {' '}
          <button type="button" className="text-primary-600 dark:text-primary-400 underline" onClick={() => navigate('/integrations-docs')}>
            集成文档
          </button>
          。
        </p>
        {initialLoading ? (
          // 局部骨架：只在首屏出现，且形状与真实账户卡片一致，页面框架与说明文字不消失
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" aria-busy="true" aria-label="正在加载通知渠道">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="glass-panel rounded-3xl p-6 ring-1 ring-black/5 dark:ring-white/10 animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-slate-200/60 dark:bg-slate-700/50" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-28 rounded-full bg-slate-200/60 dark:bg-slate-700/50" />
                    <div className="h-3 w-20 rounded-full bg-slate-200/60 dark:bg-slate-700/50" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : loadFailed ? (
          // 拉取失败不是"你没有配置渠道"，要如实说出来并给重试
          <div className="glass-panel rounded-[2rem] p-10 text-center ring-1 ring-black/5 dark:ring-white/10">
            <AlertCircle size={40} className="mx-auto text-amber-500 mb-3" />
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">渠道加载失败</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">没能取回通知渠道与账户，请检查网络后重试。</p>
            <Button variant="outline" onClick={() => fetchData({ initial: true })}>重试</Button>
          </div>
        ) : (
          <>
            {renderDeliverabilityCard()}
            {[
              { title: '已验证的渠道', accounts: connectedAccounts, icon: <CheckCircle2 className="w-5 h-5 text-green-500" /> },
              { title: '待测试的渠道', accounts: untestedAccounts, icon: <AlertCircle className="w-5 h-5 text-amber-500" /> },
              { title: '测试失败的渠道', accounts: failedAccounts, icon: <AlertCircle className="w-5 h-5 text-red-500" /> },
              { title: '已禁用的渠道', accounts: disabledAccounts, icon: <Link2Off className="w-5 h-5 text-slate-400" /> },
            ].map((section) => section.accounts.length > 0 && (
              <section key={section.title} className="mb-10">
                <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
                  {section.icon}
                  {section.title}
                </h2>
                <motion.div
                  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                >
                  {section.accounts.map((account) => renderAccountCard(account))}
                </motion.div>
              </section>
            ))}

            {/* Empty State */}
            {accounts.length === 0 && (
              <div className="text-center py-20">
                <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                  <MessageSquare className="w-10 h-10 text-slate-400" />
                </div>
                <h3 className="text-xl font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  还没有配置通知渠道
                </h3>
                <p className="text-hint mb-6 max-w-md mx-auto">
                  添加通知渠道后，可在事件提醒时通过邮件、IM、Webhook 等方式接收通知；也可以稍后再配。
                </p>
                <Button 
                  variant="vision" 
                  className="rounded-full px-6"
                  onClick={openTemplateModal}
                >
                  <Plus size={16} className="mr-2" />
                  添加第一个渠道
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      {/* Template Selection Modal */}
      <Dialog open={showTemplateModal} onOpenChange={(open) => {
        // 点击遮罩层/旁边区域时直接关闭
        if (!open) {
          setShowTemplateModal(false);
        }
      }}>
        <DialogContent className="glass-panel rounded-[2rem] max-w-4xl max-h-[85vh] overflow-hidden p-0">
          <div className="p-6 border-b border-slate-200/60 dark:border-slate-700/50">
            <DialogHeader>
              <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
                <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                  <Plus size={24} />
                </div>
                选择通知渠道
              </DialogTitle>
            </DialogHeader>
            <p className="text-slate-500 dark:text-slate-400 mt-2">
              选择一个渠道类型进行配置；所有渠道均为可选，按需绑定即可
            </p>
          </div>
          
          <div className="p-6">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ConfigMethod)} className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="webhook" className="flex items-center gap-2">
                  <Webhook size={16} />
                  Webhook
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {templates.filter(t => t.configMethod === 'webhook').length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="token" className="flex items-center gap-2">
                  <Settings size={16} />
                  Token
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {templates.filter(t => t.configMethod === 'token').length}
                  </Badge>
                </TabsTrigger>
              </TabsList>

              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[50vh] overflow-y-auto pr-2"
                >
                  {filteredTemplates.map((template) => {
                    return (
                      <button
                        key={template.id}
                        onClick={() => selectTemplate(template)}
                        className="text-left p-4 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-700 hover:bg-primary-50/50 dark:hover:bg-primary-900/20 transition-all group min-h-11"
                      >
                        <div className="flex items-start gap-4">
                          <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 flex items-center justify-center group-hover:bg-primary-100 dark:group-hover:bg-primary-900/50 group-hover:text-primary-600 transition-colors">
<ChannelIcon name={template?.icon} size={24} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-slate-900 dark:text-white">
                                {template.name}
                              </h3>
                            </div>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                              {template.description}
                            </p>
                            <div className="flex items-center gap-2 mt-3">
                              <span className={`text-xs px-2 py-0.5 rounded-full ${getMethodColor(template.configMethod)}`}>
                                {getMethodLabel(template.configMethod)}
                              </span>
                              {template.docsUrl && (
                                <span className="text-xs text-primary-500 flex items-center gap-1">
                                  <BookOpen size={10} />
                                  文档
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-slate-400 group-hover:text-primary-500 transition-colors" />
                        </div>
                      </button>
                    );
                  })}
                </motion.div>
              </AnimatePresence>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* Config Modal */}
      <Dialog open={showConfigModal} onOpenChange={(open) => {
        // 点击遮罩层/旁边区域时也返回上一级，而不是直接关闭
        if (!open) {
          goBackInModal();
        }
      }}>
        <DialogContent className="glass-panel rounded-[2rem] max-h-[min(92vh,820px)] w-[calc(100%-1.5rem)] max-w-lg flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="shrink-0 px-5 sm:px-6 pt-5 sm:pt-6 pb-3 border-b border-slate-200/80 dark:border-slate-700/80">
            <div className="flex items-center gap-3 pr-8">
              {canGoBack && (
                <button 
                  onClick={goBackInModal}
                  className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <ArrowLeft size={24} className="text-slate-600 dark:text-slate-400" />
                </button>
              )}
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400 shrink-0">
                  {selectedTemplate && (
                    <ChannelIcon name={selectedTemplate.icon} size={24} />
                  )}
                </div>
                <DialogTitle className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white truncate">
                  {selectedTemplate ? (selectedAccount ? '编辑' : '配置') + ' ' + selectedTemplate.name : ''}
                </DialogTitle>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-5 sm:px-6 py-4 space-y-4 scroll-smooth touch-pan-y">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                渠道名称 *
              </label>
              <Input
                placeholder="例如：我的163邮箱"
                value={configForm.name || ''}
                onChange={(e) => setConfigForm({ ...configForm, name: e.target.value })}
                className="h-12"
              />
            </div>

            {selectedTemplate?.id === 'smtp' && (
              <div className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-slate-50/80 dark:bg-slate-800/40">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                    邮箱服务商 *
                  </label>
                  <select
                    value={configForm.smtpProvider || ''}
                    onChange={(e) => handleSmtpProviderChange(e.target.value)}
                    className="w-full h-12 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                    aria-label="邮箱服务商"
                  >
                    <option value="">请选择邮箱服务商</option>
                    {SMTP_PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </div>

                {configForm.smtpProvider && getSmtpProviderPreset(configForm.smtpProvider).altPort && (
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                      加密方式
                    </label>
                    <select
                      value={configForm.smtpEncryption || 'ssl'}
                      onChange={(e) => handleSmtpEncryptionChange(e.target.value as 'ssl' | 'starttls')}
                      className="w-full h-12 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                      aria-label="SMTP 加密方式"
                    >
                      <option value="ssl">SSL（端口 465，推荐）</option>
                      <option value="starttls">STARTTLS（端口 587）</option>
                    </select>
                  </div>
                )}

                {configForm.smtpProvider && (() => {
                  const preset = getSmtpProviderPreset(configForm.smtpProvider);
                  return (
                    <div className="text-xs text-slate-600 dark:text-slate-400 space-y-2">
                      <p>{preset.setupGuide}</p>
                      {preset.servers && (
                        <div className="rounded-xl bg-white/70 dark:bg-slate-900/50 px-3 py-2 space-y-1 font-mono text-[11px] leading-relaxed">
                          <p>SMTP: {preset.servers.smtp}</p>
                          {preset.servers.pop3 && <p>POP3: {preset.servers.pop3}</p>}
                          {preset.servers.imap && <p>IMAP: {preset.servers.imap}</p>}
                          {preset.servers.sslNote && <p className="font-sans text-slate-500 pt-1">{preset.servers.sslNote}</p>}
                        </div>
                      )}
                      {preset.cloudWarning && (
                        <p className="text-amber-600 dark:text-amber-400">{preset.cloudWarning}</p>
                      )}
                      {preset.docsUrl && (
                        <a
                          href={preset.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary-500 hover:text-primary-600"
                        >
                          查看官方配置说明
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {selectedTemplate?.fields.map((field) => {
              const smtpPreset = selectedTemplate.id === 'smtp' && configForm.smtpProvider
                ? getSmtpProviderPreset(configForm.smtpProvider)
                : null;

              let fieldLabel = field.label;
              let fieldDescription = field.description;
              let fieldPlaceholder = field.placeholder;

              if (smtpPreset) {
                if (field.name === 'token') {
                  fieldLabel = smtpPreset.passwordLabel;
                  fieldDescription = smtpPreset.passwordDescription;
                }
                if (field.name === 'chat_id') {
                  fieldPlaceholder = smtpPreset.fromEmailPlaceholder;
                }
              }

              return (
              <div key={field.name}>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {fieldLabel} {field.required && '*'}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    placeholder={fieldPlaceholder}
                    value={configForm[field.name] || ''}
                    onChange={(e) => setConfigForm({ ...configForm, [field.name]: e.target.value })}
                    className="w-full h-24 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                  />
                ) : field.type === 'select' ? (
                  <select
                    value={configForm[field.name] || '0'}
                    onChange={(e) => setConfigForm({ ...configForm, [field.name]: e.target.value })}
                    className="w-full h-12 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                    aria-label={fieldLabel}
                  >
                    {['-2', '-1', '0', '1', '2'].map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={field.type}
                    placeholder={
                      selectedAccount && field.name === 'token' && selectedAccount.tokenConfigured
                        ? '已配置，留空则不修改'
                        : selectedAccount && field.name === 'secret' && selectedAccount.secretConfigured
                          ? '已配置，留空则不修改'
                          : fieldPlaceholder
                    }
                    value={configForm[field.name] || ''}
                    onChange={(e) => setConfigForm({ ...configForm, [field.name]: e.target.value })}
                    className="h-12"
                  />
                )}
                {fieldDescription && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {fieldDescription}
                  </p>
                )}
              </div>
            );
            })}

            {selectedTemplate?.id === 'smtp' && (
              <div className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full min-h-11"
                  onClick={testSmtpConfig}
                  disabled={testingConfig}
                >
                  {testingConfig ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      正在测试 SMTP 连接...
                    </>
                  ) : (
                    '测试 SMTP 连接'
                  )}
                </Button>
                {configTestMessage && (
                  <p className={`text-sm break-words ${configTestMessage.includes('成功') ? 'text-green-600' : 'text-red-500'}`}>
                    {configTestMessage}
                  </p>
                )}
              </div>
            )}

            {(selectedTemplate?.id === 'resend' || selectedTemplate?.id === 'email') && (
              <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded-xl px-4 py-3">
                未填写渠道收件人时，将使用「设置 → 通知默认邮箱」中的默认测试邮箱。
              </p>
            )}

            {selectedTemplate?.id === 'apprise' && (
              <Button type="button" variant="outline" className="min-h-11" onClick={importAppriseUrls}>
                从剪贴板导入 Apprise URL
              </Button>
            )}

            {selectedTemplate?.docsUrl && (
              <a
                href={selectedTemplate.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary-500 hover:text-primary-600"
              >
                <BookOpen size={14} />
                查看官方文档
                <ExternalLink size={12} />
              </a>
            )}
          </div>

          <div className="shrink-0 px-5 sm:px-6 py-4 border-t border-slate-200/80 dark:border-slate-700/80 bg-white/90 dark:bg-slate-900/90 backdrop-blur flex gap-3">
            <Button
              variant="secondary"
              className="flex-1 h-12 rounded-2xl font-bold"
              onClick={() => {
                if (modalBackStack.length > 1) {
                  goBackInModal();
                } else {
                  setShowConfigModal(false);
                  setShowTemplateModal(true);
                  setModalBackStack(['main', 'template']);
                }
              }}
            >
              取消
            </Button>
            <Button
              variant="vision"
              className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30"
              onClick={saveConfig}
              disabled={saving}
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="mr-2 animate-spin" />
                  保存中...
                </>
              ) : (
                selectedAccount ? '保存修改' : '添加渠道'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
