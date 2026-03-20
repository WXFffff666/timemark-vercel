import { useAuthStore } from '@/stores/auth.store';
import { LoginForm } from '@/components/auth/LoginForm';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export function LoginPage() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50" />
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10 blur-3xl" />
      <div className="animate-fade-in relative z-10">
        <LoginForm />
      </div>
    </div>
  );
}
