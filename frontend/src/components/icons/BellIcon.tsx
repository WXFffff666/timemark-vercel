import { motion } from 'framer-motion'

interface IconProps {
  className?: string
  size?: number
}

export const BellIcon = ({ className = '', size = 24 }: IconProps) => {
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
      whileHover={{
        rotate: [0, -15, 15, -15, 15, 0],
        transition: { duration: 0.5 }
      }}
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </motion.svg>
  )
}
