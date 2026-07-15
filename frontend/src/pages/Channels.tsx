import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  MessageCircle, Mail, Webhook, MessageSquare, AlertCircle, CheckCircle2, 
  Link2Off, ArrowLeft, Plus, ExternalLink, Settings,
  Gamepad2, Hash, Building2, Terminal, Server, Video, Smartphone,
  Send, Grid3X3, Cloud, Zap, Phone, Shield, BookOpen, ChevronRight,
  Loader2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { NotificationAccount } from '@timemark/shared';

// Channel configuration method types (cloud deploy: webhook + token only)
type ConfigMethod = 'webhook' | 'token';

interface ChannelField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
}

interface ChannelTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  configMethod: ConfigMethod;
  fields: ChannelField[];
  docsUrl?: string;
  isBuiltIn: boolean;
}

interface Account extends NotificationAccount {
  is_active?: boolean;
  token?: string;
  chat_id?: string;
  last_test_result?: 'success' | 'failed' | null;
  connection_status?: string | null;
}

// Icon mapping
const iconMap: Record<string, React.ElementType> = {
  MessageCircle, MessageSquare, Mail, Webhook, Gamepad2, Hash, Building2,
  Terminal, Server, Video, Smartphone, Send, Grid3X3, Cloud, Zap, Phone,
  Shield, BookOpen, Plus, Settings, Loader2
};

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
    transition: { type: 'spring', stiffness: 300, damping: 24 } 
  } 
};

export default function Channels() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [templates, setTemplates] = useState<ChannelTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ConfigMethod>('webhook');
  
  // Modal navigation state - track the flow: list -> template -> config -> qr
  const [modalBackStack, setModalBackStack] = useState<string[]>([]);
  
  // Modals state
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<ChannelTemplate | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [configForm, setConfigForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState<number | null>(null);

  // Connection status tracking
  interface ConnectionTestResult {
    status: 'connected' | 'error' | 'testing' | 'untested';
    message?: string;
    timestamp?: number;
  }
  const [connectionStatus, setConnectionStatus] = useState<Record<number, ConnectionTestResult>>({});
  const [testingAll, setTestingAll] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch templates - api already returns data.data, so result is ChannelTemplate[]
      const templatesRes = await api.get<ChannelTemplate[]>('/channels/templates');
      if (templatesRes) {
        setTemplates(templatesRes.filter(t => t.configMethod === 'webhook' || t.configMethod === 'token'));
      }

      // Fetch accounts - api already returns data.data, so result is Account[]
      const accountsRes = await api.get<Account[]>('/config/accounts');
      if (accountsRes) {
        setAccounts(accountsRes);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
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
  const getStatusIndicator = (accountId: number) => {
    const result = connectionStatus[accountId];
    if (!result || result.status === 'untested') return { dot: '⚪', color: 'text-slate-400', label: '未测试' };
    if (result.status === 'testing') return { dot: '🟡', color: 'text-amber-500', label: '测试中...' };
    if (result.status === 'connected') return { dot: '🟢', color: 'text-green-500', label: '已连接' };
    return { dot: '🔴', color: 'text-red-500', label: '连接失败' };
  };

  const getMethodIcon = (method: ConfigMethod) => {
    switch (method) {
      case 'webhook': return Webhook;
      case 'token': return Settings;
    }
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

  const getTemplateIcon = (iconName: string) => {
    return iconMap[iconName] || MessageSquare;
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

  const selectTemplate = (template: ChannelTemplate) => {
    setSelectedTemplate(template);
    // 先关闭模板弹窗，稍后打开配置弹窗
    setShowTemplateModal(false);
    
    // 初始化表单
    const initialForm: Record<string, string> = { name: '' };
    template.fields.forEach(field => {
      initialForm[field.name] = '';
    });
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
    
    // Set modal back stack properly so cancel returns to main, not template
    setModalBackStack(['main', 'config']);
    setShowConfigModal(true);
  };

  const buildConfigFormFromAccount = (account: Account, template: ChannelTemplate): Record<string, string> => {
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
    return form;
  };

  const saveConfig = async () => {
    if (!selectedTemplate || !configForm.name.trim()) {
      alert('请填写渠道名称');
      return;
    }

    // Validate required fields
    for (const field of selectedTemplate.fields) {
      if (field.required && !configForm[field.name]?.trim()) {
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
      }
      
      const accountData = {
        name: configForm.name,
        type: selectedTemplate.id,
        configMethod: selectedTemplate.configMethod,
        webhook: webhook,
        token: configForm.token || undefined,
        chatId: chatId,
        secret: configForm.secret || undefined,
        sessionData: configForm.sessionData || undefined,
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

  const renderAccountCard = (account: Account) => {
    const template = templates.find(t => t.id === account.type);
    const Icon = template ? getTemplateIcon(template.icon) : MessageSquare;
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
                <Icon size={24} />
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
      <header className="sticky top-6 z-40 px-4 max-w-[90rem] mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={() => navigate(-1)} aria-label="返回">
              <ArrowLeft size={20} />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">通知渠道</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">配置您的提醒接收方式</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
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

      <main className="max-w-[90rem] mx-auto px-6 py-10 mt-2">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
          </div>
        ) : (
          <>
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
                <p className="text-slate-500 dark:text-slate-400 mb-6 max-w-md mx-auto">
                  添加通知渠道后，您可以在事件提醒时通过多种方式接收通知
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
              选择一个渠道类型进行配置，不同类型的渠道需要不同的认证方式
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
                    const Icon = getTemplateIcon(template.icon);
                    return (
                      <button
                        key={template.id}
                        onClick={() => selectTemplate(template)}
                        className="text-left p-4 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-700 hover:bg-primary-50/50 dark:hover:bg-primary-900/20 transition-all group min-h-11"
                      >
                        <div className="flex items-start gap-4">
                          <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 flex items-center justify-center group-hover:bg-primary-100 dark:group-hover:bg-primary-900/50 group-hover:text-primary-600 transition-colors">
                            <Icon size={24} />
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
        <DialogContent className="glass-panel rounded-[2rem]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              {canGoBack && (
                <button 
                  onClick={goBackInModal}
                  className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <ArrowLeft size={24} className="text-slate-600 dark:text-slate-400" />
                </button>
              )}
              <div className="flex items-center gap-3 flex-1">
                <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                  {selectedTemplate && (
                    (() => {
                      const Icon = getTemplateIcon(selectedTemplate.icon);
                      return <Icon size={24} />;
                    })()
                  )}
                </div>
                <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white">
                  {selectedTemplate ? (selectedAccount ? '编辑' : '配置') + ' ' + selectedTemplate.name : ''}
                </DialogTitle>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                渠道名称 *
              </label>
              <Input
                placeholder="例如：工作钉钉群"
                value={configForm.name || ''}
                onChange={(e) => setConfigForm({ ...configForm, name: e.target.value })}
                className="h-12"
              />
            </div>

            {selectedTemplate?.fields.map((field) => (
              <div key={field.name}>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {field.label} {field.required && '*'}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    placeholder={field.placeholder}
                    value={configForm[field.name] || ''}
                    onChange={(e) => setConfigForm({ ...configForm, [field.name]: e.target.value })}
                    className="w-full h-24 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                  />
                ) : field.type === 'select' ? (
                  <select
                    value={configForm[field.name] || '0'}
                    onChange={(e) => setConfigForm({ ...configForm, [field.name]: e.target.value })}
                    className="w-full h-12 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                    aria-label={field.label}
                  >
                    {['-2', '-1', '0', '1', '2'].map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={field.type}
                    placeholder={field.placeholder}
                    value={configForm[field.name] || ''}
                    onChange={(e) => setConfigForm({ ...configForm, [field.name]: e.target.value })}
                    className="h-12"
                  />
                )}
                {field.description && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {field.description}
                  </p>
                )}
              </div>
            ))}

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

            <div className="pt-4 flex gap-3">
              <Button
                variant="secondary"
                className="flex-1 h-12 rounded-2xl font-bold"
                onClick={() => {
                  // 点击取消返回上一级，而不是直接关闭
                  if (modalBackStack.length > 1) {
                    goBackInModal();
                  } else {
                    // 如果是第一层，返回到模板选择
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
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
