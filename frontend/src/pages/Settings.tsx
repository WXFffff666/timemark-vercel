import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Shield, Bell, HardDrive, Smartphone, ChevronRight, ArrowLeft, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  
  // Modal states
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  
  // Form states
  const [profileForm, setProfileForm] = useState({
    username: user?.username || '',
    email: 'admin@timemark.app',
  });
  
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  
  // Sound setting with localStorage persistence
  const [soundEnabled, setSoundEnabled] = useState(() => {
    return localStorage.getItem('timemark_sound_enabled') !== 'false';
  });

  const handleSoundToggle = (checked: boolean) => {
    setSoundEnabled(checked);
    localStorage.setItem('timemark_sound_enabled', String(checked));
  };

  const handleSaveProfile = async () => {
    try {
      // In a real app, this would call the API
      // await api.put('/user/profile', profileForm);
      alert('个人信息保存成功');
      setShowProfileModal(false);
    } catch (error) {
      console.error('Failed to save profile:', error);
      alert('保存失败');
    }
  };

  const handleChangePassword = async () => {
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      alert('两次输入的密码不一致');
      return;
    }
    
    if (passwordForm.newPassword.length < 8) {
      alert('新密码至少需要8个字符');
      return;
    }

    try {
      await api.post('/auth/change-password', {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      alert('密码修改成功');
      setShowPasswordModal(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (error: any) {
      console.error('Failed to change password:', error);
      alert(error.message || '密码修改失败');
    }
  };

  const handleLogout = async () => {
    if (confirm('确定要退出登录吗？')) {
      await logout();
      navigate('/login');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-3xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex items-center gap-4 ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">系统设置</h1>
          </div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10 mt-2">
        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-8">
          {/* 个人信息 */}
          <motion.section variants={itemVariants}>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">个人信息</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 ring-1 ring-black/5 dark:ring-white/10">
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => setShowProfileModal(true)}
              >
                <div className="flex items-center gap-5">
                  <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-primary-500 to-indigo-600 flex items-center justify-center text-white shadow-inner">
                    <span className="text-2xl font-bold">{user?.username?.charAt(0).toUpperCase() || 'A'}</span>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">{user?.username || 'Admin'}</h3>
                    <p className="text-sm text-slate-500 font-medium">点击修改资料</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </motion.section>

          {/* 外观与通知 */}
          <motion.section variants={itemVariants}>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">外观与通知</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 space-y-1 ring-1 ring-black/5 dark:ring-white/10">
              <div className="flex items-center justify-between p-4 rounded-[2rem]">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 flex items-center justify-center shadow-inner border border-blue-100 dark:border-blue-800/50">
                    <Smartphone size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">深色模式</h3>
                    <p className="text-xs text-slate-500">手动切换系统主题</p>
                  </div>
                </div>
                <ThemeToggle />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div className="flex items-center justify-between p-4 rounded-[2rem]">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 flex items-center justify-center shadow-inner border border-orange-100 dark:border-orange-800/50">
                    <Bell size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">应用内提醒声音</h3>
                    <p className="text-xs text-slate-500">倒计时结束时播放提示音</p>
                  </div>
                </div>
                <Switch checked={soundEnabled} onCheckedChange={handleSoundToggle} />
              </div>
            </div>
          </motion.section>

          {/* 安全与数据 */}
          <motion.section variants={itemVariants}>
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider">安全与数据</h2>
            <div className="glass-panel rounded-[2.5rem] p-2 space-y-1 ring-1 ring-black/5 dark:ring-white/10">
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => setShowPasswordModal(true)}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center shadow-inner border border-emerald-100 dark:border-emerald-800/50">
                    <Shield size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">修改密码</h3>
                    <p className="text-xs text-slate-500">定期更新密码保护账户安全</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
              <div className="h-px bg-slate-200/60 dark:bg-slate-700/50 mx-6"></div>
              <div 
                className="flex items-center justify-between p-4 hover:bg-slate-100/50 dark:hover:bg-white/5 rounded-[2rem] alive-interactive cursor-pointer"
                onClick={() => navigate('/login-history')}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 flex items-center justify-center shadow-inner border border-purple-100 dark:border-purple-800/50">
                    <HardDrive size={22} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">登录日志</h3>
                    <p className="text-xs text-slate-500">查看近期登录历史与设备</p>
                  </div>
                </div>
                <ChevronRight className="text-slate-400" />
              </div>
            </div>
          </motion.section>

          {/* 退出登录 */}
          <motion.div variants={itemVariants} className="pt-4">
            <Button 
              variant="destructive" 
              className="w-full h-14 rounded-2xl text-base font-bold shadow-lg shadow-red-500/20"
              onClick={handleLogout}
            >
              <LogOut size={20} className="mr-2" />
              退出登录
            </Button>
          </motion.div>
        </motion.div>
      </main>

      {/* 编辑资料弹窗 */}
      <Dialog open={showProfileModal} onOpenChange={setShowProfileModal}>
        <DialogContent className="glass-panel rounded-[2.5rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                <User size={20} />
              </div>
              修改个人资料
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-primary-500 to-indigo-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg cursor-pointer alive-interactive hover:opacity-90">
                {user?.username?.charAt(0).toUpperCase() || 'A'}
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">用户名</label>
              <Input 
                value={profileForm.username}
                onChange={(e) => setProfileForm({ ...profileForm, username: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">联系邮箱</label>
              <Input 
                type="email" 
                value={profileForm.email}
                onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                className="h-12"
              />
            </div>
            <div className="pt-4 flex gap-3">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => setShowProfileModal(false)}>取消</Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30" onClick={handleSaveProfile}>保存修改</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 修改密码弹窗 */}
      <Dialog open={showPasswordModal} onOpenChange={setShowPasswordModal}>
        <DialogContent className="glass-panel rounded-[2.5rem]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <div className="p-2 bg-primary-50 dark:bg-primary-900/30 rounded-xl text-primary-600 dark:text-primary-400">
                <Shield size={20} />
              </div>
              修改密码
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">当前密码</label>
              <Input 
                type="password" 
                value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">新密码</label>
              <Input 
                type="password" 
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                className="h-12"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">确认新密码</label>
              <Input 
                type="password" 
                value={passwordForm.confirmPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                className="h-12"
              />
            </div>
            <div className="pt-4 flex gap-3">
              <Button variant="secondary" className="flex-1 h-12 rounded-2xl font-bold" onClick={() => setShowPasswordModal(false)}>取消</Button>
              <Button variant="vision" className="flex-1 h-12 rounded-2xl font-bold shadow-lg shadow-primary-500/30" onClick={handleChangePassword}>更新密码</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}