import { useState, useEffect } from 'react';
import { User, Shield, Bell, HardDrive, Smartphone, ChevronRight, ArrowLeft, LogOut, Camera, CalendarClock, Globe, Mail, Settings as SettingsIcon, Link2, Copy, RefreshCw, Plus, Trash2, GitBranch, Languages } from 'lucide-react';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { getLang, setLang } from '@/i18n';

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
  const [selectedAlertAccountIds, setSelectedAlertAccountIds] = useState<number[]>([]);
  const [alertEmails, setAlertEmails] = useState('');
  const [alertSaving, setAlertSaving] = useState(false);

  // Timezone setting
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [quietHoursStart, setQuietHoursStart] = useState('');
  const [quietHoursEnd, setQuietHoursEnd] = useState('');
  const [quietHoursSaving, setQuietHoursSaving] = useState(false);
  const [defaultTestEmail, setDefaultTestEmail] = useState('');
  const [defaultReminderEmails, setDefaultReminderEmails] = useState('');
  const [notificationDefaultsSaving, setNotificationDefaultsSaving] = useState(false);
  const [emailLogs, setEmailLogs] = useState<any[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);

  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState('');

  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [inboxReceiveUrl, setInboxReceiveUrl] = useState<string | null>(null);
  const [calendarFeedUrl, setCalendarFeedUrl] = useState<string | null>(null);
  const [externalCalendarUrls, setExternalCalendarUrls] = useState<string[]>([]);
  const [calendarFeedTokens, setCalendarFeedTokens] = useState<Array<{ name: string; url: string }>>([]);
  const [syncStrategy, setSyncStrategy] = useState<'add_only' | 'replace'>('add_only');
  const [caldavUrl, setCaldavUrl] = useState('');
  const [caldavUsername, setCaldavUsername] = useState('');
  const [caldavPassword, setCaldavPassword] = useState('');
  const [encryptBackupPassword, setEncryptBackupPassword] = useState('');
  const [integrationsSaving, setIntegrationsSaving] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [markdownTemplate, setMarkdownTemplate] = useState('');
  const [apiScopes, setApiScopes] = useState('read,write');
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [uiLang, setUiLang] = useState<'zh' | 'en'>(getLang());
  const [googleOAuth, setGoogleOAuth] = useState<{
    configured: boolean;
    connected: boolean;
    email: string | null;
    calendarId: string;
  }>({ configured: false, connected: false, email: null, calendarId: 'primary' });
  const [googleSyncLoading, setGoogleSyncLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPageLoading(true);
    setPageError('');
    Promise.all([
      api.get<{ timezone?: string; alert_channels?: unknown; alert_emails?: string[]; alert_account_ids?: number[]; default_test_email?: string; reminder_emails?: string[]; quiet_hours_start?: string | null; quiet_hours_end?: string | null }>('/config').catch(() => null),
      api.get('/config/accounts').catch(() => []),
      api.get<any[]>('/email-logs?limit=50').catch(() => []),
      api.get<{
        webhookUrl?: string | null;
        inboxReceiveUrl?: string | null;
        calendarFeedUrl?: string | null;
        calendarFeedTokens?: Array<{ name: string; url: string }>;
        externalCalendarUrls?: string[];
        externalCalendarSyncStrategy?: string;
      }>('/calendar/integrations').catch(() => null),
      api.get<{ markdown_email_template?: string | null; api_scopes?: string }>('/config/notification-advanced').catch(() => null),
      api.get<{ configured?: boolean; connected?: boolean; email?: string | null; calendarId?: string }>('/calendar/google-oauth/status').catch(() => null),
    ])
      .then(([config, accounts, logs, integrations, advanced, googleStatus]) => {
        if (cancelled) return;
        if (config?.timezone) setTimezone(config.timezone);
        if (config?.quiet_hours_start) setQuietHoursStart(config.quiet_hours_start);
        if (config?.quiet_hours_end) setQuietHoursEnd(config.quiet_hours_end);
        if (config?.default_test_email) setDefaultTestEmail(config.default_test_email);
        if (Array.isArray(config?.reminder_emails)) {
          setDefaultReminderEmails(config.reminder_emails.join(', '));
        }
        if (Array.isArray(config?.alert_emails)) {
          setAlertEmails(config.alert_emails.join(', '));
        }
        const accountList = ensureArray<any>(accounts);
        if (Array.isArray(config?.alert_account_ids)) {
          setSelectedAlertAccountIds(config.alert_account_ids);
        } else if (config?.alert_channels != null) {
          const legacyTypes = parseAlertChannels(config.alert_channels);
          const legacyIds = accountList
            .filter((a: any) => a.is_active && legacyTypes.includes(a.type))
            .map((a: any) => Number(a.id));
          setSelectedAlertAccountIds(legacyIds);
        }
        setAlertAccounts(accountList);
        setEmailLogs(ensureArray(logs));
        if (integrations) {
          setWebhookUrl(integrations.webhookUrl ?? null);
          setInboxReceiveUrl(integrations.inboxReceiveUrl ?? null);
          setCalendarFeedUrl(integrations.calendarFeedUrl ?? null);
          setExternalCalendarUrls(Array.isArray(integrations.externalCalendarUrls) ? integrations.externalCalendarUrls : []);
          setCalendarFeedTokens(Array.isArray(integrations.calendarFeedTokens) ? integrations.calendarFeedTokens : []);
          if (integrations.externalCalendarSyncStrategy === 'replace') setSyncStrategy('replace');
        }
        if (advanced?.markdown_email_template) setMarkdownTemplate(advanced.markdown_email_template);
        if (advanced?.api_scopes) setApiScopes(advanced.api_scopes);
        if (googleStatus) {
          setGoogleOAuth({
            configured: !!googleStatus.configured,
            connected: !!googleStatus.connected,
            email: googleStatus.email ?? null,
            calendarId: googleStatus.calendarId || 'primary',
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setPageError(e instanceof Error ? e.message : '加载设置失败');
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get('google');
    if (google === 'connected') {
      alert('Google 日历已成功连接');
      params.delete('google');
      window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
      api.get<{ configured?: boolean; connected?: boolean; email?: string | null; calendarId?: string }>('/calendar/google-oauth/status')
        .then((s) => setGoogleOAuth({
          configured: !!s?.configured,
          connected: !!s?.connected,
          email: s?.email ?? null,
          calendarId: s?.calendarId || 'primary',
        }))
        .catch(() => {});
    } else if (google === 'error') {
      alert(`Google 日历连接失败：${params.get('reason') || '未知错误'}`);
      params.delete('google');
      params.delete('reason');
      window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
    }
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

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert(`${label}已复制`);
    } catch {
      alert('复制失败，请手动选择复制');
    }
  };

  const saveIntegrations = async () => {
    setIntegrationsSaving(true);
    try {
      await api.post('/calendar/integrations', {
        externalCalendarUrls: externalCalendarUrls.filter((u) => u.trim()),
        externalCalendarSyncStrategy: syncStrategy,
      });
      alert('外部日历 URL 已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setIntegrationsSaving(false);
    }
  };

  const addFeedToken = async () => {
    const name = prompt('Feed 名称', `日历 ${calendarFeedTokens.length + 1}`);
    if (!name) return;
    try {
      const result = await api.post<{ url: string }>('/calendar/feed-tokens', { name });
      setCalendarFeedTokens((prev) => [...prev, { name, url: result.url }]);
    } catch (e) {
      alert(e instanceof Error ? e.message : '创建失败');
    }
  };

  const saveCalDav = async () => {
    setIntegrationsSaving(true);
    try {
      await api.post('/calendar/caldav', {
        url: caldavUrl.trim(),
        username: caldavUsername.trim(),
        password: caldavPassword || undefined,
      });
      setCaldavPassword('');
      alert('CalDAV 配置已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setIntegrationsSaving(false);
    }
  };

  const handleEncryptedExport = async () => {
    if (!encryptBackupPassword || encryptBackupPassword.length < 8) {
      alert('加密导出需要至少 8 位密码');
      return;
    }
    setBackupLoading(true);
    try {
      const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
      const response = await fetch('/api/data/export-encrypted', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ password: encryptBackupPassword }),
      });
      if (!response.ok) throw new Error('加密导出失败');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timemark-encrypted-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      window.URL.revokeObjectURL(url);
      setEncryptBackupPassword('');
    } catch (error) {
      alert(error instanceof Error ? error.message : '加密导出失败');
    } finally {
      setBackupLoading(false);
    }
  };

  const syncExternalCalendars = async () => {
    setSyncLoading(true);
    setSyncResult(null);
    try {
      const result = await api.post<{ imported: number; deleted?: number; errors: string[] }>('/calendar/sync-external');
      const parts = [`导入 ${result.imported} 条`];
      if (result.deleted) parts.push(`删除旧数据 ${result.deleted} 条`);
      const msg = result.errors?.length
        ? `${parts.join('，')}；${result.errors.length} 个错误`
        : `成功${parts.join('，')}`;
      setSyncResult(msg);
    } catch (e) {
      setSyncResult(e instanceof Error ? e.message : '同步失败');
    } finally {
      setSyncLoading(false);
    }
  };

  const connectGoogleCalendar = async () => {
    try {
      const result = await api.get<{ authUrl: string }>('/calendar/google-oauth/start');
      if (result.authUrl) window.location.href = result.authUrl;
    } catch (e) {
      alert(e instanceof Error ? e.message : '无法启动 Google 授权');
    }
  };

  const disconnectGoogleCalendar = async () => {
    if (!confirm('确定断开 Google 日历连接？')) return;
    try {
      await api.delete('/calendar/google-oauth');
      setGoogleOAuth((prev) => ({ ...prev, connected: false, email: null }));
      alert('已断开 Google 日历');
    } catch (e) {
      alert(e instanceof Error ? e.message : '断开失败');
    }
  };

  const syncGoogleCalendar = async () => {
    setGoogleSyncLoading(true);
    setSyncResult(null);
    try {
      const result = await api.post<{ imported: number; deleted?: number; errors: string[] }>('/calendar/google-oauth/sync');
      const parts = [`Google 导入 ${result.imported} 条`];
      if (result.deleted) parts.push(`删除 ${result.deleted} 条`);
      setSyncResult(result.errors?.length ? `${parts.join('，')}；${result.errors.join('; ')}` : parts.join('，'));
    } catch (e) {
      setSyncResult(e instanceof Error ? e.message : 'Google 同步失败');
    } finally {
      setGoogleSyncLoading(false);
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

  const saveQuietHours = async () => {
    setQuietHoursSaving(true);
    try {
      await api.post('/config', {
        quiet_hours_start: quietHoursStart.trim() || null,
        quiet_hours_end: quietHoursEnd.trim() || null,
      });
      alert('免打扰时段已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setQuietHoursSaving(false);
    }
  };

  const saveAdvancedNotification = async () => {
    setAdvancedSaving(true);
    try {
      await api.post('/config/notification-advanced', {
        markdown_email_template: markdownTemplate.trim() || null,
        api_scopes: apiScopes,
      });
      alert('高级通知设置已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setAdvancedSaving(false);
    }
  };

  const handleLangChange = (lang: 'zh' | 'en') => {
    setUiLang(lang);
    setLang(lang);
  };

  // Sound setting with localStorage persistence
  const [soundEnabled, setSoundEnabled] = useState(() => {
    return localStorage.getItem('timemark_sound_enabled') !== 'false';
  });

  const handleSoundToggle = (checked: boolean) => {
    setSoundEnabled(checked);
    localStorage.setItem('timemark_sound_enabled', String(checked));
  };

  const toggleAlertAccount = (accountId: number) => {
    setSelectedAlertAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId],
    );
  };

  const saveAlertChannels = async () => {
    setAlertSaving(true);
    try {
      const emails = alertEmails.split(/[,，\s]+/).map((e) => e.trim()).filter((e) => e.includes('@'));
      await api.post('/config/alert-settings', {
        alert_emails: emails,
        alert_account_ids: selectedAlertAccountIds,
      });
      alert('安全告警设置已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setAlertSaving(false);
    }
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
      <header className="sticky top-6 z-40 px-4 max-w-3xl mx-auto" role="banner">
        <div className="glass-panel rounded-full px-6 py-3.5 flex items-center gap-4 ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)} aria-label="返回上一页"><ArrowLeft size={20} aria-hidden /></Button>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">系统设置</h1>
          </div>
        </div>
      </header>
      <main id="main-content" className="max-w-3xl mx-auto px-6 py-10 mt-2" tabIndex={-1}>
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
                    <p className="text-xs text-hint">点击切换；新主题从触点圆形扩散</p>
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
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
              <Mail className="w-4 h-4" /> 通知默认邮箱
            </h2>
            <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                渠道测试、事件未单独配置收件人时，将使用以下邮箱。Resend 等邮件渠道也可在「通知渠道」中为每个账号单独填写收件人。
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

          {/* 集成 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
              <Link2 className="w-4 h-4" /> 集成
            </h2>
            <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Webhook 入站创建事件；收件箱接收外部消息；日历 Feed 供 Google/Outlook 订阅；外部 ICS URL 定期同步导入。
              </p>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">收件箱接收 URL</label>
                <div className="flex gap-2">
                  <Input readOnly value={inboxReceiveUrl || '加载中...'} className="font-mono text-xs" />
                  {inboxReceiveUrl && (
                    <Button variant="outline" size="icon" onClick={() => copyToClipboard(inboxReceiveUrl, '收件箱接收 URL')}>
                      <Copy size={16} />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">POST JSON: {"{ title, body, sender? }"}；可配置 X-Timemark-Signature 签名</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">Webhook 入站 URL</label>
                <div className="flex gap-2">
                  <Input readOnly value={webhookUrl || '加载中...'} className="font-mono text-xs" />
                  {webhookUrl && (
                    <Button variant="outline" size="icon" onClick={() => copyToClipboard(webhookUrl, 'Webhook URL')}>
                      <Copy size={16} />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">POST JSON: {"{ name, date, type? }"}</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">日历 Feed URL（ICS）</label>
                <div className="flex gap-2">
                  <Input readOnly value={calendarFeedUrl || '加载中...'} className="font-mono text-xs" />
                  {calendarFeedUrl && (
                    <Button variant="outline" size="icon" onClick={() => copyToClipboard(calendarFeedUrl, '日历 Feed URL')}>
                      <Copy size={16} />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">在 Google Calendar / Outlook 中添加「通过 URL 订阅」</p>
                {calendarFeedTokens.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs font-mono">
                    {calendarFeedTokens.map((t) => (
                      <li key={t.url} className="flex gap-2 items-center">
                        <span className="text-slate-500 shrink-0">{t.name}:</span>
                        <span className="truncate">{t.url}</span>
                        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => copyToClipboard(t.url, t.name)}>
                          <Copy size={14} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <Button variant="outline" size="sm" className="mt-2 min-h-11" onClick={addFeedToken}>新建 Feed Token</Button>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-2 block">Google 日历 OAuth 同步（可选 · 只读）</label>
                {!googleOAuth.configured ? (
                  <p className="text-xs text-slate-400">
                    未启用。不配置不影响提醒、ICS 订阅等现有功能；仅需从 Google 主日历自动导入时，由管理员在 Vercel 配置 OAuth 环境变量后 redeploy。
                    <Button variant="link" size="sm" className="h-auto p-0 ml-1 text-xs" onClick={() => navigate('/integrations-docs#google-oauth')}>
                      查看配置说明
                    </Button>
                  </p>
                ) : googleOAuth.connected ? (
                  <div className="space-y-2">
                    <p className="text-sm text-emerald-600 dark:text-emerald-400">已连接：{googleOAuth.email || 'Google 账户'} · 日历 {googleOAuth.calendarId}</p>
                    <p className="text-xs text-slate-400">Cron `/api/cron/calendar-sync` 会按上方「外部 ICS 同步策略」自动同步 primary 日历</p>
                    <div className="flex gap-2 flex-wrap">
                      <Button size="sm" variant="secondary" className="min-h-11" onClick={syncGoogleCalendar} disabled={googleSyncLoading}>
                        <RefreshCw size={14} className={`mr-1 ${googleSyncLoading ? 'animate-spin' : ''}`} aria-hidden />
                        {googleSyncLoading ? '同步中...' : '立即同步 Google'}
                      </Button>
                      <Button size="sm" variant="outline" className="min-h-11" onClick={disconnectGoogleCalendar}>断开连接</Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-xs text-slate-400 mb-2">OAuth 授权后可自动从 Google 主日历导入事件（只读，需 refresh token）</p>
                    <Button size="sm" className="min-h-11" onClick={connectGoogleCalendar}>连接 Google 日历</Button>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-2 block">CalDAV 只读订阅</label>
                <Input placeholder="CalDAV / ICS URL" value={caldavUrl} onChange={(e) => setCaldavUrl(e.target.value)} className="mb-2" />
                <div className="flex gap-2 mb-2">
                  <Input placeholder="用户名" value={caldavUsername} onChange={(e) => setCaldavUsername(e.target.value)} />
                  <Input type="password" placeholder="密码（留空不修改）" value={caldavPassword} onChange={(e) => setCaldavPassword(e.target.value)} />
                </div>
                <Button size="sm" className="min-h-11" onClick={saveCalDav} disabled={integrationsSaving}>保存 CalDAV</Button>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-2 block">外部 ICS 同步策略</label>
                <select
                  value={syncStrategy}
                  onChange={(e) => setSyncStrategy(e.target.value as 'add_only' | 'replace')}
                  className="h-11 px-3 rounded-xl border text-sm w-full max-w-xs mb-3"
                  aria-label="外部日历同步策略"
                >
                  <option value="add_only">只增不删</option>
                  <option value="replace">替换同步</option>
                </select>
                <label className="text-xs font-semibold text-slate-500 mb-2 block">外部 ICS 订阅 URL（最多 5 个）</label>
                <div className="space-y-2">
                  {externalCalendarUrls.map((url, idx) => (
                    <div key={idx} className="flex gap-2">
                      <Input
                        placeholder="https://calendar.google.com/calendar/ical/..."
                        value={url}
                        onChange={(e) => {
                          const next = [...externalCalendarUrls];
                          next[idx] = e.target.value;
                          setExternalCalendarUrls(next);
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setExternalCalendarUrls(externalCalendarUrls.filter((_, i) => i !== idx))}
                      >
                        <Trash2 size={16} className="text-red-500" />
                      </Button>
                    </div>
                  ))}
                  {externalCalendarUrls.length < 5 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setExternalCalendarUrls([...externalCalendarUrls, ''])}
                    >
                      <Plus size={14} className="mr-1" /> 添加 URL
                    </Button>
                  )}
                </div>
                <div className="flex gap-2 mt-3">
                  <Button onClick={saveIntegrations} disabled={integrationsSaving} className="flex-1">
                    {integrationsSaving ? '保存中...' : '保存外部日历'}
                  </Button>
                  <Button variant="secondary" onClick={syncExternalCalendars} disabled={syncLoading}>
                    <RefreshCw size={14} className={`mr-1 ${syncLoading ? 'animate-spin' : ''}`} />
                    {syncLoading ? '同步中...' : '立即同步'}
                  </Button>
                </div>
                {syncResult && (
                  <p className="text-xs text-slate-500 mt-2" role="status">{syncResult}</p>
                )}
              </div>
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <Button variant="outline" size="sm" className="min-h-11" onClick={() => navigate('/integrations-docs')}>
                  查看 iOS 快捷指令 / ntfy / 自动化文档
                </Button>
              </div>
            </div>
          </section>

          {/* 时区设置 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">时区与免打扰</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10 space-y-1">
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
              <div className="p-4 rounded-[2rem] border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-11 h-11 rounded-2xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 flex items-center justify-center shadow-inner border border-indigo-100 dark:border-indigo-800/50">
                    <Bell size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">免打扰时段</h3>
                    <p className="text-xs text-slate-500">该时段内不发送提醒通知（基于上方时区）</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1 block">开始</label>
                    <Input
                      type="time"
                      value={quietHoursStart}
                      onChange={(e) => setQuietHoursStart(e.target.value)}
                      className="w-36"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1 block">结束</label>
                    <Input
                      type="time"
                      value={quietHoursEnd}
                      onChange={(e) => setQuietHoursEnd(e.target.value)}
                      className="w-36"
                    />
                  </div>
                  <Button onClick={saveQuietHours} disabled={quietHoursSaving} size="sm" className="min-h-11">
                    {quietHoursSaving ? '保存中...' : '保存免打扰'}
                  </Button>
                </div>
              </div>
              <div className="p-4 rounded-[2rem] border-t border-slate-100 dark:border-slate-800 space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-violet-50 dark:bg-violet-900/30 text-violet-600 flex items-center justify-center">
                    <GitBranch size={22} />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-bold">提醒规则与套餐</h3>
                    <p className="text-xs text-slate-500">按提前天数分级渠道、条件规则</p>
                  </div>
                  <Button variant="outline" size="sm" className="min-h-11" onClick={() => navigate('/notification-rules')}>
                    管理
                  </Button>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block">Markdown 邮件模板</label>
                  <textarea
                    value={markdownTemplate}
                    onChange={(e) => setMarkdownTemplate(e.target.value)}
                    placeholder={'**{{name}}** 提醒\n日期：{{date}}\n\n{{blessing}}'}
                    className="w-full min-h-[100px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-sm font-mono"
                    aria-label="Markdown 邮件模板"
                  />
                  <p className="text-xs text-slate-400 mt-1">变量：name, date, type, blessing, message</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block">API Key 权限范围</label>
                  <select
                    value={apiScopes}
                    onChange={(e) => setApiScopes(e.target.value)}
                    className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm w-full max-w-xs"
                    aria-label="API Key 权限"
                  >
                    <option value="read,write">读写 (read,write)</option>
                    <option value="read">只读 (read)</option>
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <Languages size={18} className="text-slate-500" />
                  <span className="text-sm">界面语言</span>
                  <Button variant={uiLang === 'zh' ? 'default' : 'outline'} size="sm" className="min-h-11" onClick={() => handleLangChange('zh')}>中文</Button>
                  <Button variant={uiLang === 'en' ? 'default' : 'outline'} size="sm" className="min-h-11" onClick={() => handleLangChange('en')}>English</Button>
                </div>
                <Button onClick={saveAdvancedNotification} disabled={advancedSaving} className="min-h-11">
                  {advancedSaving ? '保存中...' : '保存高级通知设置'}
                </Button>
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
                <div className="flex gap-2 mt-3 flex-wrap">
                  <Button variant="secondary" size="sm" className="min-h-11" disabled={backupLoading} onClick={handleExportData}>
                    导出
                  </Button>
                  <Input
                    type="password"
                    placeholder="加密导出密码"
                    value={encryptBackupPassword}
                    onChange={(e) => setEncryptBackupPassword(e.target.value)}
                    className="max-w-[160px] min-h-11"
                  />
                  <Button variant="secondary" size="sm" className="min-h-11" disabled={backupLoading} onClick={handleEncryptedExport}>
                    加密导出
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
            <div className="glass-panel rounded-[2.5rem] p-6 ring-1 ring-black/5 dark:ring-white/10 space-y-4">
              <p className="text-sm text-slate-500">接收登录失败、账户锁定等安全告警。可独立填写邮箱，也可绑定通知渠道账号。</p>
              <div>
                <label className="text-sm font-medium">告警邮箱（逗号分隔）</label>
                <Input
                  className="mt-1"
                  placeholder="admin@example.com, security@example.com"
                  value={alertEmails}
                  onChange={(e) => setAlertEmails(e.target.value)}
                />
                <p className="text-xs text-slate-400 mt-1">直接发送到以上邮箱，使用已配置的 Resend / SMTP 账号发信</p>
              </div>
              {alertAccounts.length === 0 ? (
                <p className="text-sm text-slate-400">绑定渠道：请先<button type="button" className="text-indigo-500 underline mx-1" onClick={() => navigate('/channels')}>配置通知渠道</button></p>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">绑定通知渠道账号</p>
                  {['resend', 'email', 'smtp', 'feishu', 'wecom', 'dingtalk', 'telegram', 'discord', 'slack'].map((type) => {
                    const typeAccounts = alertAccounts.filter((a: any) => a.is_active && a.type === type);
                    if (typeAccounts.length === 0) return null;
                    return (
                      <div key={type} className="rounded-xl border p-3 space-y-2">
                        <p className="text-xs font-semibold text-slate-500 uppercase">{type}</p>
                        {typeAccounts.map((account: any) => (
                          <label key={account.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedAlertAccountIds.includes(Number(account.id))}
                              onChange={() => toggleAlertAccount(Number(account.id))}
                              className="w-4 h-4 rounded border-slate-300"
                            />
                            <span className="text-sm font-medium">{account.name}</span>
                            {account.chat_id && (type === 'resend' || type === 'email' || type === 'smtp') && (
                              <span className="text-xs text-slate-400 truncate">→ {account.chat_id}</span>
                            )}
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              <button onClick={saveAlertChannels} disabled={alertSaving} className="px-4 py-2 bg-indigo-500 text-white rounded-xl text-sm hover:bg-indigo-600 disabled:opacity-50">
                {alertSaving ? '保存中...' : '保存告警设置'}
              </button>
            </div>
          </section>

          {/* 联系人与批量邮件 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">联系人与群发</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10 space-y-1">
              <div className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer" onClick={() => navigate('/contacts', { state: { backTo: '/settings' } })}>
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center"><User size={22} /></div>
                  <div>
                    <h3 className="text-base font-bold">固定联系人</h3>
                    <p className="text-xs text-slate-500">快捷用于提醒与批量邮件</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer" onClick={() => navigate('/broadcast', { state: { backTo: '/settings' } })}>
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