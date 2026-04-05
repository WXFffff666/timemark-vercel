import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/80 dark:bg-black/20 px-4 py-3 text-sm backdrop-blur-md transition-all placeholder:text-slate-400 dark:placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:bg-white dark:focus-visible:bg-gray-900/80 focus-visible:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50 shadow-inner resize-none text-slate-900 dark:text-white',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);

export { Textarea };
