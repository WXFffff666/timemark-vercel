import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@/lib/api';

export default function CountdownWidget() {
  const { token } = useParams();
  const [event, setEvent] = useState<{ name: string; date: string; type: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/features/share/${token}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setEvent(d.data); })
      .catch(() => setEvent(null));
  }, [token]);

  if (!event) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">加载中…</div>;
  }

  const days = Math.ceil((new Date(event.date).getTime() - Date.now()) / 86400000);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-700 text-white p-6">
      <div className="text-center">
        <div className="text-6xl font-bold mb-2">{days <= 0 ? '今天' : days}</div>
        <div className="text-xl opacity-90">{days <= 0 ? '' : '天后'}</div>
        <h1 className="text-2xl font-semibold mt-6">{event.name}</h1>
        <p className="opacity-80 mt-2">{event.date}</p>
      </div>
    </div>
  );
}
