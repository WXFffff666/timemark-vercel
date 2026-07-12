import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useNavigate } from 'react-router-dom';
import { Lock, User } from 'lucide-react';
import { LockIcon } from '@/components/icons';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

export function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const[error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const[lockoutSeconds, setLockoutSeconds] = useState(0);
  const login = useAuthStore((state) => state.login);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    if (trimmedUsername.length < 3) return setError('用户名至少3个字符');
    if (trimmedPassword.length < 6) return setError('密码至少6个字符');
    
    setLoading(true);
    try {
      const { mustChangePassword } = await login(trimmedUsername, trimmedPassword, rememberMe);
      if (mustChangePassword) {
        navigate('/settings?changePassword=1', { replace: true });
      }
    } catch (err: any) {
      const message = err.message || '登录失败';
      if (message.includes('429') || message.includes('锁定')) {
        const match = message.match(/(\d+)\s*秒/);
        if (match) {
          setLockoutSeconds(parseInt(match[1]));
          const timer = setInterval(() => {
            setLockoutSeconds(prev => { if (prev <= 1) { clearInterval(timer); return 0; } return prev - 1; });
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

  return (
    <Card className="w-full glass-panel border-0 ring-1 ring-black/5 dark:ring-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl">
      <CardHeader className="text-center pb-4 pt-12">
        <motion.div
          initial={{ scale: 0, rotate: -10 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="mx-auto w-20 h-20 flex items-center justify-center mb-6 relative"
        >
          <div className="absolute inset-0 bg-primary-500/20 dark:bg-primary-500/40 blur-2xl rounded-full"></div>
          <LockIcon className="h-16 w-16 text-primary-600 dark:text-primary-400 drop-shadow-lg relative z-10" />
        </motion.div>
        <CardTitle className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          TimeMark
        </CardTitle>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">掌控您的每一个倒数时刻</p>
      </CardHeader>
      <CardContent className="px-10 pb-12">
        <motion.form onSubmit={handleSubmit} className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
          <motion.div variants={itemVariants}>
            <div className="relative group">
              <User className="absolute left-4 top-3.5 h-5 w-5 text-slate-400 group-focus-within:text-primary-500 transition-colors z-10" />
              <Input type="text" placeholder="用户名" className="pl-12" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
          </motion.div>
          <motion.div variants={itemVariants}>
            <div className="relative group">
              <Lock className="absolute left-4 top-3.5 h-5 w-5 text-slate-400 group-focus-within:text-primary-500 transition-colors z-10" />
              <Input type="password" placeholder="密码" className="pl-12" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </motion.div>
          <motion.div variants={itemVariants} className="flex items-center gap-3 pt-1 alive-interactive w-max" onClick={() => setRememberMe(!rememberMe)}>
             <input type="checkbox" checked={rememberMe} readOnly className="peer w-5 h-5 rounded-md border-slate-300 dark:border-slate-600 text-primary-500 focus:ring-primary-500/30 bg-white dark:bg-black/50 transition-all" />
             <label className="text-sm font-medium text-slate-700 dark:text-slate-300 select-none cursor-pointer">保持登录（30天）</label>
          </motion.div>
          {error && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="text-sm text-red-600 dark:text-red-400 bg-red-50/80 dark:bg-red-900/30 px-4 py-3 rounded-2xl border border-red-200 dark:border-red-800/50 backdrop-blur-md">
              {error}
            </motion.div>
          )}
          <motion.div variants={itemVariants} className="pt-4">
            <Button type="submit" variant="vision" size="lg" className="w-full text-base font-semibold shadow-lg shadow-primary-500/20" disabled={loading || lockoutSeconds > 0}>
              {loading ? '登录中...' : lockoutSeconds > 0 ? `锁定 (${lockoutSeconds}s)` : '登 录'}
            </Button>
          </motion.div>
        </motion.form>
      </CardContent>
    </Card>
  );
}