import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'outline' | 'ghost' | 'glass' | 'gradient';
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        className={cn(
          'inline-flex items-center justify-center rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          variant === 'default' && 'bg-primary-500 text-white hover:bg-primary-600 shadow-sm hover:shadow-md',
          variant === 'destructive' && 'bg-red-500 text-white hover:bg-red-600 shadow-sm hover:shadow-md',
          variant === 'outline' && 'border border-gray-300 dark:border-gray-600 bg-transparent hover:bg-gray-50 dark:hover:bg-gray-800',
          variant === 'ghost' && 'hover:bg-gray-100 dark:hover:bg-gray-800',
          variant === 'glass' && 'glass text-gray-900 dark:text-white hover:shadow-glow',
          variant === 'gradient' && 'bg-gradient-to-r from-primary-500 to-purple-500 text-white hover:from-primary-600 hover:to-purple-600 shadow-lg hover:shadow-glow',
          'h-10 px-4 py-2',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);

export { Button };
