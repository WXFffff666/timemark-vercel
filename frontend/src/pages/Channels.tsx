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
  BookOpen, ChevronRight, Search,
  Loader2, Activity
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { SkeletonCard } from '@/components/ui/skeleton-card';
import { ChannelRepairWizard } from '@/components/channels/ChannelRepairWizard';
import { fetchChannelTemplates, type CloudChannelTemplate } from '@/lib/channel-templates';
import { ChannelIcon } from '@/components/channels/ChannelIcon';
import { ChannelQr } from '@/components/channels/ChannelQr';
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
  webhookConfigured?: boolean;
  chatIdConfigured?: boolean;
  last_test_result?: 'success' | 'failed' | null;
  last_test_at?: string | null;
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
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  
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
  // v2.28：三步向导 —— 配置弹窗内 ②填写 → ③测试并保存（①选渠道复用现有类型弹窗）
  const [wizardStep, setWizardStep] = useState<1 | 2>(1);
  const [directTestResult, setDirectTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Connection status tracking
  interface ConnectionTestResult {
    status: 'connected' | 'error' | 'testing' | 'untested';
    message?: string;
    timestamp?: number;
  }
  const [connectionStatus, setConnectionStatus] = useState<Record<string, ConnectionTestResult>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testAllSummary, setTestAllSummary] = useState('');
  const [channelStats, setChannelStats] = useState<Array<{ channel: string; sent: number; ok: number; failed: number; successRate: number }>>([]);
  const [accountStats, setAccountStats] = useState<Record<number, { sent: number; ok: number; failed: number; successRate: number }>>({});
  // v2.25: 修复向导——暂停徽章的第二个动作（第一个是立即恢复）
  const [repairAccountId, setRepairAccountId] = useState<number | null>(null);
  const [statsRuns, setStatsRuns] = useState(0);

  const fetchStats = () => {
    api.get<{ windowDays: number; runs: number; channels: Array<{ channel: string; sent: number; ok: number; failed: number; successRate: number }>; accounts?: Array<{ accountId: number; sent: number; ok: number; failed: number; successRate: number }> }>('/channels/stats')
      .then((d) => {
        setChannelStats(d?.channels ?? []);
        setAccountStats(Object.fromEntries((d?.accounts ?? []).map((a) => [a.accountId, a])));
        setStatsRuns(d?.runs ?? 0);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    fetchData({ initial: true });
  }, []);

  // v78: 近 30 天渠道发送统计（成功/失败/成功率），用于健康概览卡
  useEffect(() => {
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v78: 手动恢复被 24h 暂停的渠道账户
  const resumeAccount = async (account: Account) => {
    try {
      await api.post('/channels/resume', { accountId: Number(account.id) });
      await fetchData();
    } catch (error) {
      console.error('Failed to resume account:', error);
    }
  };

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
    setTestingAll(true);
    try {
      // v78: 服务端批量自检 —— 并发测试、结果落库、成功即清除 24h 暂停
      const res = await api.post<{
        results: Array<{ accountId: number; accountName: string; channel: string; success: boolean; message: string }>;
        summary: { total: number; passed: number; failed: number };
      }>('/channels/test-all', {});
      const next: Record<string, ConnectionTestResult> = {};
      for (const r of res?.results ?? []) {
        next[String(r.accountId)] = {
          status: r.success ? 'connected' : 'error',
          message: r.message,
          timestamp: Date.now(),
        };
      }
      setConnectionStatus((prev) => ({ ...prev, ...next }));
      const s = res?.summary;
      if (s) {
        setTestAllSummary(`自检完成：${s.passed}/${s.total} 通过${s.failed > 0 ? `，${s.failed} 个失败（详见各卡片红点）` : ''}`);
      }
      fetchStats();
      await fetchData();
    } catch {
      setTestAllSummary('自检失败：请稍后重试或逐个渠道测试');
    } finally {
      setTestingAll(false);
    }
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
    setWizardStep(1);
    setDirectTestResult(null);
    
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

  // v2.28：三步向导的必填校验（编辑模式下已配置的密文字段留空 = 不修改，视为已填）
  const missingRequiredFields = (selectedTemplate?.fields ?? [])
    .filter((f) => {
      if (!f.required) return false;
      const v = (configForm[f.name] || '').trim();
      if (v) return false;
      if (f.name === 'token') return !selectedAccount?.tokenConfigured;
      if (f.name === 'secret') return !selectedAccount?.secretConfigured;
      // v2.28 修复：webhook/chat_id 已配置的渠道（后端置 null + *Configured 标志）
      // 在编辑模式下留空 = 保持不变，不能把向导锁死
      if (f.name === 'webhook') return !selectedAccount?.webhookConfigured;
      if (f.name === 'chat_id') return !selectedAccount?.chatIdConfigured;
      return true;
    })
    .map((f) => f.label);

  // v2.28：保存前直测（/channels/test 支持不带 accountId 的直连配置测试，SMTP 同款）
  const testConfigDirect = async () => {
    if (!selectedTemplate) return;
    setTestingConfig(true);
    setDirectTestResult(null);
    try {
      const payload: Record<string, unknown> = {
        type: selectedTemplate.id,
        configMethod: selectedTemplate.configMethod,
      };
      for (const field of selectedTemplate.fields) {
        const dest = field.column ?? field.name;
        const value = (configForm[field.name] || '').trim();
        if (!value) continue;
        if (dest === 'webhook') payload.webhook = value;
        else if (dest === 'token') payload.token = value;
        else if (dest === 'secret') payload.secret = value;
        else if (dest === 'chat_id') payload.chatId = value;
      }
      if (selectedAccount?.id) payload.accountId = Number(selectedAccount.id);
      // v2.29：后端回传 latency（毫秒），成功提示里顺带展示响应速度
      const result = await api.post<{ success: boolean; message: string; latency?: number }>('/channels/test', payload);
      const latencySuffix = typeof result?.latency === 'number' ? `（${result.latency}ms）` : '';
      setDirectTestResult({ ok: true, message: `${result?.message || '测试连接成功'}${latencySuffix}` });
    } catch (error: any) {
      setDirectTestResult({ ok: false, message: error?.message || '测试连接失败' });
    } finally {
      setTestingConfig(false);
    }
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
    // v2.28 修复：编辑也要从步骤①开始，否则会落在上一次残留的测试结果页
    setWizardStep(1);
    setDirectTestResult(null);

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

  // v2.29：61 个渠道靠翻已经翻不动，加名称/描述/ID 实时搜索；与分类筛选叠加
  const [templateSearch, setTemplateSearch] = useState('');
  const searchedTemplates = templateSearch.trim()
    ? filteredTemplates.filter((t) => {
        const kw = templateSearch.trim().toLowerCase();
        return (
          t.name.toLowerCase().includes(kw) ||
          t.description.toLowerCase().includes(kw) ||
          t.id.toLowerCase().includes(kw)
        );
      })
    : filteredTemplates;

  // 分类过滤 + 分组（v2.29）：61 个渠道平铺已经翻不动了，按类分组 + 类别筛选
  const categoryOrder = ['im', 'push', 'email', 'sms', 'smart', 'automation', 'other'] as const;
  const CATEGORY_LABELS: Record<string, string> = {
    im: '即时通讯', push: '推送通知', email: '邮件', sms: '短信 / 电话',
    smart: '智能家居 / 自托管', automation: '自动化平台', other: '其他',
  };
  const groupedTemplates = categoryOrder
    .map((cat) => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      items: searchedTemplates.filter((t) => (t.category ?? 'other') === cat),
    }))
    .filter((group) => group.items.length > 0)
    .filter((group) => categoryFilter === 'all' || group.category === categoryFilter);

  const connectedAccounts = accounts.filter(a => getAccountStatus(a) === 'connected');
  const failedAccounts = accounts.filter(a => getAccountStatus(a) === 'failed');
  const untestedAccounts = accounts.filter(a => getAccountStatus(a) === 'untested');
  const disabledAccounts = accounts.filter(a => getAccountStatus(a) === 'disabled');

  /**
   * 邮件送达健康检查卡（v78）：邮件进垃圾箱的根因几乎都在发件域名的认证配置，
   * 而不是正文内容。这里逐项列出检查点与当前 From 域名；DNS 实际验证需要用户
   * 在域名服务商处操作，页面给出可复制的记录要求。
   */
  // v79 渠道配置脱敏导出：凭据已由后端脱敏（只留尾 4 位），导出 JSON 可安全留存
  const exportAccounts = async () => {
    try {
      const res = await api.get<{ accounts: unknown[] } | null>('/config/accounts/export');
      const payload = {
        format: 'timemark-channels-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: res?.accounts ?? [],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timemark-channels-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export accounts:', error);
      setTestAllSummary('导出失败：请稍后重试');
    }
  };

  // v2.25: 渠道统计导出 CSV（按渠道 + 按账户两个 sheet 段）
  const exportStatsCsv = () => {
    const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['section,channel_or_account,sent,ok,failed,success_rate'];
    for (const s of channelStats) {
      lines.push([ 'channel', esc(s.channel), s.sent, s.ok, s.failed, s.successRate ].join(','));
    }
    for (const [id, a] of Object.entries(accountStats)) {
      const account = accounts.find((acc) => Number(acc.id) === Number(id));
      lines.push([ 'account', esc(account?.name || `#${id}`), a.sent, a.ok, a.failed, a.successRate ].join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timemark-channel-stats-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderChannelStatsCard = () => {
    if (channelStats.length === 0) return null;
    const totals = channelStats.reduce((acc, s) => ({ sent: acc.sent + s.sent, ok: acc.ok + s.ok }), { sent: 0, ok: 0 });
    const overall = totals.sent > 0 ? Math.round((totals.ok / totals.sent) * 100) : 0;
    return (
      <section className="mb-10">
        <div className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2 flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-500" />
            近 30 天发送统计
            <span className={`text-sm px-2 py-0.5 rounded-full ${overall >= 90 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300' : overall >= 60 ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300'}`}>
              总成功率 {overall}%
            </span>
            {statsRuns > 0 && (
              <span className="text-xs text-slate-400 font-normal">共 {statsRuns} 次分发（最多统计最近 5000 条日志）</span>
            )}
            <button
              type="button"
              onClick={exportStatsCsv}
              className="ml-auto text-xs text-primary-600 dark:text-primary-400 underline hover:no-underline"
              aria-label="导出渠道统计 CSV"
            >
              导出 CSV
            </button>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mt-4">
            {channelStats.map((s) => {
              const template = templates.find((t) => t.id === s.channel);
              return (
                <div key={s.channel} className="rounded-xl border border-slate-200/60 dark:border-slate-700/50 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <ChannelIcon name={template?.icon} size={14} />
                      {template?.name || s.channel}
                    </span>
                    <span className={`text-xs font-semibold ${s.successRate >= 90 ? 'text-emerald-600 dark:text-emerald-400' : s.successRate >= 60 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                      {s.successRate}%
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${s.successRate >= 90 ? 'bg-emerald-500' : s.successRate >= 60 ? 'bg-amber-500' : 'bg-red-500'}`}
                      style={{ width: `${Math.max(s.successRate, 2)}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-slate-400">
                    发送 {s.sent} 次 · 成功 {s.ok} · 失败 {s.failed}
                  </p>
                </div>
              );
            })}
          </div>
          {(() => {
            // v79: 账户维度明细（同名渠道多账户时一眼看出哪个账户在拖后腿）
            const accountEntries = Object.entries(accountStats);
            if (accountEntries.length === 0) return null;
            return (
              <div className="mt-4 pt-4 border-t border-slate-200/60 dark:border-slate-700/50">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">按账户</p>
                <div className="flex flex-wrap gap-2">
                  {accountEntries.map(([id, stat]) => {
                    const account = accounts.find((a) => Number(a.id) === Number(id));
                    const cls = stat.successRate >= 90 ? 'text-emerald-600 dark:text-emerald-400' : stat.successRate >= 60 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
                    return (
                      <span key={id} className="text-xs px-2.5 py-1 rounded-full bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50">
                        {account?.name || `账户 #${id}`} <span className={`font-semibold ${cls}`}>{stat.successRate}%</span>
                        <span className="text-slate-400 ml-1">（{stat.sent} 次）</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      </section>
    );
  };

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
                    <>
                      <button
                        type="button"
                        onClick={() => resumeAccount(account)}
                        className="text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
                        title="连续发送失败，已暂停投递 24 小时；点击立即恢复投递"
                      >
                        ⏸ 暂停中 · 点击恢复
                      </button>
                      <button
                        type="button"
                        onClick={() => setRepairAccountId(Number(account.id))}
                        className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        title="打开渠道修复向导：诊断 → 换凭据 → 重新启用"
                      >
                        🔧 修复
                      </button>
                    </>
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
              {/* v2.29：账户卡上直接标渠道分类，61 个渠道里一眼看出归属 */}
              {template?.category && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                  {CATEGORY_LABELS[template.category] ?? '其他'}
                </span>
              )}
              {(() => {
                // v79: 账户维度的真实发送统计 + 上次测试时间
                const stat = accountStats[Number(account.id)];
                const parts: string[] = [];
                if (stat) parts.push(`发送 ${stat.sent} · 成功率 ${stat.successRate}%`);
                if (account.last_test_at) {
                  const mins = Math.round((Date.now() - new Date(account.last_test_at).getTime()) / 60000);
                  parts.push(`上次测试 ${mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`}`);
                }
                return parts.length ? <span className="ml-2 text-slate-400">{parts.join(' · ')}</span> : null;
              })()}
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
      <PageHeader
        title="通知渠道"
        subtitle="按需添加并绑定，不配置不影响核心提醒"
        maxWidth="max-w-[90rem]"
        actions={
          <div className="flex items-center gap-2">
            {accounts.length > 0 && (
              <Button variant="outline" size="sm" className="rounded-full min-h-11 hidden sm:flex" onClick={exportAccounts} aria-label="导出脱敏渠道配置">
                导出配置
              </Button>
            )}
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
        }
      />

      <main id="main-content" className="max-w-[90rem] mx-auto px-6 py-10 mt-2" tabIndex={-1}>
        <p className="text-sm text-hint mb-8 max-w-3xl">
          通知渠道均为可选：愿意用哪种就添加并绑定哪种，不添加也能正常创建事件。需要时点击「添加渠道」；配置说明见
          {' '}
          <button type="button" className="text-primary-600 dark:text-primary-400 underline" onClick={() => navigate('/integrations-docs')}>
            集成文档
          </button>
          。
        </p>
        {testAllSummary && (
          <div className="mb-6 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm text-slate-600 dark:text-slate-300">
            {testAllSummary}
          </div>
        )}
        {initialLoading ? (
          // 局部骨架：只在首屏出现，且形状与真实账户卡片一致，页面框架与说明文字不消失
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" aria-busy="true" aria-label="正在加载通知渠道">
            {Array.from({ length: 6 }, (_, i) => (
              <SkeletonCard key={i} count={1} />
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
            {renderChannelStatsCard()}
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

      {/* v2.25: 渠道修复向导（暂停徽章的「🔧 修复」动作） */}
      {repairAccountId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label="渠道修复向导">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto overscroll-contain">
            <ChannelRepairWizard
              accountId={repairAccountId}
              onClose={() => setRepairAccountId(null)}
              onDone={() => {
                setRepairAccountId(null);
                void fetchData();
                fetchStats();
              }}
            />
          </div>
        </div>
      )}

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

              {/* v2.29：渠道搜索（61 个渠道按名称/描述/ID 实时过滤） */}
              <div className="relative mb-4">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  placeholder="搜索渠道名称 / 描述 / ID…"
                  className="pl-9"
                  aria-label="搜索通知渠道"
                />
              </div>

              {/* 分类筛选 chips：61 个渠道翻不动，先按类收敛 */}
              <div className="flex flex-wrap gap-2 mb-4">
                <button
                  onClick={() => setCategoryFilter('all')}
                  className={`text-xs px-3 py-1.5 rounded-full transition-colors min-h-11 flex items-center ${categoryFilter === 'all'
                    ? 'bg-primary-500 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                >
                  全部（{searchedTemplates.length}）
                </button>
                {Object.entries(CATEGORY_LABELS).map(([cat, label]) => {
                  const count = searchedTemplates.filter((t) => (t.category ?? 'other') === cat).length;
                  if (count === 0) return null;
                  return (
                    <button
                      key={cat}
                      onClick={() => setCategoryFilter(categoryFilter === cat ? 'all' : cat)}
                      className={`text-xs px-3 py-1.5 rounded-full transition-colors min-h-11 flex items-center ${categoryFilter === cat
                        ? 'bg-primary-500 text-white'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                    >
                      {label}（{count}）
                    </button>
                  );
                })}
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab + categoryFilter + templateSearch}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-5 max-h-[50vh] overflow-y-auto overscroll-contain pr-2"
                >
                  {groupedTemplates.length === 0 && (
                    <div className="text-center py-10 text-sm text-slate-500 dark:text-slate-400">
                      没有匹配「{templateSearch || CATEGORY_LABELS[categoryFilter]}」的渠道
                      <button
                        type="button"
                        onClick={() => { setTemplateSearch(''); setCategoryFilter('all'); }}
                        className="ml-2 text-primary-500 hover:text-primary-600 underline underline-offset-2"
                      >
                        清除筛选
                      </button>
                    </div>
                  )}
                  {groupedTemplates.map((group) => (
                    <div key={group.category}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{group.label}</span>
                        <span className="text-xs text-slate-400 dark:text-slate-500">{group.items.length}</span>
                        <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {group.items.map((template) => {
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
                      </div>
                    </div>
                  ))}
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
            {/* v2.28：三步向导步骤指示 */}
            <div className="flex items-center gap-2 mt-3 text-xs" aria-label="配置步骤">
              {(['填写参数', '测试并保存'] as const).map((label, i) => {
                const stepNo = (i + 1) as 1 | 2;
                const active = wizardStep === stepNo;
                const done = wizardStep > stepNo;
                return (
                  <span
                    key={label}
                    className={`px-2.5 py-1 rounded-full font-medium ${
                      active
                        ? 'bg-primary-500 text-white'
                        : done
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                          : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                    }`}
                  >
                    {i + 1}. {label}{done ? ' ✓' : ''}
                  </span>
                );
              })}
            </div>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-5 sm:px-6 py-4 space-y-4 scroll-smooth touch-pan-y">
          {wizardStep === 2 ? (
            /* ---------- v2.28 步骤②：测试并保存 ---------- */
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 space-y-2">
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  {selectedTemplate?.name} · {configForm.name || '(未命名)'}
                </p>
                <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
                  {(selectedTemplate?.fields ?? []).map((f) => {
                    const v = (configForm[f.name] || '').trim();
                    const secretConfigured = Boolean(selectedAccount?.secretConfigured);
                    const tokenConfigured = Boolean(selectedAccount?.tokenConfigured);
                    const configured = Boolean(selectedAccount) && (f.name === 'token' ? tokenConfigured : f.name === 'secret' ? secretConfigured : false);
                    const shown = v
                      ? (f.type === 'password' ? '••••••••（已填写）' : v)
                      : configured ? '已配置，保持不变' : '（空）';
                    return <li key={f.name}>{f.label}：{shown}</li>;
                  })}
                </ul>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="rounded-xl min-h-11" onClick={() => void testConfigDirect()} disabled={testingConfig}>
                  {testingConfig ? (<><Loader2 size={16} className="mr-2 animate-spin" />测试中…</>) : '发送测试消息'}
                </Button>
              </div>
              {directTestResult && (
                <p className={`text-sm ${directTestResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`} role="status">
                  {directTestResult.ok ? '✓ ' : '✗ '}{directTestResult.message}
                </p>
              )}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                测试成功后点击右下角「{selectedAccount ? '保存修改' : '添加渠道'}」完成绑定；测试失败请返回上一步核对参数。
              </p>
            </div>
          ) : (
            /* ---------- 步骤①：填写参数（原有内容 + 官方链接 + 必填校验提示） ---------- */
            <div className="space-y-4">
            {missingRequiredFields.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
                还需填写：{missingRequiredFields.join('、')}
              </p>
            )}
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
                          {preset.servers.sslNote && <p className="font-sans text-slate-500 dark:text-slate-400 pt-1">{preset.servers.sslNote}</p>}
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

            {/* v2.28：官方获取入口（docsUrl / officialUrl，元数据自带） */}
            {(selectedTemplate?.officialUrl || selectedTemplate?.docsUrl) && (
              <a
                href={selectedTemplate?.officialUrl ?? selectedTemplate?.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary-500 hover:text-primary-600"
              >
                <BookOpen size={14} />
                前往 {selectedTemplate?.name} 官方页面获取 Token / Webhook
                <ExternalLink size={12} />
              </a>
            )}

            {/* v2.29：官方页二维码 —— 凭据要在手机上取的渠道（扫码关注/注册），扫一下就行 */}
            {(selectedTemplate?.officialUrl ?? selectedTemplate?.docsUrl) && (
              <ChannelQr
                url={selectedTemplate?.officialUrl ?? selectedTemplate?.docsUrl!}
                name={selectedTemplate?.name}
              />
            )}

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
            {wizardStep === 1 ? (
              /* v2.28 步骤①主按钮：进入测试步骤（必填未齐时禁用） */
              <Button
                variant="vision"
                className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30"
                onClick={() => { setDirectTestResult(null); setWizardStep(2); }}
                disabled={missingRequiredFields.length > 0 || !(configForm.name || '').trim()}
              >
                下一步：测试连接
              </Button>
            ) : (
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
            )}
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
