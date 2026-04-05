import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn("peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary-500 data-[state=unchecked]:bg-slate-300/80 dark:data-[state=unchecked]:bg-slate-700/80 shadow-inner alive-interactive", className)}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb className={cn("pointer-events-none block h-6 w-6 rounded-full bg-white shadow-lg ring-0 transition-transform duration-300 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0 dark:shadow-black/40")} />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
