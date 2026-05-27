import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

export function SegmentedTabs({
  value,
  onChange,
  items,
  className,
}: {
  value: string
  onChange: (value: string) => void
  items: Array<{ value: string; label: ReactNode; disabled?: boolean }>
  className?: string
}) {
  return (
    <div className={cn('inline-flex rounded-lg border border-white/70 bg-white/70 p-1', className)}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
          disabled={item.disabled}
          className={cn(
            'inline-flex min-w-[84px] items-center justify-center rounded-md px-3 py-1.5 text-sm transition',
            value === item.value
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-white',
            item.disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function FilterChip({
  active,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-full border px-3 text-xs transition',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-white/70 bg-white/75 text-muted-foreground hover:bg-white',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
