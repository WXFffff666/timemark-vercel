import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useAuthStore } from './stores/auth.store';
import { LoginPage } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import Settings from './pages/Settings';
import Reminders from './pages/Reminders';
import LoginHistory from './pages/LoginHistory';
import Channels from './pages/Channels';
import { useEffect } from 'react';
import { TimezoneProvider } from './components/RealtimeClock';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  
  // During auth check, don't redirect - wait for check to complete
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }
  
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" state={{ from: location }} replace />;
}

function MeshBackground() {
  return (
    <div className="mesh-bg-container pointer-events-none">
      <div className="mesh-blob-1 animate-blob-spin"></div>
      <div className="mesh-blob-2 animate-blob-spin-slow"></div>
    </div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const navigate = useNavigate();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Simple redirect to dashboard when logged in and on login page
  useEffect(() => {
    if (isAuthenticated && location.pathname === '/login') {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, location.pathname, navigate]);

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="/reminders" element={<ProtectedRoute><Reminders /></ProtectedRoute>} />
        <Route path="/login-history" element={<ProtectedRoute><LoginHistory /></ProtectedRoute>} />
        <Route path="/channels" element={<ProtectedRoute><Channels /></ProtectedRoute>} />
        <Route path="/" element={<Navigate to="/dashboard" />} />
      </Routes>
    </AnimatePresence>
  );
}

function App() {
  useEffect(() => {
    const theme = localStorage.getItem('theme');
    if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  },[]);

  return (
    <BrowserRouter>
      <TimezoneProvider>
        <MeshBackground />
        <div className="relative z-10 min-h-screen text-slate-900 dark:text-slate-100">
          <AnimatedRoutes />
        </div>
      </TimezoneProvider>
    </BrowserRouter>
  );
}

export default App;