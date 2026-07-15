import { useState, useEffect } from 'react';
import { User, Shield, Bell, HardDrive, Smartphone, ChevronRight, ArrowLeft, LogOut, Camera, CalendarClock, Globe, Mail, Settings as SettingsIcon } from 'lucide-react';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

const TIMEZONES = [
  { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '日本标准时间 (UTC+9)' },
  { value: 'Asia/Singapore', label: '新加坡时间 (UTC+8)' },
  { value: 'Asia/Kolkata', label: '印度标准时间 (UTC+5:30)' },
  { value: 'Europe/London', label: '格林威治时间 (UTC+0)' },
  { value: 'Europe/Paris', label: '中欧时间 (UTC+1)' },
  { value: 'Europe/Moscow', label: '莫斯科时间 (UTC+3)' },
  { value: 'America/New_York', label: '美国东部时间 (UTC-5)' },
  { value: 'America/Chicago', label: '美国中部时间 (UTC-6)' },
  { value: 'America/Los_Angeles', label: '美国太平洋时间 (UTC-8)' },
  { value: 'Australia/Sydney', label: '澳大利亚东部时间 (UTC+10)' },
  { value: 'Pacific/Auckland', label: '新西兰时间 (UTC+12)' },
];

function parseAlertChannels(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function ensureArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? data : [];
}

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  
  // Modal states
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  
  // Original user data for reset
  const [originalProfile, setOriginalProfile] = useState({
    username: user?.username || '',
    email: 'admin@timemark.app',
  });
  
  // Form states
  const [profileForm, setProfileForm] = useState({
    username: user?.username || '',
    email: 'admin@timemark.app',
  });
  
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  
  // Alert channel states
  const [alertAccounts, setAlertAccounts] = useState<any[]>([]);
  const [selectedAlertChannels, setSelectedAlertChannels] = useState<string[]>([]);
  const [alertSaving, setAlertSaving] = useState(false);

  // Timezone setting
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [defaultTestEmail, setDefaultTestEmail] = useState('');
  const [defaultReminderEmails, setDefaultReminderEmails] = useState('');
  const [notificationDefaultsSaving, setNotificationDefaultsSaving] = useState(false);
  const [emailLogs, setEmailLogs] = useState<any[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);

  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPageLoading(true);
    setPageError('');
    Promise.all([
      api.get<{ timezone?: string; alert_channels?: unknown; default_test_email?: string; reminder_emails?: string[] }>('/config').catch(() => null),
      api.get('/config/accounts').catch(() => []),
      api.get<any[]>('/email-logs?limit=50').catch(() => []),
    ])
      .then(([config, accounts, logs]) => {
        if (cancelled) return;
        if (config?.timezone) setTimezone(config.timezone);
        if (config?.default_test_email) setDefaultTestEmail(config.default_test_email);
        if (Array.isArray(config?.reminder_emails)) {
          setDefaultReminderEmails(config.reminder_emails.join(', '));
        }
        if (config?.alert_channels != null) {
          setSelectedAlertChannels(parseAlertChannels(config.alert_channels));
        }
        setAlertAccounts(ensureArray(accounts));
        setEmailLogs(ensureArray(logs));
      })
      .catch((e) => {
        if (!cancelled) setPageError(e instanceof Error ? e.message : '加载设置失败');
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const saveNotificationDefaults = async () => {
    setNotificationDefaultsSaving(true);
    try {
      const reminderList = defaultReminderEmails
        .split(/[,，\s]+/)
        .map((e) => e.trim())
        .filter(Boolean);
      await api.post('/config/notification-defaults', {
        default_test_email: defaultTestEmail.trim() || null,
        reminder_emails: reminderList.length ? reminderList : [],
      });
      alert('通知默认设置已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setNotificationDefaultsSaving(false);
    }
  };

  const clearEmailLogs = async () => {
    if (!confirm('确定清空近30天内的邮件发送记录？')) return;
    try {
      await api.delete('/email-logs');
      setEmailLogs([]);
    } catch (e) {
      alert(e instanceof Error ? e.message : '清空失败');
    }
  };

  const handleTimezoneChange = async (value: string) => {
    setTimezone(value);
    try {
      await api.post('/config', { timezone: value });
    } catch (error) {
      console.error('Failed to save timezone:', error);
    }
  };

  // Sound setting with localStorage persistence
  const [soundEnabled, setSoundEnabled] = useState(() => {
    return localStorage.getItem('timemark_sound_enabled') !== 'false';
  });

  const handleSoundToggle = (checked: boolean) => {
    setSoundEnabled(checked);
    localStorage.setItem('timemark_sound_enabled', String(checked));
  };

  const toggleAlertChannel = (type: string) => {
    setSelectedAlertChannels(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]);
  };

  const saveAlertChannels = async () => {
    setAlertSaving(true);
    try { await api.post('/config', { alert_channels: selectedAlertChannels }); } catch (e) { console.error(e); }
    setAlertSaving(false);
  };

  const handleExportData = async () => {
    setBackupLoading(true);
    try {
      const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
      const response = await fetch('/api/data/export', {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error('导出失败');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timemark-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert('导出失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setBackupLoading(false);
    }
  };

  const handleImportData = async (file: File) => {
    if (!confirm('导入将合并数据到当前账户，是否继续？')) return;
    setBackupLoading(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await api.post<{ events: number; mappings: number; templates: number }>('/data/import', data);
      alert(`导入完成：事件 ${result.events} 条，关系映射 ${result.mappings} 条，模板 ${result.templates} 条`);
    } catch (error) {
      alert('导入失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setBackupLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    try {
      await api.put('/user/profile', {
        username: profileForm.username,
        email: profileForm.email,
      });
      
      // Update local user state
      const currentUser = useAuthStore.getState().user;
      if (currentUser) {
        useAuthStore.getState().setUser({
          ...currentUser,
          username: profileForm.username,
        });
      }
      
      // Update original profile for future resets
      setOriginalProfile(profileForm);
      
      alert('个人信息保存成功');
      setShowProfileModal(false);
    } catch (error) {
      console.error('Failed to save profile:', error);
      alert('保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  };
  
  // Handle modal close - reset form to original values
  const handleCloseProfileModal = (open: boolean) => {
    setShowProfileModal(open);
    if (!open) {
      // Reset form to original values when closing
      setProfileForm(originalProfile);
      setAvatarUrl(user?.avatarUrl || '');
    }
  };

  const handleAvatarUrlChange = async (url: string) => {
    setAvatarUrl(url);
    
    // Don't update if empty
    if (!url.trim()) return;
    
    // Validate URL format
    try {
      new URL(url);
    } catch {
      return; // Invalid URL, don't upload yet
    }
    
    setUploadingAvatar(true);
    try {
      await api.post('/auth/avatar', { avatarUrl: url });
      // Update local user state
      const currentUser = useAuthStore.getState().user;
      if (currentUser) {
        useAuthStore.getState().setUser({
          ...currentUser,
          avatarUrl: url
        });
      }
    } catch (error) {
      console.error('Failed to update avatar:', error);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleChangePassword = async () => {
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      alert('两次输入的密码不一致');
      return;
    }
    
    if (passwordForm.newPassword.length < 8) {
      alert('新密码至少需要8个字符');
      return;
    }

    try {
      await api.post('/auth/change-password', {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      alert('密码修改成功');
      setShowPasswordModal(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (error: any) {
      console.error('Failed to change password:', error);
      alert(error.message || '密码修改失败');
    }
  };

  const handleLogout = async () => {
    if (confirm('确定要退出登录吗？')) {
      await logout();
      navigate('/login');
    }
  };

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center pb-24">
        <div className="animate-spin h-8 w-8 border-b-2 border-primary-500 rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-3xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex items-center gap-4 ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">系统设置</h1>
          </div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10 mt-2">
        {pageError && (
          <div className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            部分配置加载失败：{pageError}
          </div>
        )}
        <div className="space-y-8">
          {/* 个人信息 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">个人信息</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10">
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => setShowProfileModal(true)}
              >
                <div className="flex items-center gap-5">
                  {user?.avatarUrl ? (
                    <img 
                      src={user.avatarUrl} 
                      alt={user?.username}
                      className="w-16 h-16 rounded-full object-cover shadow-inner"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-primary-500 to-indigo-600 flex items-center justify-center text-white shadow-inner">
                      <span className="text-2xl font-bold">{user?.username?.charAt(0).toUpperCase() || 'A'}</span>
                    </div>
                  )}
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">{user?.username || 'Admin'}</h3>
                    <p className="text-sm text-slate-500 font-medium">点击修改资料</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </section>

          {/* 外观与通知 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">外观与通知</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 space-y-1 ring-1 ring-black/5 dark:ring-white/10">
              <div className="flex items-center justify-between p-4 rounded-[2rem]">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 flex items-center justify-center shadow-inner border border-blue-100 dark:border-blue-800/50">
                    <Smartphone size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">深色模式</h3>
                    <p className="text-xs text-slate-500">手动切换系统主题</p>
                  </div>
                </div>
                <ThemeToggle />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div className="flex items-center justify-between p-4 rounded-[2rem]">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 flex items-center justify-center shadow-inner border border-orange-100 dark:border-orange-800/50">
                    <Bell size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">应用内提醒声音</h3>
                    <p className="text-xs text-slate-500">倒计时结束时播放提示音</p>
                  </div>
                </div>
                <Switch checked={soundEnabled} onCheckedChange={handleSoundToggle} />
              </div>
            </div>
          </section>

          {/* 通知默认邮箱 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">通知默认邮箱</h2>
            <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                渠道测试、事件未单独配置收件人时，将使用以下邮箱。建议填写你常用的收件地址。
              </p>
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">默认测试/收件邮箱</label>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={defaultTestEmail}
                  onChange={(e) => setDefaultTestEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">默认提醒收件人（多个用逗号分隔）</label>
                <Input
                  placeholder="a@example.com, b@example.com"
                  value={defaultReminderEmails}
                  onChange={(e) => setDefaultReminderEmails(e.target.value)}
                />
              </div>
              <Button onClick={saveNotificationDefaults} disabled={notificationDefaultsSaving} className="w-full">
                {notificationDefaultsSaving ? '保存中...' : '保存通知邮箱设置'}
              </Button>
            </div>
          </section>

          {/* 邮件记录（近30天） */}
          <section>
            <div className="flex items-center justify-between mb-3 px-4">
              <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">邮件记录（近30天）</h2>
              {emailLogs.length > 0 && (
                <button type="button" onClick={clearEmailLogs} className="text-xs text-red-500">清空</button>
              )}
            </div>
            <div className="glass-panel rounded-[2.5rem] p-4 ring-1 ring-black/5 dark:ring-white/10 max-h-64 overflow-y-auto">
              {emailLogs.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">暂无邮件记录</p>
              ) : (
                <ul className="space-y-2">
                  {emailLogs.map((log: any) => (
                    <li key={log.id} className="text-sm border-b border-slate-100 dark:border-slate-800 pb-2 last:border-0">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{log.recipient}</span>
                        <span className={log.status === 'sent' ? 'text-emerald-600' : 'text-red-500'}>{log.status === 'sent' ? '已发送' : '失败'}</span>
                      </div>
                      <p className="text-xs text-slate-400 truncate">{log.subject || log.channel_type} · {log.sent_at ? new Date(log.sent_at).toLocaleString('zh-CN') : ''}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 时区设置 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">时区设置</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10">
              <div className="flex items-center justify-between p-4 rounded-[2rem]">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 flex items-center justify-center shadow-inner border border-teal-100 dark:border-teal-800/50">
                    <Globe size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">系统时区</h3>
                    <p className="text-xs text-slate-500">用于事件提醒的时间计算</p>
                  </div>
                </div>
                <select
                  value={timezone}
                  onChange={(e) => handleTimezoneChange(e.target.value)}
                  className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {/* 安全与数据 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">安全与数据</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 space-y-1 ring-1 ring-black/5 dark:ring-white/10">
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => setShowPasswordModal(true)}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center shadow-inner border border-emerald-100 dark:border-emerald-800/50">
                    <Shield size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">修改密码</h3>
                    <p className="text-xs text-slate-500">定期更新密码保护账户安全</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => navigate('/security')}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 flex items-center justify-center shadow-inner border border-indigo-100 dark:border-indigo-800/50">
                    <Shield size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">安全中心</h3>
                    <p className="text-xs text-slate-500">2FA、会话、IP 白名单与封禁</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => navigate('/deploy-wizard')}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-amber-50 dark:bg-amber-900/30 text-amber-600 flex items-center justify-center shadow-inner border border-amber-100 dark:border-amber-800/50">
                    <SettingsIcon size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">部署向导</h3>
                    <p className="text-xs text-slate-500">环境检查与 Cron 配置</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => navigate('/login-history')}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 flex items-center justify-center shadow-inner border border-purple-100 dark:border-purple-800/50">
                    <Shield size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">登录日志</h3>
                    <p className="text-xs text-slate-500">查看近期登录历史与设备</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div className="flex items-center justify-between p-4 rounded-[2rem]">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-sky-50 dark:bg-sky-900/30 text-sky-600 flex items-center justify-center shadow-inner border border-sky-100 dark:border-sky-800/50">
                    <HardDrive size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">数据备份</h3>
                    <p className="text-xs text-slate-500">导出或导入全部事件与配置</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={backupLoading} onClick={handleExportData}>
                    导出
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={backupLoading}
                    onClick={() => document.getElementById('timemark-import-input')?.click()}
                  >
                    导入
                  </Button>
                  <input
                    id="timemark-import-input"
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImportData(file);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* 安全告警渠道 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
              <Shield className="w-4 h-4" /> 安全告警渠道
            </h2>
            <div className="glass-panel rounded-[2.5rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
              <p className="text-sm text-slate-500 mb-4">选择接收安全告警的通知渠道（登录失败、账户锁定等）</p>
              {alertAccounts.length === 0 ? (
                <p className="text-sm text-slate-400">请先<a href="/channels" className="text-indigo-500 underline ml-1">配置通知渠道</a></p>
              ) : (
                <div className="space-y-3">
                  {alertAccounts.filter((a: any) => a.is_active).map((account: any) => (
                    <label key={account.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer">
                      <input type="checkbox" checked={selectedAlertChannels.includes(account.type)} onChange={() => toggleAlertChannel(account.type)} className="w-4 h-4 rounded border-slate-300" />
                      <span className="text-sm font-medium">{account.name}</span>
                      <span className="text-xs text-slate-400">({account.type})</span>
                    </label>
                  ))}
                  <button onClick={saveAlertChannels} disabled={alertSaving} className="mt-4 px-4 py-2 bg-indigo-500 text-white rounded-xl text-sm hover:bg-indigo-600 disabled:opacity-50">
                    {alertSaving ? '保存中...' : '保存告警渠道'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* 联系人与批量邮件 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">联系人与群发</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10 space-y-1">
              <div className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer" onClick={() => navigate('/contacts')}>
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center"><User size={22} /></div>
                  <div>
                    <h3 className="text-base font-bold">固定联系人</h3>
                    <p className="text-xs text-slate-500">快捷用于提醒与批量邮件</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer" onClick={() => navigate('/broadcast')}>
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 flex items-center justify-center"><Mail size={22} /></div>
                  <div>
                    <h3 className="text-base font-bold">批量邮件</h3>
                    <p className="text-xs text-slate-500">向联系人或指定邮箱群发</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </section>

          {/* 事件模板 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">事件模板</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10">
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => navigate('/templates')}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 flex items-center justify-center shadow-inner border border-indigo-100 dark:border-indigo-800/50">
                    <CalendarClock size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">管理事件模板</h3>
                    <p className="text-xs text-slate-500">创建常用事件模板（如驾照到期、保险续费）</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </section>

          {/* 退出登录 */}
          <div className="pt-4">
            <Button 
              variant="destructive" 
              className="w-full h-14 rounded-2xl text-base font-bold shadow-lg shadow-red-500/20"
              onClick={handleLogout}
            >
              <LogOut size={20} className="mr-2" />
              退出登录
            </Button>
          </div>
        </div>
      </main>

      {/* 编辑资料弹窗 */}
      <Dialog open={showProfileModal} onOpenChange={handleCloseProfileModal}>
        <DialogContent className="glass-panel rounded-[2.5rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                <User size={20} />
              </div>
              修改个人资料
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="flex justify-center mb-6">
              <div className="relative">
                {avatarUrl ? (
                  <img 
                    src={avatarUrl} 
                    alt="Avatar preview"
                    className="w-20 h-20 rounded-full object-cover shadow-lg"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-primary-500 to-indigo-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg">
                    {user?.username?.charAt(0).toUpperCase() || 'A'}
                  </div>
                )}
                <div className="absolute bottom-0 right-0 p-1.5 bg-primary-500 rounded-full text-white shadow-lg">
                  <Camera size={14} />
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">头像链接</label>
              <Input 
                placeholder="https://example.com/avatar.jpg"
                value={avatarUrl}
                onChange={(e) => handleAvatarUrlChange(e.target.value)}
                className="h-12"
              />
              <p className="text-xs text-slate-500 mt-1">输入图片链接即可更新头像</p>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">用户名</label>
              <Input 
                value={profileForm.username}
                onChange={(e) => setProfileForm({ ...profileForm, username: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">联系邮箱</label>
              <Input 
                type="email" 
                value={profileForm.email}
                onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                className="h-12"
              />
            </div>
            <div className="pt-4 flex gap-3">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => handleCloseProfileModal(false)}>取消</Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30" onClick={handleSaveProfile}>保存修改</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 修改密码弹窗 */}
      <Dialog open={showPasswordModal} onOpenChange={setShowPasswordModal}>
        <DialogContent className="glass-panel rounded-[2.5rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                <Shield size={20} />
              </div>
              修改密码
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">当前密码</label>
              <Input 
                type="password" 
                value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">新密码</label>
              <Input 
                type="password" 
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">确认新密码</label>
              <Input 
                type="password" 
                value={passwordForm.confirmPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                className="h-12"
              />
            </div>
            <div className="pt-4 flex gap-3">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => setShowPasswordModal(false)}>取消</Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30" onClick={handleChangePassword}>更新密码</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <MobileBottomNav />
    </div>
  );
}