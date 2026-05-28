import { ChevronRight, FolderOpen } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { workbenchGroups, type GroupId } from '@/features/workbench/lib/workbench'
import { cn } from '@/shared/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { ScrollArea } from '@/shared/ui/scroll-area'
import { WorkbenchIcon } from '@/features/workbench/components/workbench-icons'

export function WorkbenchSidebar({
  group,
  counts,
  currentBundlePath,
  onSelectGroup,
  onBackToApk,
}: {
  group: GroupId
  counts: Map<GroupId, number>
  currentBundlePath: string | null
  onSelectGroup: (group: GroupId) => void
  onBackToApk: () => void
}) {
  const { t } = useTranslation()

  const apkGroups = useMemo(() => workbenchGroups.filter((item) => item.section === 'apk'), [])
  const bundleGroups = useMemo(() => workbenchGroups.filter((item) => item.section === 'bundle'), [])

  return (
    <Card className="min-h-0 min-w-0 overflow-hidden xl:flex xl:flex-col">
      <CardHeader className="px-3.5 py-2.5">
        <div className="space-y-1.5">
          <div>
            <CardTitle>{t('sections.resourceTree')}</CardTitle>
            <CardDescription className="text-xs">{t('sections.resourceTreeDesc')}</CardDescription>
          </div>
          {currentBundlePath ? (
            <div className="rounded-md border border-white/60 bg-white/70 px-2.5 py-2 text-xs text-muted-foreground">
              <div className="mb-1 text-[11px] uppercase tracking-[0.08em]">{t('labels.breadcrumb')}</div>
              <div className="flex items-center gap-1">
                <span>{t('sections.apkResources')}</span>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="truncate">{t('labels.currentBundle')}</span>
              </div>
            </div>
          ) : null}
          {currentBundlePath ? (
            <button
              type="button"
              onClick={onBackToApk}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-white/70 bg-white/75 px-2.5 text-xs text-muted-foreground transition hover:bg-white"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t('actions.backToApk')}
            </button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-2.5 pb-2.5">
        <ScrollArea className="h-full pr-0.5">
          <div className="space-y-3">
            <SidebarSection title={t('sections.apkResources')} groups={apkGroups} activeGroup={group} counts={counts} onSelect={onSelectGroup} />
            <SidebarSection
              title={t('sections.bundleResourcesNav')}
              groups={bundleGroups}
              activeGroup={group}
              counts={counts}
              onSelect={onSelectGroup}
            />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function SidebarSection({
  title,
  groups,
  activeGroup,
  counts,
  onSelect,
}: {
  title: string
  groups: typeof workbenchGroups
  activeGroup: GroupId
  counts: Map<GroupId, number>
  onSelect: (group: GroupId) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1.5">
      <div className="px-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{title}</div>
      <div className="grid gap-1">
        {groups.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={cn(
              'grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition',
              activeGroup === item.id ? 'bg-primary text-primary-foreground' : 'bg-white/60 hover:bg-white',
            )}
          >
            <WorkbenchIcon name={item.icon as never} className="h-4 w-4" />
            <span className="truncate">{t(item.labelKey)}</span>
            <span className="text-xs">{counts.get(item.id) ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
