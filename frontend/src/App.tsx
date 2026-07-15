import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from './stores/auth.store';
import { LoginPage } from './pages/Login';
import ShareEvent from './pages/ShareEvent';
import { TimezoneProvider } from './components/RealtimeClock';
import { SkipLink } from './components/SkipLink';

const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Settings = lazy(() => import('./pages/Settings'));
const Reminders = lazy(() => import('./pages/Reminders'));
const LoginHistory = lazy(() => import('./pages/LoginHistory'));
const Channels = lazy(() => import('./pages/Channels'));
const Templates = lazy(() => import('./pages/Templates'));
const TriggerLogs = lazy(() => import('./pages/TriggerLogs'));
const Inbox = lazy(() => import('./pages/Inbox'));
const AnnualReport = lazy(() => import('./pages/AnnualReport'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Security = lazy(() => import('./pages/Security'));
const DeployWizard = lazy(() => import('./pages/DeployWizard'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Broadcast = lazy(() => import('./pages/Broadcast'));
const IntegrationsDocs = lazy(() => import('./pages/IntegrationsDocs'));
const CronMonitor = lazy(() => import('./pages/CronMonitor'));
const CountdownWidget = lazy(() => import('./pages/CountdownWidget'));
const DockerMigration = lazy(() => import('./pages/DockerMigration'));
const LunarHolidays = lazy(() => import('./pages/LunarHolidays'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const NotificationRules = lazy(() => import('./pages/NotificationRules'));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);

  if (isLoading) return <PageLoader />;
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" state={{ from: location }} replace />;
}

function MeshBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden" style={{ backgroundColor: 'var(--mesh-color-3)' }}>
      <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="meshGradient1" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--mesh-color-1)" stopOpacity="var(--mesh-opacity)" />
            <stop offset="100%" stopColor="var(--mesh-color-1)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="meshGradient2" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--mesh-color-2)" stopOpacity="var(--mesh-opacity)" />
            <stop offset="100%" stopColor="var(--mesh-color-2)" stopOpacity="0" />
          </radialGradient>
          <filter id="blurFilter" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={80} />
          </filter>
        </defs>
        <ellipse cx="20%" cy="20%" rx="35vw" ry="35vw" fill="url(#meshGradient1)" filter="url(#blurFilter)" />
        <ellipse cx="80%" cy="80%" rx="40vw" ry="40vw" fill="url(#meshGradient2)" filter="url(#blurFilter)" />
      </svg>
    </div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const navigate = useNavigate();

  useEffect(() => { checkAuth(); }, [checkAuth]);

  useEffect(() => {
    if (isAuthenticated && location.pathname === '/login') {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, location.pathname, navigate]);

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
          <Route path="/reminders" element={<ProtectedRoute><Reminders /></ProtectedRoute>} />
          <Route path="/login-history" element={<ProtectedRoute><LoginHistory /></ProtectedRoute>} />
          <Route path="/security" element={<ProtectedRoute><Security /></ProtectedRoute>} />
          <Route path="/deploy-wizard" element={<ProtectedRoute><DeployWizard /></ProtectedRoute>} />
          <Route path="/channels" element={<ProtectedRoute><Channels /></ProtectedRoute>} />
          <Route path="/templates" element={<ProtectedRoute><Templates /></ProtectedRoute>} />
          <Route path="/trigger-logs" element={<ProtectedRoute><TriggerLogs /></ProtectedRoute>} />
          <Route path="/inbox" element={<ProtectedRoute><Inbox /></ProtectedRoute>} />
          <Route path="/notification-rules" element={<ProtectedRoute><NotificationRules /></ProtectedRoute>} />
          <Route path="/annual-report" element={<ProtectedRoute><AnnualReport /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
          <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
          <Route path="/broadcast" element={<ProtectedRoute><Broadcast /></ProtectedRoute>} />
          <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
          <Route path="/integrations-docs" element={<ProtectedRoute><IntegrationsDocs /></ProtectedRoute>} />
          <Route path="/cron-monitor" element={<ProtectedRoute><CronMonitor /></ProtectedRoute>} />
          <Route path="/docker-migration" element={<ProtectedRoute><DockerMigration /></ProtectedRoute>} />
          <Route path="/lunar-holidays" element={<ProtectedRoute><LunarHolidays /></ProtectedRoute>} />
          <Route path="/embed/:token" element={<CountdownWidget />} />
          <Route path="/share/:token" element={<ShareEvent />} />
          <Route path="/" element={<Navigate to="/dashboard" />} />
      </Routes>
    </Suspense>
  );
}

function App() {
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = saved === 'dark' || (!saved && prefersDark);
    document.documentElement.classList.toggle('dark', dark);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (localStorage.getItem('theme') === 'system' || !localStorage.getItem('theme')) {
        document.documentElement.classList.toggle('dark', mq.matches);
      }
    };
    mq.addEventListener('change', onChange);

    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <BrowserRouter>
      <TimezoneProvider>
        <SkipLink />
        <MeshBackground />
        <div className="relative z-10 min-h-screen text-slate-900 dark:text-slate-100">
          <AnimatedRoutes />
        </div>
      </TimezoneProvider>
    </BrowserRouter>
  );
}

export default App;
