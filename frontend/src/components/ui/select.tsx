import * as React from "react"
import { cn } from "@/lib/utils"

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className, children, ...props }, ref) => {
  return (
    <select
      className={cn(
        "flex h-12 w-full rounded-2xl border border-white/20 dark:border-white/10 bg-white/40 dark:bg-black/20 px-4 py-2 text-sm backdrop-blur-md transition-all focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:bg-white/80 dark:focus:bg-gray-900/80 focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50 appearance-none shadow-inner",
        className
      )}
      ref={ref}
      {...props}
    >
      {children}
    </select>
  )
})
Select.displayName = "Select"

export { Select }
