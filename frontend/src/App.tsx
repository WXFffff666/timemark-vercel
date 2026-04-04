import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthStore } from './stores/auth.store';
import { LoginPage } from './pages/Login';
import { TestLoginPage } from './pages/TestLogin';
import { Dashboard } from './pages/Dashboard';
import Settings from './pages/Settings';
import Reminders from './pages/Reminders';
import LoginHistory from './pages/LoginHistory';
import Channels from './pages/Channels';
import { useEffect } from 'react';
import { TimezoneProvider } from './components/RealtimeClock';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
}

function AnimatedRoutes() {
  const location = useLocation();
  const checkAuth = useAuthStore((state) => state.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <AnimatePresence mode="wait">
      <Routes location={location}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/test" element={<TestLoginPage />} />
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
  }, []);

  return (
    <BrowserRouter>
      <TimezoneProvider>
        <AnimatedRoutes />
      </TimezoneProvider>
    </BrowserRouter>
  );
}

export default App;
