import { useState } from 'react';

export function useToast() {
  const [toasts, setToasts] = useState<Array<{ id: string; title: string; description?: string }>>([]);

  const toast = ({ title, description }: { title: string; description?: string }) => {
    const id = Math.random().toString(36);
    setToasts((prev) => [...prev, { id, title, description }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  };

  return { toast, toasts };
}
