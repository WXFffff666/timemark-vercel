import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { DataHealthKind, DataHealthRepairResult, DataHealthReport } from './types';

export interface UseDataHealthResult {
  report: DataHealthReport | null;
  loading: boolean;
  error: string | null;
  repairing: DataHealthKind | null;
  notice: string | null;
  reload: () => Promise<void>;
  repair: (kind: DataHealthKind, confirm: boolean) => Promise<DataHealthRepairResult>;
}

/** Fetches the data-health report and runs one-click repairs. */
export function useDataHealth(): UseDataHealthResult {
  const [report, setReport] = useState<DataHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<DataHealthKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.get<DataHealthReport>('/data-health'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const repair = useCallback(
    async (kind: DataHealthKind, confirm: boolean) => {
      setRepairing(kind);
      setNotice(null);
      setError(null);
      try {
        const result = await api.post<DataHealthRepairResult>(`/data-health/repair/${kind}`, { confirm });
        setNotice(result.message);
        await reload();
        return result;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '修复失败');
        throw reason;
      } finally {
        setRepairing(null);
      }
    },
    [reload],
  );

  return { report, loading, error, repairing, notice, reload, repair };
}
