import { motion } from 'framer-motion'

interface IconProps {
  className?: string
  size?: number
}

export const CalendarIcon = ({ className = '', size = 24 }: IconProps) => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-hidden="true"
    >
      <motion.rect
        x="3"
        y="4"
        width="18"
        height="18"
        rx="2"
        ry="2"
        initial={{ pathLength: prefersReducedMotion ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
      <motion.line
        x1="16"
        y1="2"
        x2="16"
        y2="6"
        initial={{ pathLength: prefersReducedMotion ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, delay: 0.2, ease: 'easeOut' }}
      />
      <motion.line
        x1="8"
        y1="2"
        x2="8"
        y2="6"
        initial={{ pathLength: prefersReducedMotion ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, delay: 0.2, ease: 'easeOut' }}
      />
      <motion.line
        x1="3"
        y1="10"
        x2="21"
        y2="10"
        initial={{ pathLength: prefersReducedMotion ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, delay: 0.4, ease: 'easeOut' }}
      />
    </svg>
  )
}
