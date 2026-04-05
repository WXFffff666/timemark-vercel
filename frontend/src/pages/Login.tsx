import { useAuthStore } from '@/stores/auth.store';
import { LoginForm } from '@/components/auth/LoginForm';
import { motion } from 'framer-motion';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export function LoginPage() {
  // Note: Redirect logic is now handled in App.tsx's AnimatedRoutes
  // to properly support "return to last path" functionality
  
  // Handle redirect from ProtectedRoute (via `from` state)
  const location = useLocation();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  
  useEffect(() => {
    // After successful login (isAuthenticated becomes true), redirect to original path
    if (!isLoading && isAuthenticated) {
      const from = location.state?.from;
      if (from?.pathname) {
        navigate(from.pathname, { replace: true });
      } else {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [isLoading, isAuthenticated, location.state, navigate]);
  
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -20 }}
        transition={{ type: 'spring', stiffness: 300, damping: 24 }}
        className="w-full max-w-[420px]"
      >
        <LoginForm />
      </motion.div>
    </div>
  );
}
