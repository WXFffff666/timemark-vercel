import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock, User } from 'lucide-react';
import { LockIcon } from '@/components/icons/LockIcon';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 }
};

export function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const login = useAuthStore((state) => state.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    
    if (trimmedUsername.length < 3) {
      setError('用户名至少3个字符');
      return;
    }
    
    if (trimmedPassword.length < 6) {
      setError('密码至少6个字符');
      return;
    }
    
    setLoading(true);

    try {
      await login(trimmedUsername, trimmedPassword, rememberMe);
    } catch (err: any) {
      const message = err.message || '登录失败';
      if (message.includes('429') || message.includes('Too many') || message.includes('锁定')) {
        const match = message.match(/(\d+)\s*秒/);
        if (match) {
          const seconds = parseInt(match[1]);
          setLockoutSeconds(seconds);
          const timer = setInterval(() => {
            setLockoutSeconds(prev => {
              if (prev <= 1) {
                clearInterval(timer);
                return 0;
              }
              return prev - 1;
            });
          }, 1000);
        }
        setError(message);
      } else if (message.includes('401') || message.includes('Invalid')) {
        setError('用户名或密码错误');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDevSkipLogin = () => {
    // Dev-only: skip authentication
    window.location.href = '/dashboard';
  };

  return (
    <Card className="w-full max-w-md glass rounded-2xl">
      <CardHeader className="text-center pb-6 pt-10">
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="mx-auto w-20 h-20 flex items-center justify-center mb-6"
        >
          <LockIcon className="h-20 w-20" />
        </motion.div>
        <CardTitle className="text-3xl font-bold text-gray-900 dark:text-white">倒计时提醒系统</CardTitle>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">请登录您的账户</p>
      </CardHeader>
      <CardContent className="px-8 pb-10">
        <motion.form
          onSubmit={handleSubmit}
          className="space-y-5"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={itemVariants}>
            <div className="relative">
              <User className="absolute left-4 top-3.5 h-5 w-5 text-gray-400 dark:text-gray-500" />
              <Input
                type="text"
                placeholder="用户名"
                className="pl-12 h-12 bg-white/50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 rounded-xl focus:bg-white dark:focus:bg-gray-700 transition-colors text-gray-900 dark:text-white"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          </motion.div>
          <motion.div variants={itemVariants}>
            <div className="relative">
              <Lock className="absolute left-4 top-3.5 h-5 w-5 text-gray-400 dark:text-gray-500" />
              <Input
                type="password"
                placeholder="密码"
                className="pl-12 h-12 bg-white/50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 rounded-xl focus:bg-white dark:focus:bg-gray-700 transition-colors text-gray-900 dark:text-white"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
           </motion.div>
           <motion.div variants={itemVariants} className="flex items-center gap-2 pt-1">
             <input
               type="checkbox"
               id="rememberMe"
               checked={rememberMe}
               onChange={(e) => setRememberMe(e.target.checked)}
               className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-primary-500 focus:ring-primary-500 cursor-pointer"
             />
             <label htmlFor="rememberMe" className="text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
               保持登录（30天）
             </label>
           </motion.div>
           {error && (
            <motion.p
              variants={itemVariants}
              className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-4 py-3 rounded-xl border border-red-100 dark:border-red-800"
            >
              {error}
            </motion.p>
          )}
           <motion.div variants={itemVariants} className="pt-2">
             <Button type="submit" variant="gradient" className="w-full h-12 rounded-xl font-medium" disabled={loading}>
               {loading ? '登录中...' : '登录'}
             </Button>
           </motion.div>
          {import.meta.env.MODE === 'development' && (
            <motion.div variants={itemVariants}>
              <Button 
                type="button" 
                variant="ghost" 
                className="w-full h-10 text-xs text-gray-400 hover:text-gray-600" 
                onClick={handleDevSkipLogin}
              >
                [DEV] 跳过登录
              </Button>
            </motion.div>
          )}
        </motion.form>
      </CardContent>
    </Card>
  );
}
