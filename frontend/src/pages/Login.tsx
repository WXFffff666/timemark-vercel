import { LoginForm } from '@/components/auth/LoginForm';
import { motion } from 'framer-motion';

export function LoginPage() {
  // 登录后的重定向逻辑现在由 App.tsx 统一处理
  // 这里不需要额外的 useEffect
  
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -20 }}
        transition={{ type: 'spring', stiffness: 300, damping: 24 }}
        className="w-full max-w-[440px]"
      >
        <LoginForm />
      </motion.div>
    </div>
  );
}
