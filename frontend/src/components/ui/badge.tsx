import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// 【徽章优化】：使用更加饱满、对比度更高的小色块，文字显眼
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-3 py-1 text-[11px] font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 shadow-sm uppercase tracking-wider",
  {
    variants: {
      variant: {
        default: "border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-500/30",
        secondary: "border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700",
        destructive: "border-red-200 dark:border-red-500/30 bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-500/20",
        success: "border-emerald-200 dark:border-emerald-500/30 bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-500/20",
        outline: "text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600",
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
