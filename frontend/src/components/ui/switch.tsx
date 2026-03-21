import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  checked?: boolean;
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, ...props }, ref) => (
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        role="switch"
        ref={ref}
        checked={checked}
        className="sr-only peer"
        {...props}
      />
      <div className={cn(
        'w-11 h-6 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2',
        checked ? 'bg-primary' : 'bg-gray-300',
        className
      )}>
        <motion.div
          className="absolute top-0.5 left-0.5 bg-white w-5 h-5 rounded-full shadow-sm"
          animate={{ x: checked ? 20 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </div>
    </label>
  )
);

export { Switch };
