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
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="animate-fade-in">
        <LoginForm />
      </div>
    </div>
  );
}
