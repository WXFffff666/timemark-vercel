import { Sun, Moon } from 'lucide-react';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { toggleThemeWithTransition } from '@/lib/theme-transition';

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  const handleToggle = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (animating) return;
    const nextDark = !isDark;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top + rect.height / 2;

    setAnimating(true);
    try {
      await toggleThemeWithTransition(nextDark, { x, y });
      setIsDark(nextDark);
    } finally {
      setAnimating(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleToggle}
      disabled={animating}
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      className="relative rounded-full overflow-hidden hover:bg-black/5 dark:hover:bg-white/10 transition-colors min-h-11 min-w-11"
    >
      <motion.div
        initial={false}
        animate={{ rotate: isDark ? 180 : 0, scale: isDark ? 0 : 1, opacity: isDark ? 0 : 1 }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        className="absolute"
        aria-hidden
      >
        <Sun className="h-5 w-5 text-orange-500" />
      </motion.div>
      <motion.div
        initial={false}
        animate={{ rotate: isDark ? 0 : -180, scale: isDark ? 1 : 0, opacity: isDark ? 1 : 0 }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        className="absolute"
        aria-hidden
      >
        <Moon className="h-5 w-5 text-blue-400" />
      </motion.div>
    </Button>
  );
}
