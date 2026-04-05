import { motion } from 'framer-motion';
import { User, Shield, Bell, HardDrive, Smartphone, ChevronRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useNavigate } from 'react-router-dom';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

export default function Settings() {
  const navigate = useNavigate();
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-4 z-50 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-4 flex items-center gap-4 ring-1 ring-white/20 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">系统设置</h1>
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8 mt-4">
        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-8">
          <motion.section variants={itemVariants}>
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4 px-2">个人信息</h2>
            <div className="glass-panel rounded-3xl p-2">
              <div className="flex items-center justify-between p-4 hover:bg-white/50 dark:hover:bg-white/5 rounded-2xl alive-interactive">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-primary-400 to-purple-500 flex items-center justify-center text-white shadow-inner"><User size={28} /></div>
                  <div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Admin</h3><p className="text-sm text-slate-500">admin@timemark.app</p></div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </motion.section>
          <motion.section variants={itemVariants}>
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4 px-2">外观与通知</h2>
            <div className="glass-panel rounded-3xl p-2 space-y-1">
              <div className="flex items-center justify-between p-4 rounded-2xl">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/30 text-blue-600 flex items-center justify-center"><Smartphone size={20} /></div>
                  <div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">深色模式</h3><p className="text-sm text-slate-500">手动切换系统主题</p></div>
                </div>
                <ThemeToggle />
              </div>
              <div className="h-px bg-slate-200/50 dark:bg-slate-700/50 mx-4"></div>
              <div className="flex items-center justify-between p-4 rounded-2xl">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-orange-100 dark:bg-orange-900/30 text-orange-600 flex items-center justify-center"><Bell size={20} /></div>
                  <div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">应用内提醒声音</h3><p className="text-sm text-slate-500">倒计时结束时播放提示音</p></div>
                </div>
                <Switch defaultChecked />
              </div>
            </div>
          </motion.section>
          <motion.section variants={itemVariants}>
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-4 px-2">安全与数据</h2>
            <div className="glass-panel rounded-3xl p-2 space-y-1">
              <div className="flex items-center justify-between p-4 hover:bg-white/50 dark:hover:bg-white/5 rounded-2xl alive-interactive">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-green-100 dark:bg-green-900/30 text-green-600 flex items-center justify-center"><Shield size={20} /></div>
                  <div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">修改密码</h3><p className="text-sm text-slate-500">定期更新密码保护账户安全</p></div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="h-px bg-slate-200/50 dark:bg-slate-700/50 mx-4"></div>
              <div className="flex items-center justify-between p-4 hover:bg-white/50 dark:hover:bg-white/5 rounded-2xl alive-interactive" onClick={() => navigate('/login-history')}>
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 flex items-center justify-center"><HardDrive size={20} /></div>
                  <div><h3 className="text-base font-bold text-slate-900 dark:text-slate-100">登录日志</h3><p className="text-sm text-slate-500">查看近期登录历史与安全</p></div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </motion.section>
          <motion.div variants={itemVariants} className="pt-6">
            <Button variant="destructive" className="w-full h-14 rounded-2xl text-base font-bold shadow-lg shadow-red-500/20">
              退出登录
            </Button>
          </motion.div>
        </motion.div>
      </main>
    </motion.div>
  );
}
