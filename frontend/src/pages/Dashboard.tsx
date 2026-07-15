import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '@/stores/auth.store';
import { useEventStore } from '@/stores/event.store';
import { Button } from '@/components/ui/button';
import { EventCard } from '@/components/events/EventCard';
import { EventForm } from '@/components/events/EventForm';
import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '@/components/ThemeToggle';
import { RealtimeClock } from '@/components/RealtimeClock';
import { TimezoneSelector } from '@/components/TimezoneSelector';
import type { Event, CreateEventRequest } from '@timemark/shared';
import { Settings, Bell, Plus, Download, Calendar, BarChart2, ListChecks, Shield, Upload, Users, Mail, Inbox } from 'lucide-react';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { api } from '@/lib/api';
import { prefetchRoute } from '@/lib/prefetch-routes';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const itemVariants = { hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0, transition: { duration: 0.2 } } };

export function Dashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { events, loading, fetchEvents, createEvent, updateEvent, deleteEvent, deleteEventsBatch, testSendEvent } = useEventStore();
  const [showForm, setShowForm] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | undefined>();
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<{ date: string; count: number; names: string[] }[]>([]);
  const [inboxUnread, setInboxUnread] = useState(0);

  useEffect(() => {
    prefetchRoute('/settings');
    prefetchRoute('/security');
    prefetchRoute('/analytics');
    prefetchRoute('/inbox');
  }, []);

  useEffect(() => {
    api.getRaw<unknown[]>('/inbox?limit=1')
      .then((res) => setInboxUnread((res.pagination?.unreadCount as number) || 0))
      .catch(() => setInboxUnread(0));
  }, []);

  useEffect(() => {
    api.get<{ date: string; count: number; names: string[] }[]>('/features/conflicts')
      .then((data) => setConflicts(Array.isArray(data) ? data : []))
      .catch(() => setConflicts([]));
  }, [events.length]);

  const upcomingWeek = events.filter((e) => {
    const d = new Date(e.date);
    const diff = (d.getTime() - Date.now()) / 86400000;
    return diff >= 0 && diff <= 7;
  }).length;
  const todayCount = events.filter((e) => {
    const d = new Date(e.date);
    const t = new Date();
    return d.toDateString() === t.toDateString();
  }).length;

  const handleImportIcs = async (file: File) => {
    const text = await file.text();
    const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
    const res = await fetch('/api/calendar/import-ics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/calendar' },
      body: text,
    });
    const data = await res.json();
    if (data.success) {
      alert(`已导入 ${data.data.imported} 个事件`);
      fetchEvents();
    } else {
      alert(data.error || '导入失败');
    }
  };


  const handleSubmit = async (data: CreateEventRequest) => {
    if (editingEvent) await updateEvent(editingEvent.id, data);
    else await createEvent(data);
    setEditingEvent(undefined);
  };

  const handleEdit = (event: Event) => { setEditingEvent(event); setShowForm(true); };
  const handleDelete = async (id: string) => { if (confirm('确定删除此事件？')) { await deleteEvent(id); setShowForm(false); setEditingEvent(undefined); } };
  const handleTestSend = async (id: string) => {
    try {
      const result = await testSendEvent(id);
      const results = result?.channelResults || {};
      const failed = Object.entries(results).filter(([, r]) => !r.success);
      if (failed.length > 0) {
        alert(`部分渠道失败：\n${failed.map(([ch, r]) => `${ch}: ${r.error || '未知错误'}`).join('\n')}`);
      } else {
        alert('测试通知已发送！可在「提醒日志」查看记录。');
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '发送失败，请检查通知渠道与设置中的默认邮箱');
    }
  };
  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) return;
    try {
      if (confirm(`确定批量删除 ${selectedIds.length} 个事件？`)) {
        const deletedCount = await deleteEventsBatch(selectedIds);
        alert(`成功删除 ${deletedCount} 个事件`);
        setSelectedIds([]);
        setBatchMode(false);
      }
    } catch (error) {
      console.error('Batch delete error:', error);
      alert('批量删除失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  const handleExportCalendar = async (format: 'ics' | 'google' | 'apple') => {
    try {
      if (format === 'ics') {
        // Download ICS file
        const response = await fetch('/api/calendar/export.ics', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')}` }
        });
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'timemark-events.ics';
        a.click();
        window.URL.revokeObjectURL(url);
      } else if (format === 'google') {
        // Open Google Calendar links
        const response = await fetch('/api/calendar/google', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')}` }
        });
        const data = await response.json();
        if (data.success && data.data?.length > 0) {
          window.open(data.data[0].link, '_blank');
        } else {
          alert('没有可导出的事件');
        }
      } else if (format === 'apple') {
        // Subscribe to Apple Calendar
        const response = await fetch('/api/calendar/apple', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')}` }
        });
        const data = await response.json();
        if (data.success) {
          window.open(data.data.subscribeUrl, '_blank');
        }
      }
    } catch (error) {
      console.error('Export error:', error);
      alert('导出失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-4 z-50 px-4 max-w-7xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3 flex justify-between items-center ring-1 ring-white/20 dark:ring-white/10">
          <div className="flex items-center gap-4 alive-interactive" onClick={() => navigate('/dashboard')}>
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-primary-500 to-purple-500 flex items-center justify-center shadow-lg">
              <span className="text-white font-bold text-xl">T</span>
            </div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 hidden md:block tracking-tight">TimeMark</h1>
          </div>
          <div className="flex items-center gap-2 md:gap-4">
            <div className="hidden md:flex items-center gap-3 bg-white/30 dark:bg-black/30 backdrop-blur-md rounded-full px-4 py-1.5 shadow-inner">
              <RealtimeClock />
              <div className="w-px h-4 bg-slate-300 dark:bg-slate-600"></div>
              <TimezoneSelector />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="rounded-full relative" onClick={() => navigate('/inbox')} title="收件箱">
                <Inbox size={20} className="text-slate-600 dark:text-slate-300" />
                {inboxUnread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {inboxUnread > 99 ? '99+' : inboxUnread}
                  </span>
                )}
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/trigger-logs')} title="触发日志">
                <ListChecks size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/analytics')} title="数据看板">
                <BarChart2 size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/annual-report')} title="年度报告">
                <Calendar size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/channels')} title="通知渠道">
                <Bell size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/security')} title="安全中心">
                <Shield size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full" title="导出 ICS" onClick={() => handleExportCalendar('ics')}>
                <Download size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <label className="cursor-pointer inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800" title="导入 ICS">
                <input type="file" accept=".ics,text/calendar" className="hidden" onChange={(e) => e.target.files?.[0] && handleImportIcs(e.target.files[0])} />
                <Upload size={20} className="text-slate-600 dark:text-slate-300" />
              </label>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/settings')}>
                <Settings size={20} className="text-slate-600 dark:text-slate-300" />
              </Button>
              <ThemeToggle />
            </div>
            <div className="h-8 w-px bg-slate-300 dark:bg-slate-700 hidden sm:block"></div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300 hidden sm:block">{user?.username}</span>
              <Button variant="outline" size="sm" className="rounded-full border-slate-300/50 dark:border-slate-600/50" onClick={logout}>退出</Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 mt-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <div className="glass-panel rounded-2xl p-4"><p className="text-xs text-slate-500">今日事件</p><p className="text-2xl font-bold">{todayCount}</p></div>
          <div className="glass-panel rounded-2xl p-4"><p className="text-xs text-slate-500">本周待办</p><p className="text-2xl font-bold">{upcomingWeek}</p></div>
          <div className="glass-panel rounded-2xl p-4"><p className="text-xs text-slate-500">总事件</p><p className="text-2xl font-bold">{events.length}</p></div>
          <div className="glass-panel rounded-2xl p-4 cursor-pointer hover:ring-2 hover:ring-emerald-400/50 transition" onClick={() => navigate('/contacts')}>
            <p className="text-xs text-slate-500 flex items-center gap-1"><Users size={12} />固定联系人</p>
            <p className="text-sm font-medium text-emerald-600">管理 →</p>
          </div>
          <div className="glass-panel rounded-2xl p-4 cursor-pointer hover:ring-2 hover:ring-blue-400/50 transition" onClick={() => navigate('/broadcast')}>
            <p className="text-xs text-slate-500 flex items-center gap-1"><Mail size={12} />批量邮件</p>
            <p className="text-sm font-medium text-blue-600">群发 →</p>
          </div>
          <div className="glass-panel rounded-2xl p-4 cursor-pointer hover:ring-2 hover:ring-indigo-400/50 transition" onClick={() => navigate('/calendar')}>
            <p className="text-xs text-slate-500 flex items-center gap-1"><Calendar size={12} />日历视图</p>
            <p className="text-sm font-medium text-indigo-600">查看 →</p>
          </div>
        </div>
        {conflicts.length > 0 && (
          <div className="mb-6 glass-panel rounded-2xl p-4 border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10">
            <p className="text-sm font-bold text-amber-800 dark:text-amber-200 mb-2">⚠️ 日期冲突检测（{conflicts.length} 组）</p>
            <div className="space-y-1">
              {conflicts.slice(0, 3).map((c) => (
                <p key={c.date} className="text-xs text-amber-700 dark:text-amber-300">
                  {c.date}：{c.names?.join('、') || `${c.count} 个事件`}
                </p>
              ))}
              {conflicts.length > 3 && <p className="text-xs text-amber-600">还有 {conflicts.length - 3} 组冲突…</p>}
            </div>
          </div>
        )}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
          <div>
            <h2 className="text-3xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">我的倒计时</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 font-medium">共有 {events.length} 个正在追踪的事件</p>
          </div>
          <div className="flex items-center gap-3 glass px-2 py-2 rounded-2xl ring-1 ring-white/20">
            <Button variant={batchMode ? "secondary" : "ghost"} className="rounded-xl transition-all" onClick={() => { setBatchMode(!batchMode); setSelectedIds([]); }}>
              {batchMode ? '取消批量操作' : '批量管理'}
            </Button>
            <AnimatePresence>
              {batchMode && (
                <motion.div initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 'auto' }} exit={{ opacity: 0, width: 0 }} className="overflow-hidden">
                  <Button variant="destructive" className="rounded-xl whitespace-nowrap" onClick={handleBatchDelete} disabled={selectedIds.length === 0}>
                    删除已选 ({selectedIds.length})
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="glass rounded-3xl p-6 animate-pulse h-48">
                <div className="h-5 bg-slate-300/50 dark:bg-slate-700/50 rounded-full w-2/3 mb-6"></div>
                <div className="h-12 bg-slate-300/50 dark:bg-slate-700/50 rounded-2xl w-full mb-4"></div>
                <div className="h-4 bg-slate-300/50 dark:bg-slate-700/50 rounded-full w-1/3"></div>
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-24 glass-panel rounded-3xl ring-1 ring-white/20">
            <div className="w-20 h-20 bg-primary-100 dark:bg-primary-900/40 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
              <Plus size={40} className="text-primary-500" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-2">暂无倒计时事件</h3>
            <p className="text-slate-500 dark:text-slate-400 mb-6">点击右下角的按钮创建一个新的重要时刻</p>
            <Button variant="vision" onClick={() => { setEditingEvent(undefined); setShowForm(true); }}>立即创建</Button>
          </div>
        ) : (
          <motion.div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" variants={containerVariants} initial="hidden" animate="visible">
            {events.map((event) => (
              <motion.div key={event.id} variants={itemVariants}>
                <EventCard event={event} onEdit={handleEdit} onDelete={handleDelete} onTestSend={handleTestSend} selectable={batchMode} selected={selectedIds.includes(event.id)} onSelectToggle={(id, checked) => { setSelectedIds((prev) => checked ? [...prev, id] : prev.filter((item) => item !== id)); }} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>

      <motion.div className="fixed bottom-10 right-10 z-40" whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.95 }}>
        <Button 
          variant="vision" 
          className="h-16 w-16 rounded-[1.5rem] shadow-2xl shadow-primary-600/50 flex items-center justify-center p-0 bg-gradient-to-br from-primary-600 to-primary-700 hover:from-primary-500 hover:to-primary-600" 
          onClick={() => { setEditingEvent(undefined); setShowForm(true); }}
        >
          <Plus size={28} className="text-white" />
        </Button>
      </motion.div>
      
      <EventForm open={showForm} onClose={() => { setShowForm(false); setEditingEvent(undefined); }} onSubmit={handleSubmit} event={editingEvent} />
      <MobileBottomNav />
    </motion.div>
  );
}
