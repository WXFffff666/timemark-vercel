import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Task 138 - guided channel-failure repair wizard.
 *
 * Steps: 1) diagnose (credential SHAPE + failure history), 2) live re-test,
 * 3) re-enter credentials, 4) explicit disable/enable. The stored secret value
 * is never returned by the API nor rendered here - only present/absent, and the
 * disable action is gated behind a confirmation switch (never automatic).
 */

type CredentialColumn = 'webhook' | 'token' | 'secret' | 'chat_id';

interface CredentialShapeField {
  column: CredentialColumn;
  label: string;
  required: boolean;
  present: boolean;
}

interface ChannelRepairDiagnosis {
  account: {
    id: number;
    name: string;
    type: string;
    configMethod: string;
    isActive: boolean;
    lastTestResult: string | null;
    lastTestAt: string | null;
    connectionStatus: string | null;
  };
  supported: boolean;
  templateFields: Array<{ name: string; label: string; type: string; required: boolean; helpText?: string }>;
  credentials: CredentialShapeField[];
  missingRequiredColumns: CredentialColumn[];
  failures: {
    consecutiveFailures: number;
    recentFailures: number;
    lastError: string | null;
    lastFailureAt: string | null;
  };
  disabled: boolean;
  autoDisabled: boolean;
  recommendedStep: 'retest' | 'reenter' | 'reactivate' | 'done';
}

interface TestOutcome {
  success: boolean;
  message: string;
  details: string | null;
  connectionStatus: string;
  lastTestResult: string;
}

const STEP_LABELS = ['1. 诊断', '2. 重新测试', '3. 重新填写凭据', '4. 禁用 / 启用'];

export interface ChannelRepairWizardProps {
  accountId: number;
  onClose?: () => void;
  /** Called after a successful credential fix / re-enable so the list can refresh. */
  onDone?: () => void;
  className?: string;
}

export function ChannelRepairWizard({ accountId, onClose, onDone, className }: ChannelRepairWizardProps) {
  const [step, setStep] = useState(0);
  const [diagnosis, setDiagnosis] = useState<ChannelRepairDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [form, setForm] = useState<Record<CredentialColumn, string>>({
    webhook: '',
    token: '',
    secret: '',
    chat_id: '',
  });
  const [reactivate, setReactivate] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const loadDiagnosis = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<ChannelRepairDiagnosis>(`/channel-repair/${accountId}`);
      setDiagnosis(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载渠道诊断');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void loadDiagnosis();
  }, [loadDiagnosis]);

  async function runTest() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await api.post<TestOutcome & { diagnosis: ChannelRepairDiagnosis }>(
        `/channel-repair/${accountId}/test`,
      );
      setTestResult(outcome);
      setDiagnosis(outcome.diagnosis);
      setNotice(outcome.success ? '连接测试成功' : '连接测试失败，请查看上方错误信息');
    } catch (err) {
      setError(err instanceof Error ? err.message : '测试失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitCredentials() {
    const payload: Record<string, string | boolean> = { reactivate };
    for (const field of diagnosis?.credentials ?? []) {
      const value = form[field.column].trim();
      if (value) payload[field.column] = value;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/channel-repair/${accountId}/credentials`, payload);
      setForm({ webhook: '', token: '', secret: '', chat_id: '' });
      setReactivate(false);
      await loadDiagnosis();
      onDone?.();
      setNotice('凭据已更新，建议执行一次重新测试');
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '凭据更新失败');
    } finally {
      setBusy(false);
    }
  }

  async function setActive(active: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/channel-repair/${accountId}/${active ? 'enable' : 'disable'}`, { confirm: true });
      await loadDiagnosis();
      onDone?.();
      setConfirmDisable(false);
      setNotice(active ? '渠道已启用' : '渠道已禁用');
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态更新失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className={cn('flex items-center gap-2 p-6 text-sm text-slate-500', className)} data-testid="channel-repair-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在诊断渠道…
      </div>
    );
  }

  if (!diagnosis) {
    return (
      <div className={cn('space-y-3 p-6', className)} data-testid="channel-repair-error">
        <p className="text-sm text-red-600 dark:text-red-400">{error ?? '渠道不存在'}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadDiagnosis()}>
          <RefreshCw className="mr-1.5 h-4 w-4" /> 重试
        </Button>
      </div>
    );
  }

  const { account, credentials, failures } = diagnosis;

  return (
    <div className={cn('space-y-4', className)} data-testid="channel-repair-wizard">
      <header className="flex flex-wrap items-center gap-2">
        <Wrench className="h-5 w-5 text-primary-600" />
        <h3 className="text-lg font-semibold dark:text-white">{account.name || account.type}</h3>
        <Badge variant="outline" className="normal-case">
          {account.type}
        </Badge>
        {account.isActive ? (
          <Badge variant="success" className="normal-case">
            <ShieldCheck className="mr-1 h-3 w-3" /> 启用中
          </Badge>
        ) : (
          <Badge variant="destructive" className="normal-case">
            <ShieldAlert className="mr-1 h-3 w-3" /> 已禁用
          </Badge>
        )}
        {account.connectionStatus ? (
          <Badge variant="secondary" className="normal-case">
            {account.connectionStatus}
          </Badge>
        ) : null}
      </header>

      <nav className="flex flex-wrap gap-1.5" aria-label="修复步骤">
        {STEP_LABELS.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(index)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
              index === step
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/5 dark:text-slate-300',
            )}
            data-testid={`repair-step-${index}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {notice ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400" data-testid="repair-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="repair-error">
          {error}
        </p>
      ) : null}

      {step === 0 ? (
        <section className="space-y-3" data-testid="repair-step-diagnose">
          <div className="rounded-xl bg-slate-100/80 p-3 text-sm dark:bg-white/5">
            <p className="font-medium">
              连续失败 {failures.consecutiveFailures} 次 · 最近失败 {failures.recentFailures} 次
            </p>
            {diagnosis.autoDisabled ? (
              <p className="mt-1 flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" /> 已连续失败 3 次并被自动停用，请先修复凭据再手动启用。
              </p>
            ) : null}
            {failures.lastError ? (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/70 p-2 text-xs text-slate-700 dark:bg-black/30 dark:text-slate-200">
                {failures.lastError}
              </pre>
            ) : (
              <p className="mt-1 text-slate-500">暂无失败记录。</p>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium">凭据完整性（仅显示是否已保存，绝不显示内容）</p>
            <ul className="space-y-1" data-testid="repair-credentials-shape">
              {credentials.map((field) => (
                <li key={field.column} className="flex items-center gap-2 text-sm">
                  {field.present ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <XCircle className={cn('h-4 w-4', field.required ? 'text-red-500' : 'text-slate-400')} />
                  )}
                  <span>{field.label}</span>
                  <span className="text-xs text-slate-500">
                    {field.present ? '已保存' : field.required ? '缺失（必填）' : '未设置（可选）'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <Button type="button" variant="vision" size="sm" onClick={() => setStep(1)}>
            下一步：重新测试
          </Button>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="space-y-3" data-testid="repair-step-test">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            使用已保存的凭据发送一次测试请求，不会暴露任何密钥内容。
          </p>
          <Button type="button" size="sm" disabled={busy} onClick={() => void runTest()} data-testid="repair-retest">
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            立即重新测试
          </Button>
          {testResult ? (
            <div
              className={cn(
                'rounded-xl p-3 text-sm',
                testResult.success
                  ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300',
              )}
              data-testid="repair-test-result"
            >
              <p className="font-medium">{testResult.message}</p>
              {testResult.details ? <p className="mt-1 text-xs opacity-90">{testResult.details}</p> : null}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setStep(2)}>
              仍然失败？重新填写凭据
            </Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="space-y-3" data-testid="repair-step-credentials">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            只需填写需要变更的字段；留空的字段保持原值不变。
          </p>
          {credentials.map((field) => (
            <div key={field.column} className="space-y-1">
              <Label htmlFor={`cred-${field.column}`}>
                {field.label}
                {field.required ? <span className="ml-1 text-red-500">*</span> : null}
              </Label>
              <Input
                id={`cred-${field.column}`}
                type={field.column === 'token' || field.column === 'secret' ? 'password' : 'text'}
                autoComplete="off"
                placeholder={field.present ? '已保存，留空则不修改' : '请输入'}
                value={form[field.column]}
                onChange={(e) => setForm((prev) => ({ ...prev, [field.column]: e.target.value }))}
              />
            </div>
          ))}

          {diagnosis.disabled ? (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={reactivate} onCheckedChange={setReactivate} />
              保存后同时重新启用该渠道
            </label>
          ) : null}

          <Button type="button" size="sm" disabled={busy} onClick={() => void submitCredentials()} data-testid="repair-save-credentials">
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            保存凭据
          </Button>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="space-y-3" data-testid="repair-step-disable">
          {account.isActive ? (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                禁用后该渠道不再接收通知。此操作不会自动发生，必须由你确认。
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmDisable}
                  onChange={(e) => setConfirmDisable(e.target.checked)}
                  data-testid="repair-confirm-disable"
                />
                我确认要禁用该渠道
              </label>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || !confirmDisable}
                onClick={() => void setActive(false)}
              >
                禁用渠道
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                该渠道当前已禁用。确认凭据无误后可重新启用。
              </p>
              <Button type="button" variant="vision" size="sm" disabled={busy} onClick={() => void setActive(true)}>
                启用渠道
              </Button>
            </>
          )}
        </section>
      ) : null}

      {onClose ? (
        <div className="border-t border-slate-200/70 pt-3 dark:border-white/10">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      ) : null}
    </div>
  );
}
