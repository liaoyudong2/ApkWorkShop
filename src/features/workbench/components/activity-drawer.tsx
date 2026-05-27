import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ActivityLogItem } from '@/shared/types/workspace'
import { formatDateTime } from '@/shared/lib/utils'
import { Drawer } from '@/shared/ui/drawer'
import { ScrollArea } from '@/shared/ui/scroll-area'

export function ActivityDrawer({
  logs,
  expanded,
  onToggle,
}: {
  logs: ActivityLogItem[]
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()

  return (
    <Drawer
      expanded={expanded}
      collapsedHeight={48}
      expandedHeight={220}
      header={
        <button
          type="button"
          onClick={onToggle}
          className="flex h-12 w-full items-center justify-between px-4 text-left"
        >
          <div>
            <div className="text-sm font-semibold text-foreground">{t('sections.activity')}</div>
            <div className="text-xs text-muted-foreground">{t('sections.activityDesc')}</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{expanded ? t('actions.hideLogs') : t('actions.showLogs')}</span>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </div>
        </button>
      }
    >
      <ScrollArea className="h-full px-4 pb-4">
        <div className="grid gap-1.5">
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty.noLogs')}</p>
          ) : (
            logs
              .slice()
              .reverse()
              .map((item, index) => (
                <div key={`${item.at}-${index}`} className="rounded-md border border-white/60 bg-white/65 px-3 py-1.5 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium text-foreground">{item.message}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(item.at)}</span>
                  </div>
                </div>
              ))
          )}
        </div>
      </ScrollArea>
    </Drawer>
  )
}
