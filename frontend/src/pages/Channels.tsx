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
  Link2Off, ArrowLeft, Plus, ExternalLink, QrCode, Puzzle, Settings,
  Gamepad2, Hash, Building2, Terminal, Server, Video, Smartphone,
  Send, Grid3X3, Cloud, Zap, Phone, Shield, BookOpen, ChevronRight,
  Loader2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { NotificationAccount } from '@timemark/shared';

// Channel configuration method types
type ConfigMethod = 'webhook' | 'token' | 'plugin';

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
  pluginPackage?: string;
  pluginInstallCommand?: string;
  isBuiltIn: boolean;
}

interface Account extends NotificationAccount {
  is_active?: boolean;
}

// Icon mapping
const iconMap: Record<string, React.ElementType> = {
  MessageCircle, MessageSquare, Mail, Webhook, Gamepad2, Hash, Building2,
  Terminal, Server, Video, Smartphone, Send, Grid3X3, Cloud, Zap, Phone,
  Shield, BookOpen, Plus, Settings, Puzzle, QrCode
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
  const [showQrModal, setShowQrModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<ChannelTemplate | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [configForm, setConfigForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // QR code state for plugins
  const [qrCodeData, setQrCodeData] = useState<string>('');
  const [qrSessionId, setQrSessionId] = useState<string>('');
  const [authStatus, setAuthStatus] = useState<string>('pending');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch templates - api already returns data.data, so result is ChannelTemplate[]
      const templatesRes = await api.get<ChannelTemplate[]>('/channels/templates');
      if (templatesRes) {
        setTemplates(templatesRes);
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

  const getMethodIcon = (method: ConfigMethod) => {
    switch (method) {
      case 'webhook': return Webhook;
      case 'token': return Settings;
      case 'plugin': return Puzzle;
    }
  };

  const getMethodLabel = (method: ConfigMethod) => {
    switch (method) {
      case 'webhook': return 'Webhook';
      case 'token': return 'Token';
      case 'plugin': return '插件';
    }
  };

  const getMethodColor = (method: ConfigMethod) => {
    switch (method) {
      case 'webhook': return 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400';
      case 'token': return 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400';
      case 'plugin': return 'bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400';
    }
  };

  const getTemplateIcon = (iconName: string) => {
    return iconMap[iconName] || MessageSquare;
  };

  const getAccountStatus = (account: Account) => {
    if (!account.is_active) return 'disabled';
    if (account.configMethod === 'plugin' && !account.sessionData) return 'pending_auth';
    return 'connected';
  };

  const openTemplateModal = () => {
    setModalBackStack(['main']);
    setShowTemplateModal(true);
  };

  const selectTemplate = (template: ChannelTemplate) => {
    setSelectedTemplate(template);
    setModalBackStack([...modalBackStack, 'template']);
    setShowTemplateModal(false);
    
    // Initialize form with empty values
    const initialForm: Record<string, string> = { name: '' };
    template.fields.forEach(field => {
      initialForm[field.name] = '';
    });
    setConfigForm(initialForm);
    setShowConfigModal(true);
  };

  // Handle going back in modal navigation
  const goBackInModal = () => {
    const newStack = modalBackStack.slice(0, -1);
    const lastState = newStack[newStack.length - 1];
    setModalBackStack(newStack);
    
    if (lastState === 'main' || lastState === undefined) {
      // Go back to main list - close all modals
      setShowConfigModal(false);
      setShowTemplateModal(false);
      setShowQrModal(false);
    } else if (lastState === 'template') {
      setShowConfigModal(false);
      setShowTemplateModal(true);
    } else if (lastState === 'qr') {
      setShowQrModal(false);
      setShowConfigModal(true);
    }
  };

  // Check if we can go back
  const canGoBack = modalBackStack.length > 1;

  const openEditModal = (account: Account) => {
    const template = templates.find(t => t.id === account.type);
    if (!template) return;
    
    setSelectedTemplate(template);
    setSelectedAccount(account);
    
    // Initialize form with account values
    setConfigForm({
      name: account.name || '',
      webhook: account.webhook || '',
      token: account.token || '',
      chat_id: account.chatId || '',
      secret: (account as any).secret || '',
    });
    
    setShowConfigModal(true);
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
      const accountData = {
        name: configForm.name,
        type: selectedTemplate.id,
        configMethod: selectedTemplate.configMethod,
        webhook: configForm.webhook || undefined,
        token: configForm.token || undefined,
        chatId: configForm.chat_id || undefined,
        secret: configForm.secret || undefined,
      };

      if (selectedAccount) {
        // Update existing
        await api.put(`/config/accounts/${selectedAccount.id}`, accountData);
      } else {
        // Create new
        await api.post('/config/accounts', accountData);
      }

      setShowConfigModal(false);
      setSelectedTemplate(null);
      setSelectedAccount(null);
      setConfigForm({});
      fetchData();
    } catch (error) {
      console.error('Failed to save config:', error);
      alert('保存配置失败，请检查输入格式');
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

  const startPluginAuth = (template: ChannelTemplate) => {
    setSelectedTemplate(template);
    setShowQrModal(true);
  };

  const filteredTemplates = templates.filter(t => t.configMethod === activeTab);

  // Group accounts by status
  const connectedAccounts = accounts.filter(a => getAccountStatus(a) === 'connected');
  const pendingAccounts = accounts.filter(a => getAccountStatus(a) === 'pending_auth');
  const disabledAccounts = accounts.filter(a => getAccountStatus(a) === 'disabled');

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-[90rem] mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}>
              <ArrowLeft size={20} />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">通知渠道</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">配置您的提醒接收方式</p>
            </div>
          </div>
          <Button 
            variant="vision" 
            className="shadow-md shadow-primary-500/20 flex rounded-full px-5" 
            onClick={openTemplateModal}
          >
            <Plus size={16} className="mr-1.5"/> 添加渠道
          </Button>
        </div>
      </header>

      <main className="max-w-[90rem] mx-auto px-6 py-10 mt-2">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
          </div>
        ) : (
          <>
            {/* Connected Accounts */}
            {connectedAccounts.length > 0 && (
              <section className="mb-10">
                <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  已连接的渠道
                </h2>
                <motion.div 
                  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" 
                  variants={containerVariants} 
                  initial="hidden" 
                  animate="visible"
                >
                  {connectedAccounts.map((account) => {
                    const template = templates.find(t => t.id === account.type);
                    const Icon = template ? getTemplateIcon(template.icon) : MessageSquare;
                    
                    return (
                      <motion.div key={account.id} variants={itemVariants}>
                        <div className="glass-panel rounded-3xl p-6 transition-all duration-300 ring-1 ring-primary-500/30 shadow-lg shadow-primary-500/5">
                          <div className="flex items-start justify-between mb-4">
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 text-white flex items-center justify-center shadow-lg">
                                <Icon size={24} />
                              </div>
                              <div>
                                <h3 className="font-semibold text-slate-900 dark:text-white">{account.name}</h3>
                                <div className="flex items-center gap-2 mt-1">
                                  <Badge variant="success" className="gap-1 text-xs">
                                    <CheckCircle2 size={12} /> 已连接
                                  </Badge>
                                  {template && (
                                    <span className={`text-xs px-2 py-0.5 rounded-full ${getMethodColor(template.configMethod)}`}>
                                      {getMethodLabel(template.configMethod)}
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
                                className="rounded-lg"
                                onClick={() => openEditModal(account)}
                              >
                                <Settings size={14} className="mr-1" /> 配置
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="rounded-lg text-red-500 hover:text-red-600"
                                onClick={() => deleteAccount(account)}
                              >
                                <Link2Off size={14} className="mr-1" /> 删除
                              </Button>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </motion.div>
              </section>
            )}

            {/* Pending Auth Accounts (Plugin channels) */}
            {pendingAccounts.length > 0 && (
              <section className="mb-10">
                <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
                  <QrCode className="w-5 h-5 text-amber-500" />
                  等待授权
                </h2>
                <motion.div 
                  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" 
                  variants={containerVariants} 
                  initial="hidden" 
                  animate="visible"
                >
                  {pendingAccounts.map((account) => {
                    const template = templates.find(t => t.id === account.type);
                    const Icon = template ? getTemplateIcon(template.icon) : MessageSquare;
                    
                    return (
                      <motion.div key={account.id} variants={itemVariants}>
                        <div className="glass-panel rounded-3xl p-6 transition-all duration-300 ring-1 ring-amber-500/30 shadow-lg shadow-amber-500/5">
                          <div className="flex items-start justify-between mb-4">
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-white flex items-center justify-center shadow-lg">
                                <Icon size={24} />
                              </div>
                              <div>
                                <h3 className="font-semibold text-slate-900 dark:text-white">{account.name}</h3>
                                <div className="flex items-center gap-2 mt-1">
                                  <Badge variant="warning" className="gap-1 text-xs">
                                    <QrCode size={12} /> 待授权
                                  </Badge>
                                  <span className={`text-xs px-2 py-0.5 rounded-full ${getMethodColor('plugin')}`}>
                                    插件
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                          
                          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 mb-4">
                            <p className="text-sm text-amber-700 dark:text-amber-300">
                              需要扫码授权以激活此渠道
                            </p>
                          </div>
                          
                          <div className="flex items-center justify-between">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="rounded-lg border-amber-200"
                              onClick={() => template && startPluginAuth(template)}
                            >
                              <QrCode size={14} className="mr-1" /> 扫码授权
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              className="rounded-lg text-red-500"
                              onClick={() => deleteAccount(account)}
                            >
                              删除
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </motion.div>
              </section>
            )}

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
        if (!open && modalBackStack.length > 0) {
          goBackInModal();
        } else {
          setShowTemplateModal(open);
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
              <TabsList className="grid w-full grid-cols-3 mb-6">
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
                <TabsTrigger value="plugin" className="flex items-center gap-2">
                  <Puzzle size={16} />
                  插件
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {templates.filter(t => t.configMethod === 'plugin').length}
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
                        className="text-left p-4 rounded-2xl border border-slate-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-700 hover:bg-primary-50/50 dark:hover:bg-primary-900/20 transition-all group"
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
                              {template.configMethod === 'plugin' && !template.isBuiltIn && !template.pluginPackage?.startsWith('@') && (
                                <Badge variant="outline" className="text-xs">
                                  <Puzzle size={10} className="mr-1" />
                                  需安装
                                </Badge>
                              )}
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
        // Only allow closing via back button, not backdrop click
        if (!open) {
          // If there's history, go back; otherwise just close config but keep template modal open
          if (modalBackStack.length > 1) {
            goBackInModal();
          } else {
            // At the first level (config), close config and go back to template selection
            setShowConfigModal(false);
            setShowTemplateModal(true);
            setModalBackStack(['main', 'template']);
          }
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

          {selectedTemplate?.configMethod === 'plugin' && !selectedTemplate.isBuiltIn && (
            <div className="mb-6 p-4 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
              <div className="flex items-center gap-2 mb-2">
                <Puzzle className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                <span className="font-medium text-purple-900 dark:text-purple-200">
                  需要安装插件
                </span>
              </div>
              <p className="text-sm text-purple-700 dark:text-purple-300 mb-2">
                此渠道需要安装额外的 npm 包才能使用
              </p>
              {selectedTemplate.pluginInstallCommand && (
                <code className="block p-2 bg-slate-900 text-slate-100 rounded-lg text-sm font-mono">
                  {selectedTemplate.pluginInstallCommand}
                </code>
              )}
            </div>
          )}

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
                  setShowConfigModal(false);
                  setSelectedTemplate(null);
                  setSelectedAccount(null);
                  setConfigForm({});
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

      {/* QR Code Modal for Plugin Auth */}
      <Dialog open={showQrModal} onOpenChange={(open) => {
        if (!open && canGoBack) {
          goBackInModal();
        } else if (!open) {
          setShowQrModal(false);
          setModalBackStack([]);
        }
      }}>
        <DialogContent className="glass-panel rounded-[2rem] max-w-md">
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
              <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
                <div className="p-2 bg-purple-50 dark:bg-purple-900/30 rounded-xl text-purple-600 dark:text-purple-400">
                  <QrCode size={24} />
                </div>
                扫码授权
              </DialogTitle>
            </div>
          </DialogHeader>
          
          <div className="text-center py-8">
            <div className="w-48 h-48 mx-auto mb-6 bg-slate-100 dark:bg-slate-800 rounded-2xl flex items-center justify-center overflow-hidden">
              {qrCodeData ? (
                <img src={qrCodeData} alt="QR Code" className="w-full h-full object-contain" />
              ) : (
                <div className="text-center p-4">
                  <Loader2 className="w-12 h-12 mx-auto mb-2 text-slate-400 animate-spin" />
                  <p className="text-sm text-slate-500">加载中...</p>
                </div>
              )}
            </div>
            <p className="text-slate-600 dark:text-slate-300 mb-2">
              请使用 {selectedTemplate?.name} 扫描二维码
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {authStatus === 'authenticating' ? '正在验证...' : '扫码后将自动完成授权并启用此渠道'}
            </p>
          </div>

          {authStatus === 'authenticating' && (
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 mb-4">
              <div className="flex items-center gap-2">
                <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                <span className="text-sm text-blue-700 dark:text-blue-300">等待扫码验证...</span>
              </div>
            </div>
          )}

          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 mb-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-amber-500 mt-0.5" />
              <div className="text-sm text-amber-700 dark:text-amber-300">
                <p className="font-medium mb-1">注意</p>
                <p>插件渠道需要安装对应的 npm 包才能正常使用扫码功能。请确保已安装所需依赖。</p>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1 h-12 rounded-2xl font-bold"
              onClick={() => setShowQrModal(false)}
            >
              稍后授权
            </Button>
            <Button
              variant="vision"
              className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30"
              onClick={() => setShowQrModal(false)}
            >
              我已扫码
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
