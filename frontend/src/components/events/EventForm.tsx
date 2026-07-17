import { useState, useEffect, useRef, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CalendarClock, Type, AlignLeft, Globe, Bell, Users, Plus, X, Heart, GraduationCap, PartyPopper, Calendar, Sparkles, ChevronDown, Clock, Eye, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lunar, Solar } from 'lunar-javascript';
import { useNavigate } from 'react-router-dom';
import {
  applyContactAsPerson,
  applyContactsAsReminders,
  mergeContactIntoReminderConfig,
  type FixedContactForEvent,
} from '@/lib/contact-event-bridge';
import { normalizeEmail } from '@timemark/shared';
import { api, fetchAvailableChannels, type AvailableChannel } from '@/lib/api';
import { PRESET_TEMPLATES, renderTemplate, EVENT_TYPE_TEMPLATES } from '@timemark/shared/templates';
import { getBlessing } from '@timemark/shared/blessings';
import type { Event, CreateEventRequest, EventType, CalendarType, ReminderConfig, LunarDate } from '@timemark/shared';

interface NotificationAccountResponse {
  id: number;
  user_id: number;
  type: string;
  name: string;
  webhook: string | null;
  token: string | null;
  secret: string | null;
  chat_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface EventFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateEventRequest) => Promise<void>;
  event?: Event;
}

const eventTypes: { value: EventType; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'birthday', label: '生日', icon: <Heart size={18} />, color: 'bg-pink-500' },
  { value: 'exam', label: '考试', icon: <GraduationCap size={18} />, color: 'bg-blue-500' },
  { value: 'anniversary', label: '纪念日', icon: <Heart size={18} />, color: 'bg-rose-500' },
  { value: 'holiday', label: '节日', icon: <PartyPopper size={18} />, color: 'bg-yellow-500' },
  { value: 'meeting', label: '会议', icon: <CalendarClock size={18} />, color: 'bg-cyan-500' },
  { value: 'deadline', label: '截止日期', icon: <Clock size={18} />, color: 'bg-orange-500' },
  { value: 'travel', label: '旅行', icon: <Sparkles size={18} />, color: 'bg-teal-500' },
  { value: 'graduation', label: '毕业', icon: <GraduationCap size={18} />, color: 'bg-indigo-500' },
  { value: 'wedding', label: '婚礼', icon: <Heart size={18} />, color: 'bg-red-500' },
  { value: 'medical', label: '医疗', icon: <Sparkles size={18} />, color: 'bg-green-500' },
  { value: 'other', label: '其他', icon: <Sparkles size={18} />, color: 'bg-purple-500' },
];

// 自定义模板类型（从 API 加载）
interface CustomTemplate {
  id: string;
  event_type: string;
  template_content: string;
}

const calendarTypes: { value: CalendarType; label: string }[] = [
  { value: 'gregorian', label: '公历' },
  { value: 'lunar', label: '农历' },
  { value: 'both', label: '双历' },
];

const reminderDays = [1, 3, 7, 14, 30];

const reminderTimes = [
  '06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00'
];

// 使用 lunar-javascript 转换农历/公历
const convertToLunar = (gregorianDate: string): { year: number; month: number; day: number; isLeap: boolean } | null => {
  try {
    // Append T00:00:00 to force local timezone instead of UTC
    const date = new Date(gregorianDate + 'T00:00:00');
    if (isNaN(date.getTime())) return null;
    
    const solar = Solar.fromDate(date);
    const lunar = solar.getLunar();
    
    const month = lunar.getMonth();
    const isLeap = month < 0; // 闰月为负数
    
    return {
      year: lunar.getYear(),
      month: Math.abs(month),
      day: lunar.getDay(),
      isLeap
    };
  } catch {
    return null;
  }
};

const convertToGregorian = (lunarDate: { year: number; month: number; day: number; isLeap: boolean }): string | null => {
  try {
    const { year, month, day, isLeap } = lunarDate;
    // 闰月用负数表示
    const lunar = Lunar.fromYmd(year, isLeap ? -month : month, day);
    const solar = lunar.getSolar();
    
    return `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`;
  } catch {
    return null;
  }
};

const notificationChannels = [
  // Email channels
  { value: 'email', label: '邮件', icon: '📧' },
  { value: 'resend', label: 'Resend邮件', icon: '📧' },
  { value: 'smtp', label: 'SMTP邮件', icon: '📧' },
  // Webhook channels
  { value: 'feishu', label: '飞书', icon: '📱' },
  { value: 'dingtalk', label: '钉钉', icon: '🔔' },
  { value: 'wecom', label: '企业微信', icon: '💬' },
  { value: 'discord', label: 'Discord', icon: '🎮' },
  { value: 'slack', label: 'Slack', icon: '💼' },
  { value: 'googlechat', label: 'Google Chat', icon: '🔵' },
  { value: 'irc', label: 'IRC', icon: '💻' },
  { value: 'synologychat', label: '群晖 Chat', icon: '🖥️' },
  { value: 'twitch', label: 'Twitch', icon: '📺' },
  // Token-based channels
  { value: 'telegram', label: 'Telegram', icon: '✈️' },
  { value: 'line', label: 'LINE', icon: '🟢' },
  { value: 'matrix', label: 'Matrix', icon: '⚡' },
  { value: 'mattermost', label: 'Mattermost', icon: '🧱' },
  { value: 'msteams', label: 'MS Teams', icon: '📊' },
  { value: 'nextcloud_talk', label: 'Nextcloud Talk', icon: '☁️' },
  { value: 'wxpusher', label: 'WxPusher', icon: '💚' },
  { value: 'qmsg', label: 'Qmsg', icon: '🐧' },
  { value: 'serverchan', label: 'Server酱', icon: '📡' },
  { value: 'pushplus', label: 'PushPlus', icon: '➕' },
  { value: 'bark', label: 'Bark', icon: '🐕' },
  { value: 'gotify', label: 'Gotify', icon: '📨' },
  { value: 'meow', label: '喵推送', icon: '🐱' },
  { value: 'pushme', label: 'PushMe', icon: '📲' },
  { value: 'wecomapp', label: '企微应用', icon: '🏢' },
  { value: 'ntfy', label: 'ntfy', icon: '📢' },
  { value: 'pushover', label: 'Pushover', icon: '🔔' },
  { value: 'apprise', label: 'Apprise', icon: '🔗' },
];

const defaultReminderConfig: ReminderConfig = {
  enabled: true,
  daysBeforeList: [1, 3],
  emailRecipients: [],
  reminderTimes: ['09:00'],
  channels: [],
};

export function EventForm({ open, onClose, onSubmit, event }: EventFormProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [availableChannels, setAvailableChannels] = useState<AvailableChannel[]>([]);
  const [formData, setFormData] = useState<CreateEventRequest>({
    name: '',
    type: 'birthday',
    date: '',
    calendarType: 'gregorian',
    lunarDate: undefined,
    reminderConfig: defaultReminderConfig,
  });

  const reminderTimeline = useMemo(() => {
    if (!formData.date) return [];
    const days = formData.reminderConfig?.daysBeforeList?.length
      ? formData.reminderConfig.daysBeforeList
      : [1, 3];
    const allDays = days.includes(0) ? days : [0, ...days];
    const times = formData.reminderConfig?.reminderTimes?.length
      ? formData.reminderConfig.reminderTimes
      : ['09:00'];
    const todayStr = new Date().toISOString().slice(0, 10);
    const entries: { date: string; daysBefore: number; time: string }[] = [];

    for (const d of [...new Set(allDays)].sort((a, b) => b - a)) {
      const remind = new Date(formData.date + 'T00:00:00');
      remind.setDate(remind.getDate() - d);
      const dateStr = `${remind.getFullYear()}-${String(remind.getMonth() + 1).padStart(2, '0')}-${String(remind.getDate()).padStart(2, '0')}`;
      if (dateStr >= todayStr) {
        for (const time of times) {
          entries.push({ date: dateStr, daysBefore: d, time });
        }
      }
    }
    return entries.slice(0, 16);
  }, [formData.date, formData.reminderConfig]);

  const [lunarInputValue, setLunarInputValue] = useState('');

  const [customTime, setCustomTime] = useState('');
  const [customEmail, setCustomEmail] = useState('');
  const [accounts, setAccounts] = useState<NotificationAccountResponse[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>([]);

  // 账号选择弹窗状态
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [accountPickerChannel, setAccountPickerChannel] = useState<string | null>(null);
  const [pickerAccounts, setPickerAccounts] = useState<NotificationAccountResponse[]>([]);
  const [pickerSelectedIds, setPickerSelectedIds] = useState<string[]>([]);

  // 通知预览状态
  const [previewOpen, setPreviewOpen] = useState(false);
  const [fixedContacts, setFixedContacts] = useState<FixedContactForEvent[]>([]);
  const [selectedReminderContactIds, setSelectedReminderContactIds] = useState<number[]>([]);

  const toggleReminderContactSelect = (id: number) => {
    setSelectedReminderContactIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const applySelectedReminderContacts = () => {
    const selected = fixedContacts.filter((c) => selectedReminderContactIds.includes(c.id));
    if (selected.length === 0) return;
    setFormData((prev) => {
      const applied = applyContactsAsReminders(
        selected,
        accounts,
        prev.reminderConfig || defaultReminderConfig,
        prev,
      );
      return {
        ...prev,
        reminderRecipientName: applied.reminderRecipientName,
        reminderRecipientEmail: applied.reminderRecipientEmail,
        reminderConfig: applied.reminderConfig,
      };
    });
  };

  const addEmailRecipient = (raw: string) => {
    const email = normalizeEmail(raw);
    if (!email) return;
    setFormData((prev) => {
      const current = prev.reminderConfig?.emailRecipients || [];
      if (current.includes(email)) return prev;
      return {
        ...prev,
        reminderConfig: {
          ...prev.reminderConfig!,
          emailRecipients: [...current, email],
        },
      };
    });
  };

  useEffect(() => {
    if (!open || !formData.type || event) return;
    api.get<{ daysBefore: number[]; source: string }>(`/features/smart-days/${formData.type}`)
      .then((res) => {
        if (res?.daysBefore?.length) {
          setFormData((prev) => ({
            ...prev,
            reminderConfig: {
              ...prev.reminderConfig!,
              daysBeforeList: res.daysBefore,
            },
          }));
        }
      })
      .catch(() => {});
  }, [open, formData.type]);

  useEffect(() => {
    if (!open) return;
    api.get<FixedContactForEvent[]>('/contacts')
      .then((data) => setFixedContacts(Array.isArray(data) ? data : []))
      .catch(() => setFixedContacts([]));
  }, [open]);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('birthday');
  const [userTemplates, setUserTemplates] = useState<Array<{id: string; name: string; content: string}>>([]);

  useEffect(() => {
    if (!open) return;
    const templates = EVENT_TYPE_TEMPLATES[formData.type] || EVENT_TYPE_TEMPLATES.other;
    const recipient = formData.reminderRecipientName?.trim();
    if (!recipient) {
      setSelectedTemplateId(templates[0] || 'generic');
      return;
    }
    api.get<Array<{ from_relation: string; to_relation: string; recipient_type?: string }>>('/config/relationships')
      .then((mappings) => {
        const list = Array.isArray(mappings) ? mappings : [];
        const hit = list.find((m) =>
          m.from_relation === recipient
          || m.to_relation === recipient
          || m.recipient_type === recipient,
        );
        if (hit?.recipient_type === 'family' && formData.type === 'holiday') {
          setSelectedTemplateId('holiday_family');
        } else if (hit?.recipient_type === 'family' && formData.type === 'birthday') {
          setSelectedTemplateId('birthday_detailed');
        } else if (hit?.recipient_type === 'colleague' && formData.type === 'meeting') {
          setSelectedTemplateId('meeting');
        } else {
          setSelectedTemplateId(templates[0] || 'generic');
        }
      })
      .catch(() => setSelectedTemplateId(templates[0] || 'generic'));
  }, [open, formData.type, formData.reminderRecipientName]);

  // 加载自定义模板
  useEffect(() => {
    if (open) {
      api.get<CustomTemplate[]>('/config/templates')
        .then(data => {
          if (data) {
            setCustomTemplates(data);
            // 同时更新通知模板列表
            const templates = data.map(t => ({
              id: t.event_type,
              name: t.event_type,
              content: t.template_content
            }));
            setUserTemplates(templates);
          }
        })
        .catch(err => console.error('Failed to load templates:', err));
    }
  }, [open]);

  // 合并预设模板和用户模板
  const allTemplates = [
    ...PRESET_TEMPLATES.map(t => ({ id: t.id, name: t.name, content: t.content })),
    ...userTemplates
  ];

  // 根据当前事件类型过滤模板
  const getTemplatesForEventType = (eventType: string) => {
    const templateIds = EVENT_TYPE_TEMPLATES[eventType] || EVENT_TYPE_TEMPLATES.other;
    return allTemplates.filter(t => templateIds.includes(t.id));
  };

  // 当前事件类型的模板列表
  const currentEventTypeTemplates = getTemplatesForEventType(formData.type);

  // 生成预览内容
  const generatePreview = () => {
    const template = allTemplates.find(t => t.id === selectedTemplateId);
    if (!template) return '请选择模板';
    
    const blessing = getBlessing(formData.type, undefined, formData.personName, formData.reminderRecipientName);
    const data: Record<string, string> = {
      event_name: formData.name || '示例事件',
      event_date: formData.date || '2026-05-04',
      event_type: formData.type === 'birthday' ? '生日' : 
                  formData.type === 'anniversary' ? '纪念日' :
                  formData.type === 'exam' ? '考试' :
                  formData.type === 'holiday' ? '节日' : '其他',
      person_name: formData.personName || '某人',
      days_until: '3',
      blessing: blessing,
      reminder_time: formData.reminderConfig?.reminderTimes?.[0] || '09:00',
    };
    
    return renderTemplate(template.content, data);
  };

  useEffect(() => {
    if (event && open) {
      // Safe date parsing - handle both YYYY-MM-DD and YYYY-MM-DDTHH:mm formats
      let safeDate = '';
      if (event.date) {
        // Extract YYYY-MM-DD directly (handle both YYYY-MM-DD and YYYY-MM-DDTHH:mm formats)
        const dateStr = event.date.split('T')[0]; // Extract YYYY-MM-DD
        
        // Validate it's a valid date format before setting
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          safeDate = dateStr;
        }
      }
      
      setFormData({
        name: event.name || '',
        type: event.type || 'other',
        date: safeDate,
        calendarType: event.calendarType || 'gregorian',
        lunarDate: event.lunarDate,
        reminderConfig: event.reminderConfig || defaultReminderConfig,
        personName: event.personName,
        birthDate: event.birthDate,
        birthDateLunar: event.birthDateLunar,
        reminderRecipientName: event.reminderRecipientName,
        reminderRecipientEmail: event.reminderRecipientEmail,
      });
      
      // Set lunar input value for "both" calendar type
      if (event.calendarType === 'both' && event.lunarDate) {
        const lunar = event.lunarDate as any;
        setLunarInputValue(`${lunar.year}-${String(lunar.month).padStart(2, '0')}-${String(lunar.day).padStart(2, '0')}`);
      } else {
        setLunarInputValue('');
      }
    } else if (open) {
      setFormData({
        name: '',
        type: 'birthday',
        date: '',
        calendarType: 'gregorian',
        lunarDate: undefined,
        reminderConfig: defaultReminderConfig,
      });
      setLunarInputValue('');
    }
  }, [event, open]);

  // 加载所有活跃通知账户（用于显示已选账号摘要）
  useEffect(() => {
    if (open) {
      api.get<NotificationAccountResponse[]>('/config/accounts')
        .then(data => setAccounts(data.filter(a => a.is_active)))
        .catch(err => console.error('Failed to load accounts:', err));
      
      // 加载可用渠道状态
      fetchAvailableChannels()
        .then(data => setAvailableChannels(data))
        .catch(err => console.error('Failed to load available channels:', err));
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate required fields
    if (!formData.name.trim()) {
      alert('请输入事件名称');
      return;
    }
    
    if (!formData.date) {
      alert('请选择日期');
      return;
    }
    
    // Validate date - handle both YYYY-MM-DD and YYYY-MM-DDTHH:mm formats
    let dateToValidate = formData.date;
    if (formData.date.includes('T')) {
      dateToValidate = formData.date.split('T')[0];
    }
    // Append T00:00:00 to force local timezone instead of UTC
    const targetDate = new Date(dateToValidate + 'T00:00:00');
    if (isNaN(targetDate.getTime())) {
      alert('无效的日期格式');
      return;
    }

    setLoading(true);
    try {
      // Convert date to YYYY-MM-DD string for PostgreSQL (use local time, not UTC)
      // Handle both YYYY-MM-DD and YYYY-MM-DDTHH:mm formats
      let dateStr = formData.date;
      if (formData.date.includes('T')) {
        const datePart = formData.date.split('T')[0];
        dateStr = datePart;
      }
      
      // If it's already in YYYY-MM-DD format, use it directly
      // If it's in YYYY-MM-DDTHH:mm format, extract YYYY-MM-DD
      const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!dateMatch) {
        // Try to parse as date (append T00:00:00 to force local timezone)
        const targetDate = new Date(formData.date + 'T00:00:00');
        if (isNaN(targetDate.getTime())) {
          alert('无效的日期格式');
          return;
        }
        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getDate()).padStart(2, '0');
        dateStr = `${year}-${month}-${day}`;
      }
      
      const emailRecipients = [
        ...new Set(
          (formData.reminderConfig?.emailRecipients || [])
            .map((e) => normalizeEmail(e))
            .filter((e): e is string => !!e),
        ),
      ];

      const submissionData: CreateEventRequest = {
        ...formData,
        date: dateStr,
        reminderConfig: {
          ...formData.reminderConfig!,
          emailRecipients,
        },
        reminderRecipientEmail: emailRecipients[0] || null,
      };
      
      await onSubmit(submissionData);
      onClose();
    } catch (error: any) {
      console.error('Submit error:', error);
      alert(error.message || '保存失败，请检查输入格式');
    } finally {
      setLoading(false);
    }
  };

  const toggleReminderDay = (day: number) => {
    const currentDays = formData.reminderConfig.daysBeforeList || [];
    const newDays = currentDays.includes(day)
      ? currentDays.filter(d => d !== day)
      : [...currentDays, day].sort((a, b) => a - b);
    
    setFormData({
      ...formData,
      reminderConfig: {
        ...formData.reminderConfig,
        daysBeforeList: newDays,
      },
    });
  };

  const toggleChannel = async (channel: string) => {
    const currentChannels = formData.reminderConfig.channels || [];
    const currentAccountIds = formData.reminderConfig.accountIds || [];
    const isSelected = currentChannels.includes(channel);

    if (isSelected) {
      // 取消选择该渠道，并移除相关 accountIds
      const accountType = channelToAccountType[channel];
      const newAccountIds = accountType
        ? currentAccountIds.filter(id => !accounts.some(a => String(a.id) === id && a.type === accountType))
        : currentAccountIds;
      setFormData({
        ...formData,
        reminderConfig: {
          ...formData.reminderConfig,
          channels: currentChannels.filter(c => c !== channel),
          accountIds: newAccountIds,
        },
      });
    } else {
      setFormData({
        ...formData,
        reminderConfig: {
          ...formData.reminderConfig,
          channels: [...currentChannels, channel],
        },
      });
      await openAccountPicker(channel, currentAccountIds);
    }
  };

  const handleTypeChange = (type: EventType) => {
    setFormData({ ...formData, type });
  };

  const handleCalendarTypeChange = (calendarType: CalendarType) => {
    setFormData({ ...formData, calendarType });
  };

  const channelToAccountType: Record<string, string> = {
    email: 'email',
    resend: 'resend',
    smtp: 'smtp',
    feishu: 'feishu',
    wecom: 'wecom',
    dingtalk: 'dingtalk',
    telegram: 'telegram',
    discord: 'discord',
    slack: 'slack',
    googlechat: 'googlechat',
    irc: 'irc',
    synologychat: 'synologychat',
    twitch: 'twitch',
    line: 'line',
    matrix: 'matrix',
    mattermost: 'mattermost',
    msteams: 'msteams',
    nextcloud_talk: 'nextcloudtalk',
    qmsg: 'qmsg',
    wxpusher: 'wxpusher',
    serverchan: 'serverchan',
    pushplus: 'pushplus',
    bark: 'bark',
    gotify: 'gotify',
    meow: 'meow',
    pushme: 'pushme',
    wecomapp: 'wecomapp',
    ntfy: 'ntfy',
    pushover: 'pushover',
    apprise: 'apprise',
  };

  const openAccountPicker = async (channel: string, currentAccountIds: string[]) => {
    const accountType = channelToAccountType[channel];
    if (!accountType) return;

    setAccountsLoading(true);
    try {
      const data = await api.get<NotificationAccountResponse[]>('/config/accounts');
      const filtered = data.filter(a => a.type === accountType && a.is_active);
      setPickerAccounts(filtered);
      setPickerSelectedIds(currentAccountIds.filter(id => filtered.some(a => String(a.id) === id)));
      setAccountPickerChannel(channel);
      setAccountPickerOpen(true);
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setAccountsLoading(false);
    }
  };

  const togglePickerAccount = (id: string) => {
    setPickerSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const confirmPicker = () => {
    setFormData(prev => {
      const otherIds = (prev.reminderConfig.accountIds || []).filter(id =>
        !pickerAccounts.some(a => String(a.id) === id)
      );
      return {
        ...prev,
        reminderConfig: {
          ...prev.reminderConfig,
          accountIds: [...otherIds, ...pickerSelectedIds],
        },
      };
    });
    setAccountPickerOpen(false);
    setAccountPickerChannel(null);
  };

  const cancelPicker = () => {
    const channel = accountPickerChannel;
    if (channel) {
      setFormData(prev => ({
        ...prev,
        reminderConfig: {
          ...prev.reminderConfig,
          channels: (prev.reminderConfig.channels || []).filter(c => c !== channel),
        },
      }));
    }
    setAccountPickerOpen(false);
    setAccountPickerChannel(null);
  };

  // 添加自定义提醒时间
  const addCustomTime = () => {
    if (!customTime) return;
    const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timePattern.test(customTime)) {
      alert('请输入正确的时间格式，如 09:00');
      return;
    }
    const currentTimes = formData.reminderConfig.reminderTimes || [];
    if (currentTimes.includes(customTime)) {
      alert('该时间已存在');
      return;
    }
    setFormData({
      ...formData,
      reminderConfig: { ...formData.reminderConfig, reminderTimes: [...currentTimes, customTime].sort() }
    });
    setCustomTime('');
  };

  // 移除提醒时间
  const removeReminderTime = (time: string) => {
    setFormData({
      ...formData,
      reminderConfig: {
        ...formData.reminderConfig,
        reminderTimes: (formData.reminderConfig.reminderTimes || []).filter(t => t !== time)
      }
    });
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.08 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 15 },
    visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto glass-panel rounded-[2.5rem]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-2xl font-bold text-slate-900 dark:text-white">
            <div className="p-2.5 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400 border border-primary-100 dark:border-primary-800/50">
              <CalendarClock size={24} />
            </div>
            {event ? '编辑事件' : '创建新事件'}
          </DialogTitle>
        </DialogHeader>
        
        <motion.form onSubmit={handleSubmit} className="space-y-6 mt-4" variants={containerVariants} initial="hidden" animate="visible">
          {/* 事件类型选择 */}
          <motion.div variants={itemVariants} className="space-y-3">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
              <Type size={16} className="text-primary-500" />
              事件类型
            </label>
            <div className="grid grid-cols-5 gap-2">
              {eventTypes.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => handleTypeChange(type.value)}
                  className={`flex flex-col items-center gap-2 p-3 rounded-2xl transition-all duration-300 alive-interactive ${
                    formData.type === type.value
                      ? `${type.color} text-white shadow-lg`
                      : 'bg-slate-100/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  <div className={formData.type === type.value ? 'text-white' : type.color.replace('bg-', 'text-')}>
                    {type.icon}
                  </div>
                  <span className="text-xs font-semibold">{type.label}</span>
                </button>
              ))}
            </div>
            
            {/* 自定义模板二级选择（当选择"其他"时显示） */}
            {formData.type === 'other' && customTemplates.length > 0 && (
              <div className="mt-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2 block">
                  自定义模板
                </label>
                <div className="flex flex-wrap gap-2">
                  {customTemplates.map((template) => (
                    <button
                      key={template.event_type}
                      type="button"
                      onClick={() => {
                        setFormData({
                          ...formData,
                          name: template.event_type,
                        });
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        formData.name === template.event_type
                          ? 'bg-purple-500 text-white'
                          : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600'
                      }`}
                    >
                      {template.event_type}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>

          {/* 事件名称 */}
          <motion.div variants={itemVariants} className="space-y-2.5">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
              <Calendar size={16} className="text-primary-500" />
              事件名称
            </label>
            <Input
              required
              placeholder="例如：妈妈生日 / 结婚纪念日"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="h-12"
              aria-label="事件名称"
            />
          </motion.div>

          {/* 日历类型和日期选择 */}
          <motion.div variants={itemVariants} className="space-y-3">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
              <Globe size={16} className="text-primary-500" />
              日历类型
              <span className="text-xs font-normal text-slate-400 ml-2">
                {formData.calendarType === 'gregorian' && '→ 公历日期'}
                {formData.calendarType === 'lunar' && '→ 农历日期'}
                {formData.calendarType === 'both' && '→ 公历+农历'}
              </span>
            </label>
            <div className="flex gap-2">
              {calendarTypes.map((cal) => (
                <button
                  key={cal.value}
                  type="button"
                  onClick={() => handleCalendarTypeChange(cal.value)}
                  className={`flex-1 py-2.5 px-4 rounded-xl font-semibold text-sm transition-all duration-300 alive-interactive ${
                    formData.calendarType === cal.value
                      ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/30'
                      : 'bg-slate-100/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {cal.label}
                  {formData.calendarType === cal.value && (
                    <span className="ml-1 text-xs opacity-80">✓</span>
                  )}
                </button>
              ))}
            </div>
          </motion.div>

          <motion.div variants={itemVariants} className="space-y-2.5">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
              <CalendarClock size={16} className="text-primary-500" />
              {formData.calendarType === 'gregorian' && '公历日期'}
              {formData.calendarType === 'lunar' && '农历日期'}
              {formData.calendarType === 'both' && '公历日期'}
              {formData.calendarType === 'both' && <span className="text-xs text-slate-400 ml-2">(农历将在下方自动计算)</span>}
            </label>
            <Input
              required
              type="date"
              value={formData.date}
              aria-label="事件日期"
              onChange={(e) => {
                const newDate = e.target.value;
                setFormData({ ...formData, date: newDate });
                // Auto-convert to lunar if needed
                if (formData.calendarType === 'both') {
                  const lunar = convertToLunar(newDate);
                  if (lunar) {
                    setFormData(prev => ({ ...prev, lunarDate: lunar }));
                    // 更新农历输入框显示
                    const lunarStr = `${lunar.year}-${String(lunar.month).padStart(2, '0')}-${String(lunar.day).padStart(2, '0')}`;
                    setLunarInputValue(lunarStr);
                  }
                }
              }}
              className="h-12"
            />
          </motion.div>

          {/* Second date for "both" calendar type */}
          {formData.calendarType === 'both' && (
            <motion.div variants={itemVariants} className="space-y-2.5">
              <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <CalendarClock size={16} className="text-primary-500" />
                农历日期
                <span className="text-xs text-slate-400 ml-2">(公历将在上方自动计算)</span>
              </label>
              <Input
                type="text"
                value={lunarInputValue}
                placeholder="农历日期，格式：YYYY-MM-DD 例如 2007-06-15"
                onChange={(e) => {
                  const input = e.target.value;
                  setLunarInputValue(input);
                  // 尝试解析为农历日期并转换为公历
                  const lunarMatch = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
                  if (lunarMatch) {
                    const [, year, month, day] = lunarMatch;
                    const lunarDate = {
                      year: parseInt(year),
                      month: parseInt(month),
                      day: parseInt(day),
                      isLeap: false
                    };
                    const gregorian = convertToGregorian(lunarDate);
                    if (gregorian) {
                      setFormData(prev => ({ ...prev, date: gregorian }));
                    }
                  }
                }}
                className="h-12"
              />
              <span className="text-xs text-slate-400">
                提示：输入农历日期（如 2007-06-15 表示农历2007年6月15日），系统会自动转换为公历
              </span>
            </motion.div>
          )}

          {/* 关联人员 - 拆分为被提醒人和提醒人 */}
          <motion.div variants={itemVariants} className="space-y-3">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
              <Users size={16} className="text-primary-500" />
              关联人员（可选）
            </label>
            
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 space-y-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                💡 设置关联人员后，系统会根据接收人自动转换称呼（如"我爸"→"父亲"）
              </p>

              {fixedContacts.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <span className="text-[10px] text-slate-400 w-full flex items-center justify-between">
                    <span>从固定联系人快捷填入（自动适配渠道与邮箱）：</span>
                    <button type="button" className="text-indigo-500 hover:underline" onClick={() => { onClose(); navigate('/contacts', { state: { backTo: '/dashboard' } }); }}>管理联系人</button>
                  </span>
                  {fixedContacts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="text-xs px-2 py-1 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:border-primary-400"
                      onClick={() => setFormData((prev) => ({
                        ...prev,
                        ...applyContactAsPerson(c, prev),
                      }))}
                      title="填入被提醒人"
                    >
                      {c.name}
                    </button>
                  ))}
                  {fixedContacts.map((c) => (
                    <button
                      key={`r-${c.id}`}
                      type="button"
                      className={`text-xs px-2 py-1 rounded-lg border ${
                        selectedReminderContactIds.includes(c.id)
                          ? 'bg-indigo-500 text-white border-indigo-500'
                          : 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-700 hover:border-indigo-400'
                      }`}
                      onClick={() => toggleReminderContactSelect(c.id)}
                      title={c.email ? `选择为提醒人（${c.email}）` : '选择为提醒人'}
                    >
                      提醒→{c.name}{c.email ? ' 📧' : ''}{(c.channel_account_ids?.length ?? 0) > 0 ? ' ✓' : ''}
                    </button>
                  ))}
                  {selectedReminderContactIds.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="text-xs h-7"
                      onClick={applySelectedReminderContacts}
                    >
                      应用 {selectedReminderContactIds.length} 位提醒人
                    </Button>
                  )}
                </div>
              )}
              
              {/* 被提醒人 - 生日/事件所有者 */}
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  被提醒人（事件主角）
                </span>
                <Input
                  placeholder="例如：妈妈、老婆、李四"
                  value={formData.personName || ''}
                  onChange={(e) => setFormData({ ...formData, personName: e.target.value })}
                  className="h-10"
                />
                <p className="text-[10px] text-slate-400">这个人的生日/纪念日/事件</p>
              </div>
              
              {/* 提醒人 - 接收通知的人 */}
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  提醒人（接收通知者）
                </span>
                <Input
                  placeholder="例如：我、爸爸、妻子"
                  value={formData.reminderRecipientName || ''}
                  onChange={(e) => setFormData({ ...formData, reminderRecipientName: e.target.value })}
                  className="h-10"
                />
                <p className="text-[10px] text-slate-400">谁会收到这条提醒通知</p>
              </div>
              
              {/* 提醒人邮箱（可多个） */}
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  提醒人邮箱（可添加多个）
                </span>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="输入邮箱地址，如 user@example.com"
                    value={customEmail}
                    onChange={(e) => setCustomEmail(e.target.value)}
                    className="h-10 flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEmailRecipient(customEmail);
                        setCustomEmail('');
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-10 px-3"
                    onClick={() => {
                      addEmailRecipient(customEmail);
                      setCustomEmail('');
                    }}
                  >
                    <Plus size={14} />
                    添加
                  </Button>
                </div>
                
                {/* 已添加的邮箱列表 */}
                {formData.reminderConfig.emailRecipients && formData.reminderConfig.emailRecipients.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {formData.reminderConfig.emailRecipients.map((email, index) => (
                      <Badge key={index} variant="secondary" className="flex items-center gap-1 px-2 py-1">
                        📧 {email}
                        <button
                          type="button"
                          onClick={() => {
                            setFormData({
                              ...formData,
                              reminderConfig: {
                                ...formData.reminderConfig,
                                emailRecipients: formData.reminderConfig.emailRecipients?.filter((_, i) => i !== index)
                              }
                            });
                          }}
                          className="ml-1 hover:text-red-500"
                        >
                          <X size={12} />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
                
                <p className="text-[10px] text-slate-400">不填则使用「设置 → 默认测试/收件邮箱」；从联系人添加的邮箱会显示为小写</p>
                {fixedContacts.filter((c) => c.email).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <span className="text-[10px] text-slate-400 w-full">从联系人添加邮箱：</span>
                    {fixedContacts.filter((c) => c.email).map((c) => (
                      <button
                        key={`email-${c.id}`}
                        type="button"
                        className="text-[10px] px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-primary-400"
                        onClick={() => setFormData((prev) => ({
                          ...prev,
                          reminderConfig: mergeContactIntoReminderConfig(
                            c,
                            accounts,
                            prev.reminderConfig || defaultReminderConfig,
                          ),
                        }))}
                      >
                        {c.name} ({normalizeEmail(c.email) ?? c.email})
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>

          {/* 备注描述 */}
          <motion.div variants={itemVariants} className="space-y-2.5">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
              <AlignLeft size={16} className="text-primary-500" />
              备注描述（可选）
            </label>
            <Textarea
              placeholder="添加详细信息..."
              value={formData.reminderConfig.customMessage || ''}
              onChange={(e) => setFormData({
                ...formData,
                reminderConfig: { ...formData.reminderConfig, customMessage: e.target.value }
              })}
              className="min-h-[80px]"
            />
          </motion.div>

          {/* 提醒配置 */}
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <Bell size={16} className="text-primary-500" />
                提醒配置
              </label>
              <Switch
                checked={formData.reminderConfig.enabled}
                onCheckedChange={(checked) => setFormData({
                  ...formData,
                  reminderConfig: { ...formData.reminderConfig, enabled: checked }
                })}
              />
            </div>

            <AnimatePresence>
              {formData.reminderConfig.enabled && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-4 pl-2 border-l-2 border-primary-500/30"
                >
                  {/* 提醒时间（可多选 - 预设 + 自定义） */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">提醒时间（可多选）</label>
                    
                    {/* 预设时间选项 */}
                    <div className="flex gap-2 flex-wrap">
                      {reminderTimes.map((time) => (
                        <button
                          key={time}
                          type="button"
                          onClick={() => {
                            const currentTimes = formData.reminderConfig.reminderTimes || [];
                            const newTimes = currentTimes.includes(time)
                              ? currentTimes.filter(t => t !== time)
                              : [...currentTimes, time];
                            setFormData({
                              ...formData,
                              reminderConfig: { ...formData.reminderConfig, reminderTimes: newTimes }
                            });
                          }}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-300 ${
                            formData.reminderConfig.reminderTimes?.includes(time)
                              ? 'bg-primary-500 text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                          }`}
                        >
                          {time}
                        </button>
                      ))}
                    </div>
                    
                    {/* 自定义时间输入 */}
                    <div className="flex gap-2 items-center mt-2">
                      <Input
                        type="time"
                        value={customTime}
                        onChange={(e) => setCustomTime(e.target.value)}
                        className="h-9 w-32"
                      />
                      <Button type="button" variant="secondary" size="sm" onClick={addCustomTime} className="h-9 px-3">
                        <Plus size={16} />
                        添加
                      </Button>
                    </div>
                    
                    {/* 已选择的时间列表 */}
                    {formData.reminderConfig.reminderTimes && formData.reminderConfig.reminderTimes.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {formData.reminderConfig.reminderTimes.map((time) => (
                          <Badge key={time} variant="secondary" className="flex items-center gap-1 px-2 py-1">
                            {time}
                            <button
                              type="button"
                              onClick={() => removeReminderTime(time)}
                              className="ml-1 hover:text-red-500"
                            >
                              <X size={12} />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 提前天数 */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">提前提醒天数</label>
                    <div className="flex flex-wrap gap-2">
                      {reminderDays.map((day) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => toggleReminderDay(day)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-300 ${
                            formData.reminderConfig.daysBeforeList?.includes(day)
                              ? 'bg-primary-500 text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {day}天
                        </button>
                      ))}
                    </div>
                  </div>

                  {reminderTimeline.length > 0 && (
                    <div className="space-y-2" aria-label="下次提醒时间线">
                      <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <CalendarClock size={14} /> 提醒时间线预览
                      </label>
                      <ul className="text-xs space-y-1 max-h-32 overflow-y-auto rounded-xl bg-slate-50 dark:bg-slate-900/50 p-3">
                        {reminderTimeline.map((item, i) => (
                          <li key={`${item.date}-${item.time}-${i}`} className="flex justify-between gap-2 text-slate-600 dark:text-slate-300">
                            <span>{item.date} {item.time}</span>
                            <span className="text-slate-400 shrink-0">
                              {item.daysBefore === 0 ? '当天' : `提前 ${item.daysBefore} 天`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 通知渠道选择 */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">通知渠道</label>
                    <div className="grid grid-cols-4 gap-2">
                      {notificationChannels.map((channel) => {
                        const accountType = channelToAccountType[channel.value];
                        const configuredAccounts = availableChannels.filter(a => a.type === accountType);
                        const hasActive = configuredAccounts.some(a => a.is_active && a.last_test_result !== 'failed');
                        const hasWarning = configuredAccounts.some(a => a.is_active && a.last_test_result === 'failed');
                        const isConfigured = configuredAccounts.length > 0;
                        const isSelected = formData.reminderConfig.channels?.includes(channel.value);
                        const isDisabled = !isConfigured;

                        return (
                          <button
                            key={channel.value}
                            type="button"
                            onClick={() => {
                              if (isDisabled) {
                                navigate('/channels');
                                onClose();
                              } else {
                                toggleChannel(channel.value);
                              }
                            }}
                            className={`relative h-full min-h-[48px] w-full rounded-xl text-xs font-medium transition-all duration-300 flex flex-col items-center justify-center gap-1 p-1.5 ${
                              isSelected
                                ? 'bg-primary-500/20 text-primary-600 dark:text-primary-400 border border-primary-500/30'
                                : isDisabled
                                  ? 'bg-slate-50/60 dark:bg-slate-900/40 text-slate-300 dark:text-slate-600 border border-dashed border-slate-200 dark:border-slate-700 cursor-pointer'
                                  : hasWarning
                                    ? 'bg-yellow-50/80 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-800/50 alive-interactive'
                                    : 'bg-slate-100/80 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border border-transparent alive-interactive'
                            }`}
                            title={isDisabled ? '未配置，点击去配置' : hasWarning ? '已配置但测试失败' : hasActive ? '已配置且可用' : ''}
                          >
                            {/* 状态指示点 */}
                            <span className={`absolute top-1 right-1 w-2 h-2 rounded-full ${
                              isDisabled
                                ? 'bg-slate-300 dark:bg-slate-600'
                                : hasWarning
                                  ? 'bg-yellow-500'
                                  : 'bg-green-500'
                            }`} />
                            <span className={`text-base leading-none ${isDisabled ? 'opacity-40' : ''}`}>{channel.icon}</span>
                            <span className="text-center leading-tight line-clamp-2">{channel.label}</span>
                            {isDisabled && (
                              <span className="flex items-center gap-0.5 text-[9px] text-slate-400 dark:text-slate-500">
                                <ExternalLink size={8} />
                                去配置
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 已选账号摘要 */}
                  {formData.reminderConfig.channels && formData.reminderConfig.channels.length > 0 && (
                    <div className="space-y-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                      <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">通知账户</label>
                      <div className="space-y-2">
                        {notificationChannels
                          .filter(ch => formData.reminderConfig.channels?.includes(ch.value))
                          .map(channel => {
                            const accountType = channelToAccountType[channel.value];
                            const selectedIds = formData.reminderConfig.accountIds || [];
                            const channelAccounts = accounts.filter(a => a.type === accountType && selectedIds.includes(String(a.id)));

                            return (
                              <div key={channel.value} className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2">
                                  <span className="text-base">{channel.icon}</span>
                                  <span className="font-medium text-slate-700 dark:text-slate-300">{channel.label}</span>
                                </div>
                                <div className="text-xs text-slate-500 dark:text-slate-400 max-w-[55%] truncate text-right">
                                  {channelAccounts.length > 0
                                    ? channelAccounts.map(a => a.name).join('、')
                                    : '未选择账号'}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}


                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* 通知预览 */}
          <motion.div variants={itemVariants} className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <Eye size={16} className="text-primary-500" />
                通知预览
              </label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPreviewOpen(true)}
                className="rounded-lg"
              >
                <Eye size={14} className="mr-1" />
                预览通知
              </Button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              预览通知内容将根据您填写的事件信息自动生成
            </p>
          </motion.div>

          {/* 重复事件 */}
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <Calendar size={16} className="text-primary-500" />
                重复事件
              </label>
              <Switch
                checked={formData.recurringConfig?.enabled || false}
                onCheckedChange={(checked) => setFormData({
                  ...formData,
                  recurringConfig: checked ? {
                    enabled: true,
                    frequency: 'yearly',
                    interval: 1,
                    endType: 'never',
                  } : undefined
                })}
              />
            </div>

            <AnimatePresence>
              {formData.recurringConfig?.enabled && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-4 pl-2 border-l-2 border-primary-500/30"
                >
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">重复频率</label>
                    <div className="flex gap-2 flex-wrap">
                      {[
                        { value: 'daily', label: '每天' },
                        { value: 'weekly', label: '每周' },
                        { value: 'monthly', label: '每月' },
                        { value: 'yearly', label: '每年' },
                      ].map((freq) => (
                        <button
                          key={freq.value}
                          type="button"
                          onClick={() => setFormData({
                            ...formData,
                            recurringConfig: { ...formData.recurringConfig!, frequency: freq.value as any }
                          })}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-300 ${
                            formData.recurringConfig?.frequency === freq.value
                              ? 'bg-primary-500 text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {freq.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">间隔</label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-600 dark:text-slate-300">每</span>
                      <Input
                        type="number"
                        min="1"
                        max="99"
                        value={formData.recurringConfig?.interval || 1}
                        onChange={(e) => setFormData({
                          ...formData,
                          recurringConfig: { ...formData.recurringConfig!, interval: parseInt(e.target.value) || 1 }
                        })}
                        className="w-20 h-9"
                      />
                      <span className="text-sm text-slate-600 dark:text-slate-300">
                        {formData.recurringConfig?.frequency === 'daily' ? '天' :
                         formData.recurringConfig?.frequency === 'weekly' ? '周' :
                         formData.recurringConfig?.frequency === 'monthly' ? '月' : '年'}
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* 提交按钮 */}
          <motion.div variants={itemVariants} className="pt-4 flex gap-3">
            <Button type="button" variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              variant="vision"
              className="flex-1 h-12 rounded-2xl font-bold shadow-xl shadow-primary-500/30"
              disabled={loading}
            >
              {loading ? '保存中...' : '确认保存'}
            </Button>
          </motion.div>
        </motion.form>

        {/* 通知预览弹窗 */}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-md rounded-[1.5rem] p-6">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white">
                <Eye size={24} className="text-primary-500" />
                通知预览
              </DialogTitle>
            </DialogHeader>
            
            <div className="space-y-4">
              {/* 模板选择 - 按事件类型分组 */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  选择模板（{eventTypes.find(t => t.value === formData.type)?.label || '其他'}类型）
                </label>
                <div className="flex flex-wrap gap-2">
                  {currentEventTypeTemplates.map(template => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        selectedTemplateId === template.id
                          ? 'bg-primary-500 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {template.name}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* 预览内容 */}
              <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4">
                <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                  {generatePreview()}
                </p>
              </div>
              
              <p className="text-xs text-slate-400 dark:text-slate-500">
                💡 实际通知内容会根据事件日期和提醒设置自动调整
              </p>
            </div>
          </DialogContent>
        </Dialog>

        {/* 账号选择弹窗 */}
        <Dialog open={accountPickerOpen} onOpenChange={setAccountPickerOpen}>
          <DialogContent className="max-w-md rounded-[1.5rem] p-6" onPointerDownOutside={(e) => e.preventDefault()}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white">
                <span className="text-2xl">
                  {notificationChannels.find(c => c.value === accountPickerChannel)?.icon}
                </span>
                选择 {notificationChannels.find(c => c.value === accountPickerChannel)?.label} 账号
              </DialogTitle>
            </DialogHeader>
            {accountsLoading ? (
              <div className="flex items-center justify-center py-8 gap-2 text-slate-500">
                <div className="w-5 h-5 border-2 border-slate-300 border-t-primary-500 rounded-full animate-spin" />
                加载中...
              </div>
            ) : pickerAccounts.length === 0 ? (
              <div className="py-8 text-center text-slate-500">
                <p>暂无可用账号</p>
                <p className="text-xs text-slate-400 mt-1">请在设置中添加账户后重试</p>
              </div>
            ) : (
              <div className="space-y-2 py-2 max-h-[300px] overflow-y-auto">
                {pickerAccounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => togglePickerAccount(String(account.id))}
                    className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${
                      pickerSelectedIds.includes(String(account.id))
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
                  >
                    <span className="font-medium">{account.name}</span>
                    {pickerSelectedIds.includes(String(account.id)) && (
                      <span className="text-primary-500 font-bold">✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button type="button" variant="secondary" className="flex-1 h-11 rounded-xl" onClick={cancelPicker}>
                取消
              </Button>
              <Button type="button" variant="vision" className="flex-1 h-11 rounded-xl" onClick={confirmPicker}>
                确认
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}