import { forwardRef, type HTMLAttributes } from 'react'

import { cn } from '@/shared/lib/utils'

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn('overflow-auto', className)} {...props} />
  },
)

ScrollArea.displayName = 'ScrollArea'
