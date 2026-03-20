import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import { useToast } from '../hooks/use-toast';
import { api } from '../lib/api';
import { ArrowLeft } from 'lucide-react';

export default function Reminders() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  
  const [config, setConfig] = useState({
    enabled: true,
    dailyTime: '09:00',
    daysBeforeList: [1, 3, 7, 30],
    emailAddresses: ['1127251096@qq.com', 'wxf200707@gmail.com'],
  });

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await api.get('/settings/reminders');
        if (response.success && response.data) {
          setConfig(response.data);
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    };
    loadSettings();
  }, []);

  const handleSave = async () => {
    setLoading(true);
    try {
      const response = await api.post('/settings/reminders', config);
      console.log('✓ Settings saved:', response);
      toast({ title: '✓ 提醒设置已保存', description: `每日检查时间: ${config.dailyTime}` });
    } catch (error: any) {
      console.error('✗ Save failed:', error);
      toast({ title: '✗ 保存失败', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 p-6">
      <div className="container mx-auto max-w-4xl">
        <div className="flex items-center gap-4 mb-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/dashboard')}
            className="rounded-full"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-3xl font-bold">提醒配置</h1>
        </div>
      
      <Card>
        <CardHeader>
          <CardTitle>自动提醒设置</CardTitle>
          <CardDescription>配置事件提醒的时间和方式</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="enabled">启用自动提醒</Label>
              <p className="text-sm text-muted-foreground">每天定时检查并发送提醒</p>
            </div>
            <Switch
              id="enabled"
              checked={config.enabled}
              onCheckedChange={(checked) => setConfig({ ...config, enabled: checked })}
            />
          </div>
          
          <div>
            <Label htmlFor="dailyTime">每日检查时间</Label>
            <Input
              id="dailyTime"
              type="time"
              value={config.dailyTime}
              onChange={(e) => setConfig({ ...config, dailyTime: e.target.value })}
            />
          </div>
          
          <div>
            <Label>提前提醒天数</Label>
            <p className="text-sm text-muted-foreground mb-2">在事件发生前多少天发送提醒</p>
            <div className="flex gap-2">
              {[1, 3, 7, 14, 30].map((day) => (
                <Button
                  key={day}
                  variant={config.daysBeforeList.includes(day) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    const days = config.daysBeforeList.includes(day)
                      ? config.daysBeforeList.filter(d => d !== day)
                      : [...config.daysBeforeList, day].sort((a, b) => a - b);
                    setConfig({ ...config, daysBeforeList: days });
                  }}
                >
                  {day}天
                </Button>
              ))}
            </div>
          </div>
          
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate('/dashboard')} className="flex-1">
              取消
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={loading} className="flex-1">
              {loading ? '保存中...' : '保存设置'}
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
