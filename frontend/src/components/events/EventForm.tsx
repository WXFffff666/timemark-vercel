import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { X, Plus } from 'lucide-react';
import { solarToLunar, lunarToSolar, type LunarDate } from '@/lib/lunar';
import type { Event, CreateEventRequest } from '@timemark/shared';

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

export function EventForm({ open, onClose, onSubmit, event }: EventFormProps) {
  const [formData, setFormData] = useState<CreateEventRequest>({
    name: event?.name || '',
    type: event?.type || 'other',
    date: event?.date || '',
    calendarType: event?.calendarType || 'gregorian',
    lunarDate: event?.lunarDate,
    reminderConfig: event?.reminderConfig || {
      enabled: false,
      daysBeforeList: [1, 3, 7],
      emailRecipients: [],
    },
  });

  const [birthdayData, setBirthdayData] = useState<BirthdayData>({
    personName: event?.personName || '',
    birthDate: event?.birthDate || '',
    birthDateLunar: event?.birthDateLunar || '',
  });

  const [reminderDays, setReminderDays] = useState<number[]>(
    event?.reminderConfig?.daysBeforeList || [1, 3, 7]
  );
  const [inputDay, setInputDay] = useState<string>('');

  useEffect(() => {
    if (open) {
      if (event) {
        setFormData({
          name: event.name || '',
          type: event.type || 'other',
          date: event.date || '',
          calendarType: event.calendarType || 'gregorian',
          lunarDate: event.lunarDate,
          reminderConfig: event.reminderConfig || {
            enabled: false,
            daysBeforeList: [1, 3, 7],
            emailRecipients: [],
          },
        });
        setBirthdayData({
          personName: event.personName || '',
          birthDate: event.birthDate || '',
          birthDateLunar: event.birthDateLunar || '',
        });
        setReminderDays(event.reminderConfig?.daysBeforeList || [1, 3, 7]);
      } else {
        setFormData({
          name: '',
          type: 'other',
          date: '',
          calendarType: 'gregorian',
          lunarDate: undefined,
          reminderConfig: {
            enabled: false,
            daysBeforeList: [1, 3, 7],
            emailRecipients: [],
          },
        });
        setBirthdayData({
          personName: '',
          birthDate: '',
          birthDateLunar: '',
        });
        setReminderDays([1, 3, 7]);
      }
    }
  }, [event, open]);

  const handleCalendarTypeChange = (type: 'gregorian' | 'lunar') => {
    if (type === 'lunar' && formData.date) {
      const lunar = solarToLunar(new Date(formData.date));
      setFormData({ ...formData, calendarType: type, lunarDate: lunar });
    } else {
      setFormData({ ...formData, calendarType: type });
    }
  };

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

  // 生日自动换算
  useEffect(() => {
    if (formData.type === 'birthday' && formData.date) {
      if (formData.calendarType === 'gregorian') {
        const lunar = solarToLunar(new Date(formData.date));
        setFormData(prev => ({ ...prev, lunarDate: lunar }));
      } else if (formData.lunarDate) {
        const solar = lunarToSolar(formData.lunarDate);
        setFormData(prev => ({ ...prev, date: solar.toISOString().split('T')[0] }));
      }
    }
  }, [formData.type, formData.calendarType, formData.date]);

  // 监听event变化，重新初始化表单
  useEffect(() => {
    if (event && open) {
      setFormData({
        name: event.name || '',
        type: event.type || 'other',
        date: event.date || '',
        calendarType: event.calendarType || 'gregorian',
        lunarDate: event.lunarDate,
        reminderConfig: event.reminderConfig || {
          enabled: false,
          daysBeforeList: [1, 3, 7],
          emailRecipients: [],
        },
      });
      setBirthdayData({
        personName: event.personName || '',
        birthDate: event.birthDate || '',
        birthDateLunar: event.birthDateLunar || '',
      });
      setReminderDays(event.reminderConfig?.daysBeforeList || [1, 3, 7]);
    }
  }, [event, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const updatedFormData = {
      ...formData,
      reminderConfig: {
        enabled: reminderDays.length > 0,
        daysBeforeList: reminderDays,
        emailRecipients: [],
      },
      ...(formData.type === 'birthday' && {
        personName: birthdayData.personName,
        birthDate: formData.calendarType === 'gregorian' ? formData.date : formData.date,
        birthDateLunar: formData.lunarDate ? `${formData.lunarDate.year}-${formData.lunarDate.month}-${formData.lunarDate.day}` : undefined,
      }),
    } as any;
    await onSubmit(updatedFormData);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {event ? '编辑事件' : '创建事件'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">事件名称</label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="h-11"
              placeholder="输入事件名称"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">事件类型</label>
            <Select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
              className="h-11"
            >
              <option value="birthday">生日</option>
              <option value="exam">考试</option>
              <option value="anniversary">纪念日</option>
              <option value="holiday">节日</option>
              <option value="other">其他</option>
            </Select>
          </div>
          
          {formData.type === 'birthday' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">姓名</label>
                <Input
                  value={birthdayData.personName || ''}
                  onChange={(e) => setBirthdayData({ ...birthdayData, personName: e.target.value })}
                  placeholder="请输入姓名"
                  className="h-11"
                />
              </div>
              
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">公历生日</label>
                  <Input
                    type="date"
                    value={birthdayData.birthDate || ''}
                    onChange={(e) => {
                      const solarDate = e.target.value;
                      setBirthdayData({ ...birthdayData, birthDate: solarDate });
                      if (solarDate) {
                        const lunar = solarToLunar(new Date(solarDate));
                        const lunarStr = `${lunar.year}-${lunar.month}-${lunar.day}`;
                        setBirthdayData(prev => ({ ...prev, birthDate: solarDate, birthDateLunar: lunarStr }));
                        setFormData(prev => ({ ...prev, date: solarDate, calendarType: 'gregorian', lunarDate: lunar }));
                      }
                    }}
                    className="h-11"
                  />
                  {birthdayData.birthDateLunar && (
                    <p className="text-xs text-muted-foreground mt-1">对应农历：{birthdayData.birthDateLunar}</p>
                  )}
                </div>
                
                <div className="text-center text-sm text-muted-foreground">或</div>
                
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">农历生日</label>
                  <Input
                    value={birthdayData.birthDateLunar || ''}
                    onChange={(e) => {
                      const lunarStr = e.target.value;
                      setBirthdayData({ ...birthdayData, birthDateLunar: lunarStr });
                      if (lunarStr && lunarStr.match(/^\d{4}-\d{1,2}-\d{1,2}$/)) {
                        const [y, m, d] = lunarStr.split('-').map(Number);
                        try {
                          const solar = lunarToSolar({ year: y, month: m, day: d, isLeap: false });
                          const solarStr = solar.toISOString().split('T')[0];
                          setBirthdayData(prev => ({ ...prev, birthDate: solarStr, birthDateLunar: lunarStr }));
                          setFormData(prev => ({ ...prev, date: solarStr, calendarType: 'lunar', lunarDate: { year: y, month: m, day: d, isLeap: false } }));
                        } catch {}
                      }
                    }}
                    placeholder="格式：1990-1-15"
                    className="h-11"
                  />
                  {birthdayData.birthDate && (
                    <p className="text-xs text-muted-foreground mt-1">对应公历：{birthdayData.birthDate}</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">日历类型</label>
                <Select
                  value={formData.calendarType}
                  onChange={(e) => handleCalendarTypeChange(e.target.value as any)}
                  className="h-11"
                >
                  <option value="gregorian">公历</option>
                  <option value="lunar">农历</option>
                </Select>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">日期</label>
                <Input
                  type="date"
                  value={formData.date}
                  onChange={(e) => {
                    const newDate = e.target.value;
                    if (formData.calendarType === 'lunar') {
                      const lunar = solarToLunar(new Date(newDate));
                      setFormData({ ...formData, date: newDate, lunarDate: lunar });
                    } else {
                      setFormData({ ...formData, date: newDate });
                    }
                  }}
                  className="h-11"
                  required
                />
                {formData.calendarType === 'lunar' && formData.lunarDate && (
                  <p className="text-xs text-muted-foreground mt-1.5">
                    农历：{formData.lunarDate.year}年{formData.lunarDate.month}月{formData.lunarDate.day}日
                  </p>
                )}
              </div>
            </>
          )}
          
          {formData.type === 'birthday' && birthdayData.birthDate && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">当前年龄</label>
              <Input
                value={(() => {
                  const birthYear = new Date(birthdayData.birthDate).getFullYear();
                  const currentYear = new Date().getFullYear();
                  return currentYear - birthYear;
                })()}
                disabled
                className="h-11 bg-muted"
              />
              <p className="text-xs text-muted-foreground mt-1">年龄会在每年生日自动增加</p>
            </div>
          )}
          <fieldset className="border border-input rounded-xl p-4">
            <legend className="text-sm font-medium text-foreground px-2">提醒时间</legend>
            <div className="flex gap-2 mb-3">
              <Input
                type="number"
                min="0"
                value={inputDay}
                onChange={(e) => setInputDay(e.target.value)}
                placeholder="输入天数"
                className="h-9 flex-1"
              />
              <Button type="button" size="sm" onClick={() => addReminderDay(Number(inputDay))} disabled={!inputDay}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
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
          </fieldset>
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 h-11">取消</Button>
            <Button type="submit" variant="outline" className="flex-1 h-11">保存</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
