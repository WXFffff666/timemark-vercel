import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

// 【开关优化】：非激活状态的背景加深，解决"看不到开关"的问题
const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn("peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-slate-300 dark:data-[state=unchecked]:bg-slate-600 shadow-inner alive-interactive", className)}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb className={cn("pointer-events-none block h-6 w-6 rounded-full bg-white shadow-md ring-0 transition-transform duration-300 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0 dark:shadow-black/40")} />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
