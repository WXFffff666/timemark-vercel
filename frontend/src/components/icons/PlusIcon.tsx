import { motion } from 'framer-motion'

interface IconProps {
  className?: string
  size?: number
}

export const PlusIcon = ({ className = '', size = 24 }: IconProps) => {
  return (
    <motion.svg
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
      whileHover={{ rotate: 45, scale: 1.1 }}
      transition={{ duration: 0.2 }}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </motion.svg>
  )
}
