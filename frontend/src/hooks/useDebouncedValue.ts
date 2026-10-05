import { useEffect, useState } from 'react';

/**
 * v2.27 E-11：共享防抖 hook —— Expiry / Inventory / Documents / Maintenance 等
 * 页此前各自手写同一套 setTimeout 防抖。输入变化后 delay 毫秒才返回新值。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
