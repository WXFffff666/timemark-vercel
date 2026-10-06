import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthStore } from './stores/auth.store';
import { initAuthLifecycle } from './stores/auth.store';
import { LoginPage } from './pages/Login';
import ShareEvent from './pages/ShareEvent';
import { TimezoneProvider } from './components/RealtimeClock';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { SkipLink } from './components/SkipLink';
import { AssistantDock } from './components/assistant/AssistantDock';
import { CommandPalette } from './components/CommandPalette';

const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Settings = lazy(() => import('./pages/Settings'));
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
const ApiPortal = lazy(() => import('./pages/ApiPortal'));
const CountdownWidget = lazy(() => import('./pages/CountdownWidget'));
const DockerMigration = lazy(() => import('./pages/DockerMigration'));
const LunarHolidays = lazy(() => import('./pages/LunarHolidays'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const TodosPage = lazy(() => import('./pages/Todos'));
const NotificationRules = lazy(() => import('./pages/NotificationRules'));
const ExpiryPage = lazy(() => import('./pages/Expiry'));
const InventoryPage = lazy(() => import('./pages/Inventory'));
const MaintenancePage = lazy(() => import('./pages/Maintenance'));
const DocumentsPage = lazy(() => import('./pages/Documents'));
const HabitsPage = lazy(() => import('./pages/Habits'));
const MedicationsPage = lazy(() => import('./pages/Medications'));
const GoalsPage = lazy(() => import('./pages/Goals'));
const AgentConsole = lazy(() => import('./pages/AgentConsole'));
const AskPage = lazy(() => import('./pages/Ask'));
const TodayPage = lazy(() => import('./pages/Today'));
const DataHealthPage = lazy(() => import('./pages/DataHealth'));
const SharedView = lazy(() => import('./pages/SharedView'));
const LocalAIPage = lazy(() => import('./pages/LocalAI'));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center" role="status" aria-label="页面加载中">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
}

function ProtectedRoute({ children, pageName }: { children: React.ReactNode; pageName?: string }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);

  if (isLoading) return <PageLoader />;
  // v2.30：页面级错误边界——单页渲染崩溃不再白屏整站
  return isAuthenticated
    ? <PageErrorBoundary pageName={pageName}>{children}</PageErrorBoundary>
    : <Navigate to="/login" state={{ from: location }} replace />;
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

/** 这些路径不做过渡：登录直进；外嵌/分享页动效无意义且可能被 iframe 限制 */
const NO_TRANSITION_ROUTES = new Set(['/login']);

/**
 * 路由表。location 必须显式传入：AnimatePresence 退场期间旧子树仍在渲染，
 * <Routes> 若读 context location 会直接跳变到新路由的内容。
 */
function AppRoutes({ location }: { location: ReturnType<typeof useLocation> }) {
  return (
    <Routes location={location}>
      <Route path="/login" element={<LoginPage />} />
    <Route path="/dashboard" element={<ProtectedRoute pageName="Dashboard"><Dashboard /></ProtectedRoute>} />
    <Route path="/settings" element={<ProtectedRoute pageName="Settings"><Settings /></ProtectedRoute>} />
    {/* v2.26 C：提醒记录并入 /trigger-logs（?tab=reminders），旧链接 301 兜底 */}
    <Route path="/reminders" element={<Navigate to="/trigger-logs?tab=reminders" replace />} />
    <Route path="/login-history" element={<ProtectedRoute pageName="LoginHistory"><LoginHistory /></ProtectedRoute>} />
    <Route path="/security" element={<ProtectedRoute pageName="Security"><Security /></ProtectedRoute>} />
    <Route path="/deploy-wizard" element={<ProtectedRoute pageName="DeployWizard"><DeployWizard /></ProtectedRoute>} />
    <Route path="/channels" element={<ProtectedRoute pageName="Channels"><Channels /></ProtectedRoute>} />
    <Route path="/templates" element={<ProtectedRoute pageName="Templates"><Templates /></ProtectedRoute>} />
    <Route path="/trigger-logs" element={<ProtectedRoute pageName="TriggerLogs"><TriggerLogs /></ProtectedRoute>} />
    <Route path="/inbox" element={<ProtectedRoute pageName="Inbox"><Inbox /></ProtectedRoute>} />
    <Route path="/notification-rules" element={<ProtectedRoute pageName="NotificationRules"><NotificationRules /></ProtectedRoute>} />
    <Route path="/annual-report" element={<ProtectedRoute pageName="AnnualReport"><AnnualReport /></ProtectedRoute>} />
    <Route path="/analytics" element={<ProtectedRoute pageName="Analytics"><Analytics /></ProtectedRoute>} />
    <Route path="/contacts" element={<ProtectedRoute pageName="Contacts"><Contacts /></ProtectedRoute>} />
    <Route path="/broadcast" element={<ProtectedRoute pageName="Broadcast"><Broadcast /></ProtectedRoute>} />
    <Route path="/calendar" element={<ProtectedRoute pageName="CalendarPage"><CalendarPage /></ProtectedRoute>} />
    <Route path="/todos" element={<ProtectedRoute pageName="TodosPage"><TodosPage /></ProtectedRoute>} />
    <Route path="/expiry" element={<ProtectedRoute pageName="ExpiryPage"><ExpiryPage /></ProtectedRoute>} />
    <Route path="/inventory" element={<ProtectedRoute pageName="InventoryPage"><InventoryPage /></ProtectedRoute>} />
    <Route path="/maintenance" element={<ProtectedRoute pageName="MaintenancePage"><MaintenancePage /></ProtectedRoute>} />
    <Route path="/documents" element={<ProtectedRoute pageName="DocumentsPage"><DocumentsPage /></ProtectedRoute>} />
    <Route path="/habits" element={<ProtectedRoute pageName="HabitsPage"><HabitsPage /></ProtectedRoute>} />
    <Route path="/medications" element={<ProtectedRoute pageName="MedicationsPage"><MedicationsPage /></ProtectedRoute>} />
    <Route path="/goals" element={<ProtectedRoute pageName="GoalsPage"><GoalsPage /></ProtectedRoute>} />
    {/* v2.26 C：/assistant 页删除 —— AssistantDock 已全局承载同一面板 */}
    <Route path="/agent-console" element={<ProtectedRoute pageName="AgentConsole"><AgentConsole /></ProtectedRoute>} />
    <Route path="/ask" element={<ProtectedRoute pageName="AskPage"><AskPage /></ProtectedRoute>} />
    <Route path="/today" element={<ProtectedRoute pageName="TodayPage"><TodayPage /></ProtectedRoute>} />
    <Route path="/data-health" element={<ProtectedRoute pageName="DataHealthPage"><DataHealthPage /></ProtectedRoute>} />
    <Route path="/local-ai" element={<ProtectedRoute pageName="LocalAIPage"><LocalAIPage /></ProtectedRoute>} />
    <Route path="/shared/:token" element={<SharedView />} />
    <Route path="/integrations-docs" element={<ProtectedRoute pageName="IntegrationsDocs"><IntegrationsDocs /></ProtectedRoute>} />
    <Route path="/cron-monitor" element={<ProtectedRoute pageName="CronMonitor"><CronMonitor /></ProtectedRoute>} />
    <Route path="/api-portal" element={<ProtectedRoute pageName="ApiPortal"><ApiPortal /></ProtectedRoute>} />
    <Route path="/docker-migration" element={<ProtectedRoute pageName="DockerMigration"><DockerMigration /></ProtectedRoute>} />
    <Route path="/lunar-holidays" element={<ProtectedRoute pageName="LunarHolidays"><LunarHolidays /></ProtectedRoute>} />
    <Route path="/embed/:token" element={<CountdownWidget />} />
    <Route path="/share/:token" element={<ShareEvent />} />
    <Route path="/" element={<Navigate to="/dashboard" />} />
    </Routes>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const navigate = useNavigate();

  useEffect(() => { checkAuth(); initAuthLifecycle(); }, [checkAuth]);

  useEffect(() => {
    if (isAuthenticated && location.pathname === '/login') {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, location.pathname, navigate]);

  return (
    <Suspense fallback={<PageLoader />}>
      {/*
        v2.26 D：全站页面过渡。
        包一层 keyed motion.div + AnimatePresence(mode='wait') —— 旧代码里各页
        根元素的 exit= 永远不会执行（Routes 没有 AnimatePresence 包裹），这里在
        路由层统一做进入/退出过渡，28+ 页一次覆盖；页面内的 stagger 动画照常叠加。
        跳过理由：/login 无动画直进；/embed /share 是外嵌 iframe 场景，动效无意义。
      */}
      <AnimatePresence mode="wait" initial={false}>
        {NO_TRANSITION_ROUTES.has(location.pathname) ? (
          <div key={location.pathname}>
            <AppRoutes location={location} />
          </div>
        ) : (
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <AppRoutes location={location} />
          </motion.div>
        )}
      </AnimatePresence>
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

    // Registered in every mode: the worker is intentionally cache-free (todo 37),
    // so it cannot serve stale HTML; the e2e suite asserts registration under the
    // dev server as well. Todo 84 re-adds the Web Push handlers.
    if ('serviceWorker' in navigator) {
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
          <AssistantDock />
          <CommandPalette />
        </div>
      </TimezoneProvider>
    </BrowserRouter>
  );
}

export default App;
