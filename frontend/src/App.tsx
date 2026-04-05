import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
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

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

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
        <div className="relative z-10 min-h-screen">
          <AnimatedRoutes />
        </div>
      </TimezoneProvider>
    </BrowserRouter>
  );
}

export default App;
