import { motion } from 'framer-motion';
import { Bell, CheckCircle2, AlertCircle, Clock, ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

export default function Reminders() {
  const navigate = useNavigate();
  const reminders =[
    { id: 1, title: '周年纪念日', time: '10分钟前', status: 'success', channel: '微信公众号' },
    { id: 2, title: '服务器续费', time: '2小时前', status: 'success', channel: 'Email' },
    { id: 3, title: 'API证书过期', time: '昨天 14:00', status: 'failed', channel: 'Webhook' },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-4 z-50 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-4 flex justify-between items-center ring-1 ring-white/20 dark:ring-white/10">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div><h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">提醒记录</h1></div>
          </div>
          <div className="w-10 h-10 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-500 flex items-center justify-center"><Bell size={20} /></div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8 mt-4">
        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-4">
          {reminders.map((r) => (
            <motion.div key={r.id} variants={itemVariants} className="glass-panel rounded-3xl p-6 flex items-center justify-between hover:shadow-xl transition-all">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-inner ${r.status === 'success' ? 'bg-green-100 dark:bg-green-900/30 text-green-500' : 'bg-red-100 dark:bg-red-900/30 text-red-500'}`}>
                  {r.status === 'success' ? <CheckCircle2 size={24} /> : <AlertCircle size={24} />}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                    {r.title} <Badge variant={r.status === 'success' ? 'success' : 'destructive'} className="scale-90">{r.status === 'success' ? '成功' : '失败'}</Badge>
                  </h3>
                  <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 dark:text-gray-400">
                    <span className="flex items-center gap-1"><Clock size={14} /> {r.time}</span>
                    <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span>
                    <span>渠道: {r.channel}</span>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </main>
    </motion.div>
  );
}
