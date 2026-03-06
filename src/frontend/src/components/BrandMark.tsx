interface BrandMarkProps {
  className?: string
  title?: string
}

export default function BrandMark({ className, title }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="16" cy="16" r="9.8" fill="#17B8FF" />
      <circle cx="16" cy="16" r="12.2" stroke="#FACC15" strokeWidth="3.2" />
      <circle cx="16" cy="16" r="9.8" stroke="#FFFFFF" strokeWidth="1.5" />
    </svg>
  )
}
