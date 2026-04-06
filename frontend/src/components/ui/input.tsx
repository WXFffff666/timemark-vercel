import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

// 【输入框优化】：浅色模式下采用不透明的白色加深灰边框，避免与卡片背景融为一体。
const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-12 w-full rounded-2xl border border-slate-300 dark:border-white/10 bg-white/70 dark:bg-black/30 px-4 py-2 text-sm transition-all placeholder:text-slate-400 dark:placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 focus-visible:border-blue-500 dark:focus-visible:border-blue-400 disabled:cursor-not-allowed disabled:opacity-50 shadow-sm text-slate-900 dark:text-white",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Input.displayName = "Input"

export { Input }
