import { useState, useEffect } from 'react';
import { User, Shield, Bell, HardDrive, Smartphone, ChevronRight, ArrowLeft, LogOut, Camera, CalendarClock, Globe, Mail, Settings as SettingsIcon, Link2, Copy, RefreshCw, Plus, Trash2, GitBranch, Languages, Sparkles, Eye, EyeOff } from 'lucide-react';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { maskCredentialInUrl } from '@/lib/credentials';
import { getLang, setLang } from '@/i18n';
import { TIMEZONE_OPTIONS } from '@/lib/timezone-utils';
import { useTimezone } from '@/components/RealtimeClock';
import { ProfileSettings } from '@/components/ProfileSettings';
import { DigestSettings } from '@/components/digest/DigestSettings';
import { WebPushToggle } from '@/components/settings/WebPushToggle';
import { AISettings } from '@/components/settings/AISettings';
import { GreetingSettings } from '@/components/settings/GreetingSettings';
import { AgentTokensSettings } from '@/components/settings/AgentTokensSettings';
import { DataManagement } from '@/components/settings/DataManagement';
import { buildStyledReminderEmailBodies, buildNaturalReminderText, type EmailTemplateStyle } from '@timemark/shared';

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

/**
 * 24 节气（checkbox 78）。与后端 `holiday-reminder.service.ts` 的 JIEQI_NAMES
 * 保持一致的固定顺序；后端只接受这 24 个名字，非法值一律丢弃。
 */
const JIEQI_NAMES = [
  '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降',
  '立冬', '小雪', '大雪', '冬至', '小寒', '大寒',
] as const;

type HolidayReminderMode = 'keep' | 'shift' | 'suppress';

/** 公开 ICS 订阅源（checkbox 89）：令牌只存哈希，列表接口永不返回令牌。 */
interface IcsFeed {
  id: number;
  name: string;
  filter: { type: string; value: string | number } | null;
  createdAt: string | null;
  lastAccessAt: string | null;
  revokedAt: string | null;
}

/** 只读 URL + 复制；默认遮罩令牌，眼睛按钮临时明文。 */
function SecretUrlField({
  value,
  label,
  onCopy,
}: {
  value: string | null;
  label: string;
  onCopy: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={value ? (revealed ? value : maskCredentialInUrl(value)) : '加载中...'}
        className="font-mono text-xs"
        aria-label={label}
      />
      {value && (
        <>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setRevealed((prev) => !prev)}
            aria-label={revealed ? `隐藏${label}` : `显示${label}`}
            aria-pressed={revealed}
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
          <Button variant="outline" size="icon" onClick={() => onCopy(value)} aria-label={`复制${label}`}>
            <Copy size={16} />
          </Button>
        </>
      )}
    </div>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  
  // Modal states
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || '');
  const [, setUploadingAvatar] = useState(false);
  
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

  // Timezone setting (global store — synced with dashboard quick selector)
  const { timezone, setTimezone } = useTimezone();
  const [quietHoursStart, setQuietHoursStart] = useState('');
  const [quietHoursEnd, setQuietHoursEnd] = useState('');
  const [quietHoursSaving, setQuietHoursSaving] = useState(false);
  // checkbox 78: 节假日感知模式 + 节气提醒（默认关闭）
  const [holidayReminderMode, setHolidayReminderMode] = useState<HolidayReminderMode>('keep');
  const [jieqiReminderList, setJieqiReminderList] = useState<string[]>([]);
  const [holidaySaving, setHolidaySaving] = useState(false);
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
  const [icsFeeds, setIcsFeeds] = useState<IcsFeed[]>([]);
  const [newIcsFeedName, setNewIcsFeedName] = useState('');
  const [newIcsFeedType, setNewIcsFeedType] = useState<'category' | 'profile' | 'contact'>('category');
  const [newIcsFeedValue, setNewIcsFeedValue] = useState('');
  const [createdIcsFeed, setCreatedIcsFeed] = useState<{ id: number; url: string } | null>(null);
  const [icsFeedBusy, setIcsFeedBusy] = useState(false);
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
  const [emailTemplateStyle, setEmailTemplateStyle] = useState('classic');
  const [reminderCatchupMinutes, setReminderCatchupMinutes] = useState('');
  const [fallbackEnabled, setFallbackEnabled] = useState(true);
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
      api.get<{ timezone?: string; alert_channels?: unknown; alert_emails?: string[]; alert_account_ids?: number[]; default_test_email?: string; reminder_emails?: string[]; quiet_hours_start?: string | null; quiet_hours_end?: string | null; holiday_reminder_mode?: string; jieqi_reminder_list?: string[] }>('/config').catch(() => null),
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
      api.get<{ markdown_email_template?: string | null; api_scopes?: string; email_template_style?: string; reminder_catchup_minutes?: number | null; fallback_enabled?: boolean }>('/config/notification-advanced').catch(() => null),
      api.get<{ configured?: boolean; connected?: boolean; email?: string | null; calendarId?: string }>('/calendar/google-oauth/status').catch(() => null),
      api.get<{ feeds: IcsFeed[] }>('/calendar/ics-feeds').catch(() => null),
    ])
      .then(([config, accounts, logs, integrations, advanced, googleStatus, icsFeedData]) => {
        if (cancelled) return;
        if (config?.quiet_hours_start) setQuietHoursStart(config.quiet_hours_start);
        if (config?.quiet_hours_end) setQuietHoursEnd(config.quiet_hours_end);
        if (config?.holiday_reminder_mode === 'shift' || config?.holiday_reminder_mode === 'suppress' || config?.holiday_reminder_mode === 'keep') {
          setHolidayReminderMode(config.holiday_reminder_mode);
        }
        if (Array.isArray(config?.jieqi_reminder_list)) {
          setJieqiReminderList(config.jieqi_reminder_list.filter((x): x is string => typeof x === 'string'));
        }
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
        if (advanced?.email_template_style) setEmailTemplateStyle(advanced.email_template_style);
        setReminderCatchupMinutes(advanced?.reminder_catchup_minutes == null ? '' : String(advanced.reminder_catchup_minutes));
        setFallbackEnabled(advanced?.fallback_enabled !== false);
        if (icsFeedData) {
          setIcsFeeds(Array.isArray(icsFeedData.feeds) ? icsFeedData.feeds : []);
        }
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

  // 公开 ICS 订阅源（checkbox 89）：创建后明文令牌只在响应中出现一次。
  const createIcsFeed = async () => {
    const value = newIcsFeedValue.trim();
    if (!value) {
      alert('请填写筛选值（事件分类 / 档案 ID / 联系人姓名）');
      return;
    }
    const filter: { type: 'category' | 'profile' | 'contact'; value: string | number } =
      newIcsFeedType === 'profile'
        ? { type: 'profile', value: Number(value) }
        : { type: newIcsFeedType, value };
    if (filter.type === 'profile' && (!Number.isInteger(filter.value) || Number(filter.value) <= 0)) {
      alert('档案筛选值必须是正整数 ID');
      return;
    }

    setIcsFeedBusy(true);
    try {
      const result = await api.post<IcsFeed & { url: string }>('/calendar/ics-feeds', {
        name: newIcsFeedName.trim() || undefined,
        filter,
      });
      setIcsFeeds((prev) => [
        ...prev,
        {
          id: result.id,
          name: result.name,
          filter: result.filter,
          createdAt: result.createdAt,
          lastAccessAt: null,
          revokedAt: null,
        },
      ]);
      setCreatedIcsFeed({ id: result.id, url: result.url });
      setNewIcsFeedName('');
      setNewIcsFeedValue('');
    } catch (e) {
      alert(e instanceof Error ? e.message : '创建订阅源失败');
    } finally {
      setIcsFeedBusy(false);
    }
  };

  const revokeIcsFeed = async (id: number) => {
    if (!confirm('撤销后公开订阅 URL 立即失效且无法恢复，确定撤销？')) return;
    try {
      await api.delete(`/calendar/ics-feeds/${id}`);
      setIcsFeeds((prev) => prev.map((f) => (f.id === id ? { ...f, revokedAt: new Date().toISOString() } : f)));
      setCreatedIcsFeed((prev) => (prev && prev.id === id ? null : prev));
    } catch (e) {
      alert(e instanceof Error ? e.message : '撤销失败');
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
    try {
      await setTimezone(value);
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

  // checkbox 78: 节假日策略 + 节气提醒
  const toggleJieqi = (name: string) => {
    setJieqiReminderList((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const saveHolidayReminders = async () => {
    setHolidaySaving(true);
    try {
      await api.post('/config', {
        holiday_reminder_mode: holidayReminderMode,
        jieqi_reminder_list: jieqiReminderList,
      });
      alert('日历提醒设置已保存');
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    } finally {
      setHolidaySaving(false);
    }
  };

  const saveAdvancedNotification = async () => {
    setAdvancedSaving(true);
    try {
      await api.post('/config/notification-advanced', {
        markdown_email_template: markdownTemplate.trim() || null,
        api_scopes: apiScopes,
        email_template_style: emailTemplateStyle,
        reminder_catchup_minutes: reminderCatchupMinutes.trim() === '' ? null : Number(reminderCatchupMinutes),
        fallback_enabled: fallbackEnabled,
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
        <div className="glass-panel rounded-full px-6 py-3.5 flex items-center gap-4 ring-1 ring-black/5 dark:ring-white/10 shadow-xs">
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

          {/* 家庭档案（D5，checkbox 70）：CRUD + 每档案通知路由 */}
          <ProfileSettings />

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
                <Switch checked={soundEnabled} onCheckedChange={handleSoundToggle} aria-label="应用内提醒声音" />
              </div>
            </div>
          </section>

          {/* 浏览器 Web Push（checkbox 84）：独立组件，勿与其它设置区块合并（其它 lane 可能新增区块） */}
          <WebPushToggle />

          {/* AI 助手 / 本地模型（checkbox 107）：独立组件，选择供应商 + 测试连接 */}
          <AISettings />

          {/* v2.25: 生日祝福（自动/草稿 + AI 个性化 + 预演/草稿/历史） */}
          <GreetingSettings />

          {/* 智能体令牌（checkbox 101）：独立组件，创建 / 重命名 / 撤销受限令牌 */}
          <AgentTokensSettings />

          {/* 通知默认邮箱 */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
              <Mail className="w-4 h-4" /> 通知默认邮箱
            </h2>
            <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                事件未单独填写收件邮箱时，优先使用下方默认邮箱（高于通知渠道里填的联系人邮箱）。渠道账号上的收件人仅作最后兜底。
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
            <div className="glass-panel rounded-[2.5rem] p-4 ring-1 ring-black/5 dark:ring-white/10 max-h-64 overflow-y-auto overscroll-contain">
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
                <SecretUrlField
                  value={inboxReceiveUrl}
                  label="收件箱接收 URL"
                  onCopy={(v) => copyToClipboard(v, '收件箱接收 URL')}
                />
                <p className="text-xs text-slate-400 mt-1">POST JSON: {"{ title, body, sender? }"}；可配置 X-Timemark-Signature 签名</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">Webhook 入站 URL</label>
                <SecretUrlField
                  value={webhookUrl}
                  label="Webhook 入站 URL"
                  onCopy={(v) => copyToClipboard(v, 'Webhook URL')}
                />
                <p className="text-xs text-slate-400 mt-1">POST JSON: {"{ name, date, type? }"}</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">日历 Feed URL（ICS）</label>
                <SecretUrlField
                  value={calendarFeedUrl}
                  label="日历 Feed URL（ICS）"
                  onCopy={(v) => copyToClipboard(v, '日历 Feed URL')}
                />
                <p className="text-xs text-slate-400 mt-1">在 Google Calendar / Outlook 中添加「通过 URL 订阅」</p>
                {calendarFeedTokens.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs font-mono">
                    {calendarFeedTokens.map((t) => (
                      <li key={t.url} className="flex gap-2 items-center">
                        <span className="text-slate-500 shrink-0">{t.name}:</span>
                        <span className="truncate">{maskCredentialInUrl(t.url)}</span>
                        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => copyToClipboard(t.url, t.name)} aria-label="复制 Feed Token">
                          <Copy size={14} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <Button variant="outline" size="sm" className="mt-2 min-h-11" onClick={addFeedToken}>新建 Feed Token</Button>
              </div>

              {/* 公开订阅源（checkbox 89）：令牌只存哈希；正文不含证件号/备注/金额 */}
              <div data-testid="ics-feeds-section">
                <label className="text-xs font-semibold text-slate-500 mb-1 block">公开订阅源（按分类 / 档案 / 联系人）</label>
                <p className="text-xs text-slate-400 mb-2">
                  生成带令牌的公开 ICS 地址，可添加到 Google / Apple 日历。令牌仅存 SHA-256 哈希，正文只含标题与日期，不含证件号、备注或金额。
                </p>
                {icsFeeds.length > 0 && (
                  <ul className="mb-2 space-y-2">
                    {icsFeeds.map((feed) => (
                      <li key={feed.id} className="flex items-center gap-2 text-xs" data-testid={`ics-feed-row-${feed.id}`}>
                        <span className="flex-1 truncate text-slate-600 dark:text-slate-300">
                          {feed.name}（{feed.filter ? `${feed.filter.type}: ${String(feed.filter.value)}` : '无效筛选'}）
                          {feed.revokedAt && <span className="ml-1 text-red-500">已撤销</span>}
                        </span>
                        {createdIcsFeed && createdIcsFeed.id === feed.id && (
                          <>
                            <span className="font-mono truncate max-w-[160px]" data-testid="ics-feed-url">{createdIcsFeed.url}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="min-h-11 min-w-11"
                              onClick={() => copyToClipboard(createdIcsFeed.url, feed.name)}
                              aria-label="复制公开订阅 URL"
                            >
                              <Copy size={14} />
                            </Button>
                          </>
                        )}
                        {!feed.revokedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-11 text-red-500"
                            onClick={() => revokeIcsFeed(feed.id)}
                            aria-label={`撤销订阅源 ${feed.name}`}
                          >
                            撤销
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    placeholder="名称（可选）"
                    value={newIcsFeedName}
                    onChange={(e) => setNewIcsFeedName(e.target.value)}
                    className="sm:w-36"
                    aria-label="公开订阅源名称"
                  />
                  <select
                    value={newIcsFeedType}
                    onChange={(e) => setNewIcsFeedType(e.target.value as 'category' | 'profile' | 'contact')}
                    className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    aria-label="公开订阅源筛选类型"
                  >
                    <option value="category">分类</option>
                    <option value="profile">家庭档案（ID）</option>
                    <option value="contact">联系人</option>
                  </select>
                  <Input
                    placeholder={newIcsFeedType === 'profile' ? '档案 ID，如 1' : newIcsFeedType === 'contact' ? '联系人姓名' : '事件分类，如 birthday'}
                    value={newIcsFeedValue}
                    onChange={(e) => setNewIcsFeedValue(e.target.value)}
                    className="flex-1"
                    aria-label="公开订阅源筛选值"
                  />
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={createIcsFeed}
                    disabled={icsFeedBusy}
                    data-testid="ics-feed-create"
                  >
                    {icsFeedBusy ? '创建中...' : '创建订阅源'}
                  </Button>
                </div>
                {createdIcsFeed && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2">
                    请在离开页面前复制上面的 URL —— 明文令牌仅创建时显示一次。
                  </p>
                )}
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
                        aria-label="删除外部日历 URL"
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
                    <p className="text-xs text-slate-500">用于提醒、倒计时与免打扰；与首页时钟旁时区选择同步</p>
                  </div>
                </div>
                <select
                  value={timezone}
                  onChange={(e) => handleTimezoneChange(e.target.value)}
                  aria-label="系统时区"
                  className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
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
                      aria-label="免打扰开始时间"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 mb-1 block">结束</label>
                    <Input
                      type="time"
                      value={quietHoursEnd}
                      onChange={(e) => setQuietHoursEnd(e.target.value)}
                      className="w-36"
                      aria-label="免打扰结束时间"
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
                  <label className="text-xs font-semibold text-slate-500 mb-1 block">邮件模板风格</label>
                  <select
                    value={emailTemplateStyle}
                    onChange={(e) => setEmailTemplateStyle(e.target.value)}
                    className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm w-full max-w-xs"
                    aria-label="邮件模板风格"
                  >
                    <option value="classic">经典（纯文本风）</option>
                    <option value="card">卡片（推荐，深色适配）</option>
                    <option value="minimal">极简</option>
                  </select>
                  <p className="text-xs text-slate-400 mt-1">卡片/极简为现代排版：日期徽章 + 深色模式适配 + 少链接（更不容易进垃圾箱）</p>
                  <details className="mt-2 max-w-xs">
                    <summary className="text-xs text-primary-600 dark:text-primary-400 cursor-pointer select-none">预览该模板效果</summary>
                    <iframe
                      title="邮件模板预览"
                      sandbox=""
                      className="mt-2 w-full max-w-md h-72 rounded-xl border border-slate-200 dark:border-slate-700 bg-white"
                      srcDoc={buildStyledReminderEmailBodies(
                        { name: '示例事件（妈妈生日）', date: '2026-10-15', type: 'birthday' },
                        (emailTemplateStyle as EmailTemplateStyle) || 'classic',
                      ).html}
                    />
                    <pre className="mt-2 w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-3 text-xs whitespace-pre-wrap text-slate-600 dark:text-slate-300">{buildNaturalReminderText({ name: '示例事件（妈妈生日）', date: '2026-10-15', type: 'birthday' })}</pre>
                    <p className="text-xs text-slate-400 mt-1">上方为邮件渲染效果，下方为 IM / 推送类渠道收到的纯文本内容（Dry-run，不真实发送）</p>
                  </details>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block">提醒补发窗口（分钟）</label>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    value={reminderCatchupMinutes}
                    onChange={(e) => setReminderCatchupMinutes(e.target.value)}
                    placeholder="留空 = 部署默认（10 分钟）"
                    className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm w-full max-w-xs"
                    aria-label="提醒补发窗口分钟数"
                  />
                  <p className="text-xs text-slate-400 mt-1">cron 停摆后，今天内迟到的提醒最多补发多久：0=关闭，1440=当天漏掉的全部补发</p>
                </div>
                <div className="flex items-center justify-between max-w-xs">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 block">渠道自动回退</label>
                    <p className="text-xs text-slate-400 mt-1">指定渠道发送失败时，自动改用其他已绑定渠道发送</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={fallbackEnabled}
                    onClick={() => setFallbackEnabled((v) => !v)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${fallbackEnabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                    aria-label="渠道自动回退开关"
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${fallbackEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
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

          {/* 日历增强提醒（checkbox 78） */}
          <section>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">日历增强提醒</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10 space-y-1">
              <div className="p-4 rounded-[2rem]">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-11 h-11 rounded-2xl bg-amber-50 dark:bg-amber-900/30 text-amber-600 flex items-center justify-center shadow-inner border border-amber-100 dark:border-amber-800/50">
                    <Sparkles size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">法定节假日提醒策略</h3>
                    <p className="text-xs text-slate-500">非关键提醒命中法定节假日时：默认保留原时间并在内容中标注节日名，也可顺延到节后工作日或不提醒。用药与证件到期提醒不受影响。</p>
                  </div>
                </div>
                <select
                  value={holidayReminderMode}
                  onChange={(e) => setHolidayReminderMode(e.target.value as HolidayReminderMode)}
                  aria-label="法定节假日提醒策略"
                  className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm w-full max-w-md text-slate-900 dark:text-white"
                >
                  <option value="keep">保留原时间（内容中标注节日名）</option>
                  <option value="shift">顺延到节后第一个工作日</option>
                  <option value="suppress">法定节假日当天不提醒</option>
                </select>
              </div>
              <div className="p-4 rounded-[2rem] border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between mb-3 gap-3">
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">节气提醒（默认关闭）</h3>
                    <p className="text-xs text-slate-500">勾选想被告知的节气；当天将以现有提醒渠道发送一条通知</p>
                  </div>
                  <Button variant="outline" size="sm" className="min-h-11" onClick={() => setJieqiReminderList([])}>清空</Button>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {JIEQI_NAMES.map((name) => {
                    const active = jieqiReminderList.includes(name);
                    return (
                      <label
                        key={name}
                        className={`flex items-center justify-center h-9 rounded-xl border text-sm cursor-pointer transition-colors ${active ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={active}
                          onChange={() => toggleJieqi(name)}
                          aria-label={`节气提醒 ${name}`}
                        />
                        {name}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="p-4 rounded-[2rem] border-t border-slate-100 dark:border-slate-800">
                <Button onClick={saveHolidayReminders} disabled={holidaySaving} className="min-h-11">
                  {holidaySaving ? '保存中...' : '保存日历提醒设置'}
                </Button>
              </div>
            </div>
          </section>

          {/* 周期摘要（checkbox 80） */}
          <DigestSettings />

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
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <DataManagement />
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