import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// 【按钮 UI 深度优化】：重新调配色彩对比度
// 1. vision 变体（核心按键，如登录）：采用极高对比度的科技蓝渐变，绝对醒目，绝不与背景融合。
// 2. outline 变体：加深了边框，增加了背景色，解决原来完全透明导致看不清的问题。
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary-500/20 disabled:pointer-events-none disabled:opacity-50 alive-interactive tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 shadow-md",
        destructive: "bg-red-500 text-white hover:bg-red-600 shadow-md shadow-red-500/20",
        outline: "border border-slate-300 dark:border-slate-700 bg-white/60 dark:bg-zinc-800/50 hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-200 shadow-sm",
        secondary: "bg-slate-200/80 dark:bg-zinc-800/80 text-slate-900 dark:text-slate-100 hover:bg-slate-300/80 dark:hover:bg-zinc-700/80 shadow-sm",
        ghost: "hover:bg-slate-200/60 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300",
        link: "text-primary-600 dark:text-primary-400 underline-offset-4 hover:underline",
        gradient: "bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:shadow-lg shadow-md",
        // vision 变体：主视觉按钮。高饱和度蓝紫渐变，立体内发光，极强弥散阴影
        vision: "bg-gradient-to-b from-blue-500 to-indigo-600 text-white border-t border-blue-400/50 shadow-[0_8px_20px_rgba(79,70,229,0.35),inset_0_1px_1px_rgba(255,255,255,0.4)] hover:shadow-[0_8px_25px_rgba(79,70,229,0.45)] hover:brightness-110 active:brightness-95",
      },
      size: {
        default: "h-11 px-5 py-2",
        sm: "h-9 rounded-lg px-4",
        lg: "h-14 rounded-2xl px-8 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = "Button"

export { Button, buttonVariants }
