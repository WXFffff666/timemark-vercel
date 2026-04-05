import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 backdrop-blur-md shadow-sm",
  {
    variants: {
      variant: {
        default: "border-primary-500/30 bg-primary-500/10 text-primary-700 dark:text-primary-300 hover:bg-primary-500/20",
        secondary: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300 hover:bg-slate-500/20",
        destructive: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20",
        success: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300 hover:bg-green-500/20",
        outline: "text-foreground border-slate-300/50 dark:border-slate-600/50",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
