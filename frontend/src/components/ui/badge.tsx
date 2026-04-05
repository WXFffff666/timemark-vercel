import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 backdrop-blur-md shadow-sm",
  {
    variants: {
      variant: {
        default: "border-primary-500/30 bg-primary-500/10 text-primary-700 dark:text-primary-300 hover:bg-primary-500/20",
        secondary: "border-gray-500/30 bg-gray-500/10 text-gray-700 dark:text-gray-300 hover:bg-gray-500/20",
        destructive: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20",
        success: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300 hover:bg-green-500/20",
        outline: "text-foreground border-gray-300/50 dark:border-gray-600/50",
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
