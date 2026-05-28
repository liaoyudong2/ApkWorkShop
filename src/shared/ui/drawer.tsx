import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

export function Drawer({
  expanded,
  collapsedHeight = 48,
  expandedHeight = 220,
  header,
  children,
  className,
}: {
  expanded: boolean
  collapsedHeight?: number
  expandedHeight?: number
  header: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-white/70 bg-white/88 shadow-panel backdrop-blur supports-[backdrop-filter]:bg-white/72 transition-[height]',
        className,
      )}
      style={{ height: expanded ? expandedHeight : collapsedHeight }}
    >
      {header}
      <div className={cn('min-h-0 overflow-hidden', expanded ? 'h-[calc(100%-48px)]' : 'h-0')}>{children}</div>
    </div>
  )
}
