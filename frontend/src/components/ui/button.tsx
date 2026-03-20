import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'outline' | 'ghost';
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <button
        className={cn(
          'inline-flex items-center justify-center rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          variant === 'default' && 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
          variant === 'destructive' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
          variant === 'outline' && 'border border-input bg-background hover:bg-secondary',
          variant === 'ghost' && 'hover:bg-secondary',
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
