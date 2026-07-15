import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useNavigate } from 'react-router-dom';
import { Lock, User } from 'lucide-react';
import { LockIcon } from '@/components/icons';
import { api } from '@/lib/api';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void }) => string;
      reset: (id: string) => void;
    };
  }
}

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

function formatLockTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const login = useAuthStore((state) => state.login);
  const navigate = useNavigate();

  const isLocked = lockoutSeconds > 0;

  const startLockoutCountdown = (seconds: number) => {
    if (seconds <= 0) return;
    setLockoutSeconds(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setLockoutSeconds((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    api.get<{ siteKey: string | null; enabled: boolean }>('/auth/turnstile-config')
      .then((cfg) => {
        if (cfg.enabled && cfg.siteKey) setTurnstileSiteKey(cfg.siteKey);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileRef.current) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.onload = () => {
      if (window.turnstile && turnstileRef.current && !widgetIdRef.current) {
        widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
          sitekey: turnstileSiteKey,
          callback: (token: string) => setTurnstileToken(token),
        });
      }
    };
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, [turnstileSiteKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked) return;

    setError('');
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    if (trimmedUsername.length < 3) return setError('用户名至少3个字符');
    if (trimmedPassword.length < 8) return setError('密码至少8个字符');

    setLoading(true);
    try {
      const { mustChangePassword } = await login(trimmedUsername, trimmedPassword, rememberMe, {
        turnstileToken: turnstileToken || undefined,
        totpCode: totpCode || undefined,
      });
      if (mustChangePassword) {
        navigate('/settings?changePassword=1', { replace: true });
      }
    } catch (err: unknown) {
      const e = err as Error & {
        locked?: boolean;
        remainingSeconds?: number;
        requiresTotp?: boolean;
      };
      const message = e.message || '登录失败';

      if (e.locked || message.includes('锁定') || message.includes('频繁')) {
        const sec = e.remainingSeconds
          || parseInt(message.match(/剩余\s*(\d+)\s*秒/)?.[1] || '0', 10)
          || parseInt(message.match(/(\d+)\s*秒/)?.[1] || '0', 10);
        if (sec > 0) startLockoutCountdown(sec);
        setError(message.replace(/^HTTP \d+:\s*/, ''));
      } else if (message.includes('401') || message.includes('Invalid') || message.includes('密码错误')) {
        if (message.includes('双因素') || e.requiresTotp) {
          setShowTotp(true);
          setError('请输入双因素验证码');
        } else {
          setError('用户名或密码错误');
        }
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
              <Input
                type="text"
                placeholder="用户名"
                className="pl-12"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isLocked || loading}
                required
              />
            </div>
          </motion.div>
          <motion.div variants={itemVariants}>
            <div className="relative group">
              <Lock className="absolute left-4 top-3.5 h-5 w-5 text-slate-400 group-focus-within:text-primary-500 transition-colors z-10" />
              <Input
                type="password"
                placeholder="密码"
                className="pl-12"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLocked || loading}
                required
              />
            </div>
          </motion.div>
          {showTotp && (
            <motion.div variants={itemVariants}>
              <Input placeholder="双因素验证码 (6位)" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} disabled={isLocked || loading} />
            </motion.div>
          )}
          {turnstileSiteKey && <div ref={turnstileRef} className="flex justify-center" />}
          <motion.div variants={itemVariants} className="flex items-center gap-3 pt-1 alive-interactive w-max" onClick={() => !isLocked && setRememberMe(!rememberMe)}>
             <input type="checkbox" checked={rememberMe} readOnly disabled={isLocked} className="peer w-5 h-5 rounded-md border-slate-300 dark:border-slate-600 text-primary-500 focus:ring-primary-500/30 bg-white dark:bg-black/50 transition-all disabled:opacity-50" />
             <label className="text-sm font-medium text-slate-700 dark:text-slate-300 select-none cursor-pointer">保持登录（30天）</label>
          </motion.div>
          {isLocked && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50/80 dark:bg-amber-900/30 px-4 py-3 rounded-2xl border border-amber-200 dark:border-amber-800/50">
              账户已锁定，请等待 {formatLockTime(lockoutSeconds)} 后再试。锁定期间无法提交登录。
            </motion.div>
          )}
          {error && !isLocked && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="text-sm text-red-600 dark:text-red-400 bg-red-50/80 dark:bg-red-900/30 px-4 py-3 rounded-2xl border border-red-200 dark:border-red-800/50 backdrop-blur-md">
              {error}
            </motion.div>
          )}
          <motion.div variants={itemVariants} className="pt-4">
            <Button type="submit" variant="vision" size="lg" className="w-full text-base font-semibold shadow-lg shadow-primary-500/20" disabled={loading || isLocked}>
              {loading ? '登录中...' : isLocked ? `锁定中 (${formatLockTime(lockoutSeconds)})` : '登 录'}
            </Button>
          </motion.div>
        </motion.form>
      </CardContent>
    </Card>
  );
}
