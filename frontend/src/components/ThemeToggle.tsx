import { Sun, Moon } from 'lucide-react';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  },[]);

  const toggleTheme = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    if (newDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggleTheme} className="relative rounded-full overflow-hidden hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
      <motion.div initial={false} animate={{ rotate: isDark ? 180 : 0, scale: isDark ? 0 : 1, opacity: isDark ? 0 : 1 }} transition={{ duration: 0.3, ease: 'easeInOut' }} className="absolute">
        <Sun className="h-5 w-5 text-orange-500" />
      </motion.div>
      <motion.div initial={false} animate={{ rotate: isDark ? 0 : -180, scale: isDark ? 1 : 0, opacity: isDark ? 1 : 0 }} transition={{ duration: 0.3, ease: 'easeInOut' }} className="absolute">
        <Moon className="h-5 w-5 text-blue-400" />
      </motion.div>
    </Button>
  );
}
