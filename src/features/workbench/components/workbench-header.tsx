import {
  CheckCircle2,
  FolderArchive,
  FolderOpen,
  Hammer,
  PackageOpen,
  ShieldCheck,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ProjectState, TaskProgress, ToolStatus } from '@/shared/types/workspace'
import { compactPath } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/card'

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/60 bg-white/70 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant = 'default',
}: {
  icon: typeof FolderOpen
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'secondary' | 'outline' | 'ghost'
}) {
  return (
    <Button onClick={onClick} disabled={disabled} variant={variant} size="sm">
      <Icon className="h-4 w-4" />
      {label}
    </Button>
  )
}

export function WorkbenchHeader({
  project,
  tools,
  busyText,
  taskProgress,
  isLoading,
  onChooseApk,
  onExtract,
  onExtractAllBundles,
  onBuildApk,
  onSignApk,
  onOpenDist,
}: {
  project: ProjectState | null
  tools: ToolStatus
  busyText: string
  taskProgress: TaskProgress | null
  isLoading: boolean
  onChooseApk: () => void
  onExtract: () => void
  onExtractAllBundles: () => void
  onBuildApk: () => void
  onSignApk: () => void
  onOpenDist: () => void
}) {
  const { t } = useTranslation()
  const showProgress = Boolean(taskProgress && !taskProgress.finished)
  const progressText = taskProgress
    ? t(`progress.${taskProgress.kind}`, {
        current: taskProgress.current,
        total: taskProgress.total,
        percent: Math.round(taskProgress.percent),
      })
    : ''
  const progressLabel = taskProgress?.label ? compactPath(taskProgress.label, 72) : ''

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardContent className="flex flex-col gap-2.5 px-4 py-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-2.5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{t('appTitle')}</CardTitle>
                <Badge className="bg-emerald-100 text-emerald-700">
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  {project?.manifest ? t('status.extracted') : project ? t('status.scanned') : t('status.ready')}
                </Badge>
                <Badge>{busyText}</Badge>
              </div>
              <CardDescription className="text-xs leading-5">
                {project ? compactPath(project.scan.apk, 120) : t('appSubtitle')}
              </CardDescription>
              <CardDescription className="text-[11px] leading-5">{tools.summary}</CardDescription>
              {showProgress ? (
                <div className="mt-1.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span className="truncate">{progressText}</span>
                    <span className="shrink-0 font-medium text-foreground">{Math.round(taskProgress.percent)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/80">
                    <div
                      className="h-full rounded-full bg-slate-900 transition-[width] duration-200"
                      style={{ width: `${taskProgress.percent}%` }}
                    />
                  </div>
                  {progressLabel ? <div className="truncate text-[11px] text-muted-foreground">{progressLabel}</div> : null}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ToolbarButton icon={FolderOpen} label={t('actions.chooseApk')} onClick={onChooseApk} disabled={isLoading} />
              <ToolbarButton icon={FolderArchive} label={t('actions.extract')} onClick={onExtract} disabled={isLoading || !project} />
              <ToolbarButton
                icon={PackageOpen}
                label={t('actions.extractAllBundles')}
                onClick={onExtractAllBundles}
                disabled={isLoading || !project?.manifest}
                variant="secondary"
              />
              <ToolbarButton
                icon={Hammer}
                label={t('actions.buildApk')}
                onClick={onBuildApk}
                disabled={isLoading || !project?.manifest}
                variant="outline"
              />
              <ToolbarButton
                icon={ShieldCheck}
                label={t('actions.signApk')}
                onClick={onSignApk}
                disabled={isLoading || !project?.manifest}
                variant="outline"
              />
              <ToolbarButton
                icon={FolderOpen}
                label={t('actions.openDist')}
                onClick={onOpenDist}
                disabled={!project?.dist_dir}
                variant="ghost"
              />
            </div>
          </div>
          <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-6">
            <CompactMetric label={t('labels.sourceApk')} value={project?.scan.name ?? t('empty.noApk')} />
            <CompactMetric label={t('labels.entries')} value={project ? `${project.scan.entry_count}` : '-'} />
            <CompactMetric label={t('labels.bundles')} value={project ? `${project.scan.counts.unity_bundles}` : '-'} />
            <CompactMetric label={t('labels.addressables')} value={project?.scan.addressables.version || '-'} />
            <CompactMetric
              label={t('labels.signed')}
              value={
                project
                  ? project.scan.signature.apk_signing_block_present || project.scan.signature.v1_present
                    ? t('common.yes')
                    : t('common.no')
                  : '-'
              }
            />
            <CompactMetric label={t('labels.workDir')} value={project ? compactPath(project.work_dir, 36) : '-'} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
