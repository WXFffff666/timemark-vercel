import { motion } from 'framer-motion';
import { ArrowLeft, CheckCircle2, HeartPulse, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useSmartBack } from '@/hooks/useSmartBack';
import { FindingCard } from '@/components/data-health/FindingCard';
import { useDataHealth } from '@/components/data-health/useDataHealth';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const itemVariants = { hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0, transition: { duration: 0.2 } } };

/** Task 137: data-health panel with one-click, auditable repairs. */
export default function DataHealth() {
  const goBack = useSmartBack('/dashboard');
  const { report, loading, error, repairing, notice, reload, repair } = useDataHealth();

  const findings = report?.findings ?? [];
  const sorted = [...findings].sort((a, b) => b.count - a.count);
  const dirty = (report?.totalFindings ?? 0) > 0;

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-4 z-40 mx-auto max-w-4xl px-4" role="banner" aria-label="数据健康顶部导航">
        <div className="glass-panel flex items-center gap-3 rounded-full px-4 py-3 ring-1 ring-black/5 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="min-h-11 min-w-11 rounded-full" onClick={goBack} aria-label="返回上一页">
            <ArrowLeft size={20} aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">数据健康</h1>
            <p className="truncate text-xs text-hint">检测孤立 / 缺失 / 重复数据，一键修复</p>
          </div>
          <Button variant="ghost" size="icon" className="min-h-11 min-w-11 rounded-full" onClick={() => void reload()} disabled={loading} aria-label="刷新">
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} aria-hidden />
          </Button>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-4xl px-4 py-8" tabIndex={-1}>
        <Card className="mb-6 rounded-3xl p-6">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-600 dark:bg-primary-900/40 dark:text-primary-400" aria-hidden>
              <HeartPulse size={24} />
            </span>
            <div>
              <p className="text-sm text-hint">共发现</p>
              <p className="text-2xl font-extrabold text-slate-900 dark:text-white">
                {report?.totalIssues ?? 0} <span className="text-base font-medium text-hint">处问题 · {report?.totalFindings ?? 0} 类</span>
              </p>
            </div>
          </div>
        </Card>

        {error && (
          <p className="mb-4 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-4 flex items-center gap-2 rounded-2xl border border-emerald-200/60 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/10 dark:text-emerald-300" role="status">
            <CheckCircle2 size={16} aria-hidden /> {notice}
          </p>
        )}

        {loading && !report ? (
          <div className="space-y-3">
            {[1, 2, 3].map((index) => (
              <div key={index} className="glass-panel h-28 animate-pulse rounded-3xl" />
            ))}
          </div>
        ) : !dirty ? (
          <div className="glass-panel rounded-3xl py-16 text-center">
            <CheckCircle2 size={48} className="mx-auto mb-4 text-emerald-500" aria-hidden />
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">数据健康</h2>
            <p className="mt-1 text-sm text-hint">没有检测到需要修复的问题</p>
          </div>
        ) : (
          <motion.div initial="hidden" animate="visible" variants={containerVariants} className="space-y-3">
            {sorted.map((finding) => (
              <motion.div key={finding.kind} variants={itemVariants}>
                <FindingCard finding={finding} repairing={repairing === finding.kind} onRepair={repair} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>
    </div>
  );
}
