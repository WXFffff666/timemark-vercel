import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CalendarClock, Type, AlignLeft, Globe, Bell, Users, Plus, X, Heart, GraduationCap, PartyPopper, Calendar, Sparkles, ChevronDown, Clock, Eye } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lunar, Solar } from 'lunar-javascript';
import { api } from '@/lib/api';
import { PRESET_TEMPLATES, renderTemplate } from '@timemark/shared/templates';
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
  { value: 'nostr', label: 'Nostr', icon: '🕸️' },
  { value: 'wxpusher', label: 'WxPusher', icon: '💚' },
  { value: 'qmsg', label: 'Qmsg', icon: '🐧' },
  // New token-based channels (batch 2)
  { value: 'clawbot', label: '微信龙虾', icon: '🦞' },
  { value: 'serverchan', label: 'Server酱', icon: '📡' },
  { value: 'pushplus', label: 'PushPlus', icon: '➕' },
  { value: 'bark', label: 'Bark', icon: '🐕' },
  { value: 'gotify', label: 'Gotify', icon: '📨' },
  { value: 'meow', label: '喵推送', icon: '🐱' },
  { value: 'pushme', label: 'PushMe', icon: '📲' },
  { value: 'wecomapp', label: '企微应用', icon: '🏢' },
  // Plugin-based channels
  { value: 'wechat_official', label: '微信公众号', icon: '📣' },
  { value: 'wechat_personal', label: '微信个人号', icon: '💬' },
  { value: 'whatsapp', label: 'WhatsApp', icon: '📲' },
  { value: 'qqbot', label: 'QQ Bot', icon: '🐧' },
  { value: 'signal', label: 'Signal', icon: '🔒' },
  { value: 'zalo', label: 'Zalo', icon: '💌' },
  { value: 'imessage', label: 'iMessage', icon: '🍎' },
];

const defaultReminderConfig: ReminderConfig = {
  enabled: true,
  daysBeforeList: [1, 3],
  emailRecipients: [],
  reminderTimes: ['09:00'],
  channels: [],
};

export function EventForm({ open, onClose, onSubmit, event }: EventFormProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<CreateEventRequest>({
    name: '',
    type: 'birthday',
    date: '',
    calendarType: 'gregorian',
    lunarDate: undefined,
    reminderConfig: defaultReminderConfig,
  });

  const [lunarInputValue, setLunarInputValue] = useState('');

  const [customTime, setCustomTime] = useState('');
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
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('birthday');
  const [userTemplates, setUserTemplates] = useState<Array<{id: string; name: string; content: string}>>([]);

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
      
      const submissionData: CreateEventRequest = {
        ...formData,
        date: dateStr,
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
    nostr: 'nostr',
    whatsapp: 'whatsapp',
    signal: 'signal',
    zalo: 'zalo',
    wechat_official: 'wxpusher',
    wechat_personal: 'wechat_personal',
    qqbot: 'qqbot',
    qmsg: 'qmsg',
    wxpusher: 'wxpusher',
    clawbot: 'clawbot',
    serverchan: 'serverchan',
    pushplus: 'pushplus',
    bark: 'bark',
    gotify: 'gotify',
    meow: 'meow',
    pushme: 'pushme',
    wecomapp: 'wecomapp',
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
              
              {/* 提醒人邮箱（可选） */}
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  提醒人邮箱（可选）
                </span>
                <Input
                  type="email"
                  placeholder="不填则使用通知渠道配置的邮箱"
                  value={formData.reminderRecipientEmail || ''}
                  onChange={(e) => setFormData({ ...formData, reminderRecipientEmail: e.target.value })}
                  className="h-10"
                />
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

                  {/* 通知渠道选择 */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">通知渠道</label>
                    <div className="grid grid-cols-4 gap-2">
                      {notificationChannels.map((channel) => (
                        <button
                          key={channel.value}
                          type="button"
                          onClick={() => toggleChannel(channel.value)}
                          className={`h-full min-h-[48px] w-full rounded-xl text-xs font-medium transition-all duration-300 alive-interactive flex flex-col items-center justify-center gap-1 p-1.5 ${
                            formData.reminderConfig.channels?.includes(channel.value)
                              ? 'bg-primary-500/20 text-primary-600 dark:text-primary-400 border border-primary-500/30'
                              : 'bg-slate-100/80 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border border-transparent'
                          }`}
                        >
                          <span className="text-base leading-none">{channel.icon}</span>
                          <span className="text-center leading-tight line-clamp-2">{channel.label}</span>
                        </button>
                      ))}
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
              {/* 模板选择 */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">选择模板</label>
                <div className="flex flex-wrap gap-2">
                  {allTemplates.map(template => (
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