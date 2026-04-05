import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CalendarClock, Type, AlignLeft, Globe, Bell, Mail, Users, Plus, X, Heart, GraduationCap, PartyPopper, Calendar, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lunar, Solar } from 'lunar-javascript';
import type { Event, CreateEventRequest, EventType, CalendarType, ReminderConfig, LunarDate } from '@timemark/shared';

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
  { value: 'other', label: '其他', icon: <Sparkles size={18} />, color: 'bg-purple-500' },
];

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
    const date = new Date(gregorianDate);
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
  // Email (mandatory)
  { value: 'email', label: '邮件', icon: '📧' },
  // Webhook channels
  { value: 'feishu', label: '飞书', icon: '📱' },
  { value: 'dingtalk', label: '钉钉', icon: '🔔' },
  { value: 'wecom', label: '企业微信', icon: '💬' },
  { value: 'discord', label: 'Discord', icon: '🎮' },
  { value: 'slack', label: 'Slack', icon: '💼' },
  { value: 'googlechat', label: 'Google Chat', icon: '🔵' },
  // Token-based channels
  { value: 'telegram', label: 'Telegram', icon: '✈️' },
  { value: 'line', label: 'LINE', icon: '🟢' },
  { value: 'matrix', label: 'Matrix', icon: '⚡' },
  { value: 'mattermost', label: 'Mattermost', icon: '🧱' },
  { value: 'msteams', label: 'MS Teams', icon: '📊' },
  // Plugin-based channels
  { value: 'wechat', label: '微信', icon: '💚' },
  { value: 'whatsapp', label: 'WhatsApp', icon: '📲' },
  { value: 'qqbot', label: 'QQ', icon: '🐧' },
  { value: 'signal', label: 'Signal', icon: '🔒' },
  { value: 'zalo', label: 'Zalo', icon: '💌' },
  { value: 'nostr', label: 'Nostr', icon: '🕸️' },
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

  const [newEmail, setNewEmail] = useState('');
  const [customTime, setCustomTime] = useState('');

  useEffect(() => {
    if (event && open) {
      // Safe date parsing
      let safeDate = '';
      if (event.date) {
        const date = new Date(event.date);
        if (!isNaN(date.getTime())) {
          const tzOffset = date.getTimezoneOffset() * 60000;
          safeDate = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
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
    
    // Validate date
    const targetDate = new Date(formData.date);
    if (isNaN(targetDate.getTime())) {
      alert('无效的日期格式');
      return;
    }

    setLoading(true);
    try {
      // Convert date to YYYY-MM-DD string for PostgreSQL
      const targetDate = new Date(formData.date);
      if (isNaN(targetDate.getTime())) {
        alert('无效的日期格式');
        return;
      }
      
      // Format as YYYY-MM-DD for PostgreSQL
      const dateStr = targetDate.toISOString().split('T')[0];
      
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

  const addEmail = () => {
    if (!newEmail.trim()) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      alert('请输入有效的邮箱地址');
      return;
    }
    const currentEmails = formData.reminderConfig.emailRecipients || [];
    if (currentEmails.includes(newEmail)) {
      alert('该邮箱已存在');
      return;
    }
    setFormData({
      ...formData,
      reminderConfig: {
        ...formData.reminderConfig,
        emailRecipients: [...currentEmails, newEmail],
      },
    });
    setNewEmail('');
  };

  const removeEmail = (email: string) => {
    setFormData({
      ...formData,
      reminderConfig: {
        ...formData.reminderConfig,
        emailRecipients: formData.reminderConfig.emailRecipients?.filter(e => e !== email) || [],
      },
    });
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

  const toggleChannel = (channel: string) => {
    const currentChannels = formData.reminderConfig.channels || [];
    const newChannels = currentChannels.includes(channel)
      ? currentChannels.filter(c => c !== channel)
      : [...currentChannels, channel];
    
    setFormData({
      ...formData,
      reminderConfig: {
        ...formData.reminderConfig,
        channels: newChannels,
      },
    });
  };

  const handleTypeChange = (type: EventType) => {
    setFormData({ ...formData, type });
  };

  const handleCalendarTypeChange = (calendarType: CalendarType) => {
    setFormData({ ...formData, calendarType });
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
            
            {/* 被提醒人 - 生日/事件所有者 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className="text-xs text-slate-500 dark:text-slate-400">被提醒人（事件所有者）</span>
                <Input
                  placeholder="例如：我爸、妈妈、李四"
                  value={formData.personName || ''}
                  onChange={(e) => setFormData({ ...formData, personName: e.target.value })}
                  className="h-10"
                />
              </div>
              
              {/* 提醒人 - 接收通知的人 */}
              <div className="space-y-1.5">
                <span className="text-xs text-slate-500 dark:text-slate-400">提醒人（接收通知者）</span>
                <Input
                  placeholder="例如：我、妻子、王五"
                  value={formData.reminderRecipientName || ''}
                  onChange={(e) => setFormData({ ...formData, reminderRecipientName: e.target.value })}
                  className="h-10"
                />
              </div>
            </div>
            
            {/* 提醒人邮箱（可选） */}
            <div className="space-y-1.5">
              <span className="text-xs text-slate-500 dark:text-slate-400">提醒人邮箱（可选）</span>
              <Input
                type="email"
                placeholder="提醒人专属邮箱，不填则使用默认邮箱"
                value={formData.reminderRecipientEmail || ''}
                onChange={(e) => setFormData({ ...formData, reminderRecipientEmail: e.target.value })}
                className="h-10"
              />
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
                          className={`p-2 rounded-xl text-sm font-medium transition-all duration-300 alive-interactive flex items-center gap-1.5 ${
                            formData.reminderConfig.channels?.includes(channel.value)
                              ? 'bg-primary-500/20 text-primary-600 dark:text-primary-400 border border-primary-500/30'
                              : 'bg-slate-100/80 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border border-transparent'
                          }`}
                        >
                          <span>{channel.icon}</span>
                          <span>{channel.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 邮件收件人 */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
                      <Mail size={14} />
                      邮件收件人
                    </label>
                    <div className="flex gap-2">
                      <Input
                        type="email"
                        placeholder="输入邮箱地址"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addEmail())}
                        className="h-10 flex-1"
                      />
                      <Button type="button" variant="secondary" size="sm" onClick={addEmail} className="h-10 px-4">
                        <Plus size={16} />
                      </Button>
                    </div>
                    {formData.reminderConfig.emailRecipients && formData.reminderConfig.emailRecipients.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {formData.reminderConfig.emailRecipients.map((email) => (
                          <Badge key={email} variant="secondary" className="flex items-center gap-1 px-3 py-1">
                            {email}
                            <button
                              type="button"
                              onClick={() => removeEmail(email)}
                              className="hover:text-red-500 transition-colors"
                            >
                              <X size={14} />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
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
      </DialogContent>
    </Dialog>
  );
}