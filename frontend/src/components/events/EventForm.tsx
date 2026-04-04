import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Select } from '../ui/select';
import { X, Plus, ChevronLeft } from 'lucide-react';
import { solarToLunar } from '@/lib/lunar';
import { api } from '@/lib/api';
import type { Event, CreateEventRequest, NotificationChannel } from '@timemark/shared';

interface EventFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateEventRequest) => Promise<void>;
  event?: Event;
}

interface BirthdayData {
  personName?: string;
  birthDate?: string;
  birthDateLunar?: string;
}

interface RelationshipMapping {
  id: string;
  eventId: string;
  fromRelation: string;
  toRelation: string;
  recipientEmail?: string;
  recipientType?: string;
}

type FormStep = 'type' | 'details' | 'reminder' | 'notification';

export function EventForm({ open, onClose, onSubmit, event }: EventFormProps) {
  const [step, setStep] = useState<FormStep>('type');
  const [formData, setFormData] = useState<CreateEventRequest>({
    name: '',
    type: 'other',
    date: '',
    calendarType: 'gregorian',
    lunarDate: undefined,
    reminderConfig: {
      enabled: false,
      daysBeforeList: [],
      emailRecipients: [],
      channels: [],
      accountIds: [],
    },
  });

  const [birthdayData, setBirthdayData] = useState<BirthdayData>();
  const [reminderDays, setReminderDays] = useState<number[]>([]);
  const [inputDay, setInputDay] = useState<string>('');
  const [emailInput, setEmailInput] = useState<string>('');
  const [selectedChannels, setSelectedChannels] = useState<NotificationChannel[]>([]);
  const [relationshipMappings, setRelationshipMappings] = useState<RelationshipMapping[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState<string>('');

  useEffect(() => {
    if (open) {
      if (event) {
        setStep('type');
        setFormData({
          name: event.name || '',
          type: event.type || 'other',
          date: event.date || '',
          calendarType: event.calendarType || 'gregorian',
          lunarDate: event.lunarDate,
          reminderConfig: event.reminderConfig || {
            enabled: false,
            daysBeforeList: [],
            emailRecipients: [],
            channels: [],
            accountIds: [],
          },
        });
        setBirthdayData({
          personName: event.personName || '',
          birthDate: event.birthDate || '',
          birthDateLunar: event.birthDateLunar || '',
        });
        setReminderDays(event.reminderConfig?.daysBeforeList || []);
        setSelectedChannels(event.reminderConfig?.channels || []);
        setSelectedMappingId(event.relationshipMappingId || '');
      } else {
        setStep('type');
        setFormData({
          name: '',
          type: 'other',
          date: '',
          calendarType: 'gregorian',
          lunarDate: undefined,
          reminderConfig: {
            enabled: false,
            daysBeforeList: [],
            emailRecipients: [],
            channels: [],
            accountIds: [],
          },
        });
        setBirthdayData(undefined);
        setReminderDays([]);
        setSelectedChannels([]);
        setEmailInput('');
        setSelectedMappingId('');
      }
    }
  }, [event, open]);

  // 加载关系映射列表
  useEffect(() => {
    const loadMappings = async () => {
      try {
        const data = await api.get<RelationshipMapping[]>('/config/relationships');
        setRelationshipMappings(data);
      } catch (error) {
        console.error('Failed to load relationship mappings:', error);
      }
    };
    loadMappings();
  }, []);

  const addReminderDay = (day: number) => {
    if (day < 0) return;
    if (!reminderDays.includes(day)) {
      setReminderDays([...reminderDays, day].sort((a, b) => a - b));
    }
    setInputDay('');
  };

  const removeReminderDay = (day: number) => {
    setReminderDays(reminderDays.filter(d => d !== day));
  };

  const addEmail = () => {
    if (emailInput && emailInput.includes('@')) {
      const current = formData.reminderConfig.emailRecipients;
      if (!current.includes(emailInput)) {
        setFormData({
          ...formData,
          reminderConfig: { ...formData.reminderConfig, emailRecipients: [...current, emailInput] }
        });
      }
      setEmailInput('');
    }
  };

  const removeEmail = (email: string) => {
    setFormData({
      ...formData,
      reminderConfig: {
        ...formData.reminderConfig,
        emailRecipients: formData.reminderConfig.emailRecipients.filter(e => e !== email)
      }
    });
  };

  const toggleChannel = (channel: NotificationChannel) => {
    setSelectedChannels(prev =>
      prev.includes(channel) ? prev.filter(c => c !== channel) : [...prev, channel]
    );
  };

  const handleSubmit = async () => {
    const updatedFormData = {
      ...formData,
      reminderConfig: {
        enabled: reminderDays.length > 0,
        daysBeforeList: reminderDays,
        emailRecipients: formData.reminderConfig.emailRecipients,
        channels: selectedChannels,
        accountIds: [],
      },
      ...(formData.type === 'birthday' && birthdayData && {
        personName: birthdayData.personName,
        birthDate: birthdayData.birthDate,
        birthDateLunar: birthdayData.birthDateLunar,
      }),
      ...(selectedMappingId && { relationshipMappingId: selectedMappingId }),
    };
    await onSubmit(updatedFormData);
    onClose();
  };

  const getStepTitle = () => {
    switch (step) {
      case 'type': return '选择事件类型';
      case 'details': return '填写事件详情';
      case 'reminder': return '设置提醒时间';
      case 'notification': return '选择通知方式';
    }
  };

  const canProceed = () => {
    switch (step) {
      case 'type': return formData.type !== '';
      case 'details': return formData.name && formData.date;
      case 'reminder': return true;
      case 'notification': return true;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step !== 'type' && (
              <button type="button" onClick={() => {
                if (step === 'details') setStep('type');
                else if (step === 'reminder') setStep('details');
                else if (step === 'notification') setStep('reminder');
              }} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {getStepTitle()}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          {step === 'type' && (
            <div className="grid grid-cols-2 gap-3">
              {[
                { value: 'birthday', label: '🎂 生日', color: 'bg-pink-500' },
                { value: 'exam', label: '📝 考试', color: 'bg-blue-500' },
                { value: 'anniversary', label: '💝 纪念日', color: 'bg-purple-500' },
                { value: 'holiday', label: '🎉 节日', color: 'bg-green-500' },
                { value: 'other', label: '📌 其他', color: 'bg-gray-500' },
              ].map(type => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => {
                    setFormData({ ...formData, type: type.value as any });
                    setStep('details');
                  }}
                  className={`p-6 rounded-xl border-2 transition-all ${
                    formData.type === type.value
                      ? `${type.color} text-white border-transparent`
                      : 'glass border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  <div className="text-2xl font-semibold">{type.label}</div>
                </button>
              ))}
            </div>
          )}

          {step === 'details' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">事件名称</label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="输入事件名称"
                  className="h-11"
                />
              </div>

              {formData.type === 'birthday' ? (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1.5">姓名</label>
                    <Input
                      value={birthdayData?.personName || ''}
                      onChange={(e) => setBirthdayData({ ...birthdayData, personName: e.target.value })}
                      placeholder="请输入姓名"
                      className="h-11"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5">公历生日</label>
                    <Input
                      type="date"
                      value={birthdayData?.birthDate || ''}
                      onChange={(e) => {
                        const solarDate = e.target.value;
                        if (solarDate) {
                          const lunar = solarToLunar(new Date(solarDate));
                          const lunarStr = `${lunar.year}-${lunar.month}-${lunar.day}`;
                          setBirthdayData({ personName: birthdayData?.personName, birthDate: solarDate, birthDateLunar: lunarStr });
                          setFormData({ ...formData, date: solarDate, calendarType: 'gregorian', lunarDate: lunar });
                        }
                      }}
                      className="h-11"
                    />
                    {birthdayData?.birthDateLunar && (
                      <p className="text-xs text-muted-foreground mt-1">对应农历：{birthdayData.birthDateLunar}</p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1.5">日期</label>
                    <Input
                      type="date"
                      value={formData.date}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="h-11"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1.5">日历类型</label>
                    <Select
                      value={formData.calendarType}
                      onChange={(e) => setFormData({ ...formData, calendarType: e.target.value as 'gregorian' | 'lunar' | 'both' })}
                      className="h-11"
                    >
                      <option value="gregorian">公历</option>
                      <option value="lunar">农历</option>
                      <option value="both">双历</option>
                    </Select>
                  </div>

                  {formData.calendarType !== 'gregorian' && (
                    <div>
                      <label className="block text-sm font-medium mb-1.5">农历日期</label>
                      <Input
                        type="text"
                        value={formData.lunarDate ? `${formData.lunarDate.year}-${formData.lunarDate.month}-${formData.lunarDate.day}` : ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) {
                            const parts = val.split('-').map(Number);
                            if (parts.length === 3) {
                              setFormData({ ...formData, lunarDate: { year: parts[0], month: parts[1], day: parts[2], leap: false } });
                            }
                          } else {
                            setFormData({ ...formData, lunarDate: undefined });
                          }
                        }}
                        placeholder="格式: 2026-1-15"
                        className="h-11"
                      />
                    </div>
                  )}
                </>
              )}

              <Button type="button" onClick={() => setStep('reminder')} disabled={!canProceed()} className="w-full h-11">
                下一步
              </Button>
            </div>
          )}

          {step === 'reminder' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input
                  type="number"
                  min="0"
                  value={inputDay}
                  onChange={(e) => setInputDay(e.target.value)}
                  placeholder="输入天数"
                  className="h-10 flex-1"
                />
                <Button type="button" size="sm" onClick={() => addReminderDay(Number(inputDay))} disabled={!inputDay}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => addReminderDay(0)}>当天</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => addReminderDay(1)}>1天前</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => addReminderDay(3)}>3天前</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => addReminderDay(7)}>7天前</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {reminderDays.map(day => (
                  <Badge key={day} variant="secondary" className="gap-1">
                    {day === 0 ? '当天' : `${day}天前`}
                    <X className="w-3 h-3 cursor-pointer" onClick={() => removeReminderDay(day)} />
                  </Badge>
                ))}
              </div>
              <Button type="button" onClick={() => setStep('notification')} className="w-full h-11">
                下一步
              </Button>
            </div>
          )}

          {step === 'notification' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">邮箱地址</label>
                <div className="flex gap-2 mb-2">
                  <Input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="输入邮箱地址"
                    className="h-10 flex-1"
                    onKeyPress={(e) => e.key === 'Enter' && addEmail()}
                  />
                  <Button type="button" size="sm" onClick={addEmail} disabled={!emailInput}>
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.reminderConfig.emailRecipients.map(email => (
                    <Badge key={email} variant="secondary" className="gap-1">
                      {email}
                      <X className="w-3 h-3 cursor-pointer" onClick={() => removeEmail(email)} />
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">通知渠道</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: 'email' as const, label: '📧 邮件' },
                    { value: 'feishu' as const, label: '🚀 Feishu' },
                    { value: 'dingtalk' as const, label: '💼 DingTalk' },
                    { value: 'wecom' as const, label: '💬 企业微信' },
                    { value: 'telegram' as const, label: '✈️ Telegram' },
                    { value: 'slack' as const, label: '💬 Slack' },
                    { value: 'discord' as const, label: '🎮 Discord' },
                    { value: 'google_chat' as const, label: '💼 Google Chat' },
                    { value: 'microsoft_teams' as const, label: '👥 Microsoft Teams' },
                    { value: 'mattermost' as const, label: '🧩 Mattermost' },
                    { value: 'matrix' as const, label: '🔷 Matrix' },
                    { value: 'line' as const, label: '🟩 LINE' },
                    { value: 'nextcloud_talk' as const, label: '☁️ Nextcloud Talk' },
                    { value: 'irc' as const, label: '🧵 IRC' },
                    { value: 'signal' as const, label: '🔒 Signal' },
                    { value: 'whatsapp' as const, label: '🟢 WhatsApp' },
                    { value: 'imessage' as const, label: '💙 iMessage' },
                    { value: 'bluebubbles' as const, label: '🔵 BlueBubbles' },
                    { value: 'nostr' as const, label: '⚡ Nostr' },
                    { value: 'synology_chat' as const, label: '🗂️ Synology Chat' },
                    { value: 'tlon' as const, label: '🌐 Tlon' },
                    { value: 'twitch' as const, label: '🟣 Twitch' },
                    { value: 'zalo' as const, label: '🇻🇳 Zalo' },
                    { value: 'zalo_personal' as const, label: '🇻🇳 Zalo Personal' },
                    { value: 'wechat' as const, label: '🟢 微信(WxPusher)' },
                    { value: 'qq' as const, label: '🐧 QQ(Qmsg)' },
                    { value: 'network_chat' as const, label: '🌍 网络聊天' },
                                    ].map(channel => (
                    <button
                      key={channel.value}
                      type="button"
                      onClick={() => toggleChannel(channel.value)}
                      className={`p-3 rounded-lg border-2 transition-all text-sm ${
                        selectedChannels.includes(channel.value)
                          ? 'bg-primary-500 text-white border-transparent'
                          : 'glass border-gray-200 dark:border-gray-700 hover:border-gray-300'
                      }`}
                    >
                      {channel.label}
                    </button>
                  ))}
                </div>
              </div>

              {relationshipMappings.length > 0 && (
                <div>
                  <label className="block text-sm font-medium mb-2">关系映射</label>
                  <Select
                    value={selectedMappingId}
                    onChange={(e) => setSelectedMappingId(e.target.value)}
                    className="h-10"
                  >
                    <option value="">不映射（使用原始称呼）</option>
                    {relationshipMappings.map(mapping => (
                      <option key={mapping.id} value={mapping.id}>
                        {mapping.fromRelation} → {mapping.toRelation}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    选择后，发送通知时将应用该称呼转换
                  </p>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button type="button" variant="outline" onClick={onClose} className="flex-1 h-11">取消</Button>
                <Button type="button" onClick={handleSubmit} className="flex-1 h-11">保存</Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
