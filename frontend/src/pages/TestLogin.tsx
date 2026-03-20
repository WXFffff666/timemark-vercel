import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';

export function TestLoginPage() {
  const navigate = useNavigate();
  const authStore = useAuthStore();

  useEffect(() => {
    // 测试环境自动登录
    authStore.user = { id: 'test', username: 'test', totpSecret: null, createdAt: new Date().toISOString() };
    authStore.isAuthenticated = true;
    localStorage.setItem('accessToken', 'test-token');
    navigate('/dashboard');
  }, []);

  return <div>正在跳转...</div>;
}
