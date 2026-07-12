import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ShareData {
  name: string;
  type: string;
  date: string;
  calendar_type: string;
  person_name?: string;
}

export default function ShareEvent() {
  const { token } = useParams();
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    fetch(`/api/features/share/${token}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
        else setError(json.error || '无法加载');
      })
      .catch(() => setError('加载失败'));
  }, [token]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center">加载中...</div>;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>事件分享</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p><strong>名称：</strong>{data.name}</p>
          <p><strong>类型：</strong>{data.type}</p>
          <p><strong>日期：</strong>{data.date}</p>
          {data.person_name && <p><strong>相关人：</strong>{data.person_name}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
