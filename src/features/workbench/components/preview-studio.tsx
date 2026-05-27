import { FileSearch, PackageCheck, PackageOpen, Replace, Route } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CompareViewer, type ImagePreviewMetrics } from '@/features/workbench/components/compare-viewer'
import type {
  BundleAnalyzeInfo,
  BundleManifest,
  BundleNode,
  BundleResource,
  BundleResourceSummary,
  Entry,
  PreviewResult,
} from '@/shared/types/workspace'
import {
  allowedCompareModes,
  basename,
  buildSnapshotMetaFromApkEntry,
  buildSnapshotMetaFromBundleNode,
  buildSnapshotMetaFromBundleResource,
  type CompareMode,
  type PreviewSnapshot,
  type Selection,
} from '@/features/workbench/lib/workbench'
import { cn, formatDateTime, formatSize } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { ScrollArea } from '@/shared/ui/scroll-area'

export function PreviewStudio({
  selection,
  entry,
  bundleManifest,
  bundleInfo,
  bundleError,
  bundleNode,
  bundleResource,
  bundleSummaryItem,
  preview,
  snapshot,
  compareMode,
  isReplaceable,
  dragActive,
  dragLabel,
  onCompareModeChange,
  onReplace,
  onAnalyzeBundle,
  onExtractBundle,
  onBuildBundle,
  onReplaceBundle,
  onJumpToBundle,
  onBackToBundle,
  onJumpToNode,
}: {
  selection: Selection | null
  entry: Entry | null
  bundleManifest: BundleManifest | null
  bundleInfo: BundleAnalyzeInfo | null
  bundleError: string | null
  bundleNode: BundleNode | null
  bundleResource: BundleResource | null
  bundleSummaryItem: BundleResourceSummary | null
  preview: PreviewResult | null
  snapshot: PreviewSnapshot | null
  compareMode: CompareMode
  isReplaceable: boolean
  dragActive: boolean
  dragLabel: string | null
  onCompareModeChange: (mode: CompareMode) => void
  onReplace: () => void
  onAnalyzeBundle: () => void
  onExtractBundle: () => void
  onBuildBundle: () => void
  onReplaceBundle: () => void
  onJumpToBundle: () => void
  onBackToBundle: () => void
  onJumpToNode: () => void
}) {
  const { t } = useTranslation()
  const [imageMetrics, setImageMetrics] = useState<ImagePreviewMetrics | null>(null)

  const compareModes = useMemo<CompareMode[]>(
    () => allowedCompareModes(preview, Boolean(snapshot?.before)),
    [preview, snapshot],
  )

  const replacementInfo = useMemo(() => {
    if (!selection) {
      return null
    }
    if (selection.type === 'apk') {
      return entry ? buildSnapshotMetaFromApkEntry(entry) : null
    }
    if (selection.type === 'bundle-node') {
      return bundleNode ? buildSnapshotMetaFromBundleNode(bundleNode) : null
    }
    if (selection.type === 'bundle-resource') {
      return bundleResource
        ? buildSnapshotMetaFromBundleResource(bundleResource)
        : bundleSummaryItem
          ? buildSnapshotMetaFromBundleResource(bundleSummaryItem.resource)
          : null
    }
    return null
  }, [bundleNode, bundleResource, bundleSummaryItem, entry, selection])

  const bundleContext = bundleManifest?.info ?? bundleInfo
  const currentResource = bundleResource ?? bundleSummaryItem?.resource ?? null
  const canFallbackToNode = selection?.type === 'bundle-resource' && !isReplaceable && Boolean(currentResource?.node_id)

  return (
    <Card className="min-h-0 overflow-hidden xl:flex xl:flex-col">
      <CardHeader className="px-3.5 py-2.5">
        <div>
          <CardTitle>{t('sections.inspector')}</CardTitle>
          <CardDescription className="text-xs">{t('sections.inspectorDesc')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-3.5 pb-3">
        {!selection ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('empty.noSelection')}</div>
        ) : (
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,0.72fr)_minmax(0,0.28fr)] gap-3">
            <PreviewToolbar
              selection={selection}
              entry={entry}
              bundleManifest={bundleManifest}
              isReplaceable={isReplaceable}
              onReplace={onReplace}
              onAnalyzeBundle={onAnalyzeBundle}
              onExtractBundle={onExtractBundle}
              onBuildBundle={onBuildBundle}
              onReplaceBundle={onReplaceBundle}
              onJumpToBundle={onJumpToBundle}
              onBackToBundle={onBackToBundle}
            />

            <div className="relative min-h-0 overflow-hidden rounded-lg border border-white/60 bg-white/75 p-3">
              {dragActive ? (
                <div className="absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
                  {dragLabel ?? t('inspector.dropReplace')}
                </div>
              ) : null}
              <div className="flex h-full min-h-0 flex-col">
                <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{t('sections.previewStage')}</div>
                <div className="min-h-0 flex-1">
                  <CompareViewer
                    preview={preview}
                    snapshot={snapshot}
                    mode={compareMode}
                    allowedModes={compareModes}
                    onModeChange={onCompareModeChange}
                    onImageMetricsChange={setImageMetrics}
                  />
                </div>
              </div>
            </div>

            <ScrollArea className="min-h-0 rounded-lg border border-white/60 bg-white/70 p-3">
              <div className="space-y-3">
                {bundleError ? (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{bundleError}</div>
                ) : null}
                <InfoSection title={t('labels.basicInfo')}>
                  <InfoList
                    items={[
                      { label: t('labels.selectionType'), value: selection.type },
                      { label: t('labels.fileType'), value: replacementInfo?.type ?? '-' },
                      replacementInfo?.size != null ? { label: t('detailKeys.size'), value: formatSize(replacementInfo.size) } : null,
                      { label: t('labels.fileCrc'), value: replacementInfo?.crc ?? '-' },
                      imageMetrics
                        ? {
                            label: t('detailKeys.canvas_size'),
                            value: `${imageMetrics.naturalWidth} x ${imageMetrics.naturalHeight}`,
                          }
                        : null,
                      imageMetrics
                        ? {
                            label: t('detailKeys.visible_content_size'),
                            value: `${imageMetrics.contentWidth} x ${imageMetrics.contentHeight}`,
                          }
                        : null,
                    ]}
                  />
                </InfoSection>

                <InfoSection title={t('labels.sourceInfo')}>
                  <InfoList
                    items={[
                      {
                        label: t('labels.filePath'),
                        value:
                          selection.type === 'apk'
                            ? entry?.path ?? '-'
                            : bundleNode?.path ??
                              bundleResource?.node_path ??
                              bundleSummaryItem?.resource.node_path ??
                              '-',
                      },
                      { label: t('labels.previewFile'), value: preview?.file_path ?? replacementInfo?.fileName ?? '-' },
                      bundleSummaryItem ? { label: t('labels.sourceBundle'), value: bundleSummaryItem.bundle_path } : null,
                      imageMetrics
                        ? {
                            label: t('detailKeys.transparent_margin'),
                            value: `${t('detailKeys.left')}: ${imageMetrics.transparentLeft}px, ${t('detailKeys.top')}: ${imageMetrics.transparentTop}px, ${t('detailKeys.right')}: ${imageMetrics.transparentRight}px, ${t('detailKeys.bottom')}: ${imageMetrics.transparentBottom}px`,
                          }
                        : null,
                    ]}
                  />
                </InfoSection>

                <InfoSection title={t('labels.replacementInfo')}>
                  {snapshot ? (
                    <InfoList
                      items={[
                        { label: t('labels.replacedState'), value: t('inspector.changed') },
                        { label: t('labels.replacementTime'), value: formatDateTime(snapshot.replacedAt) },
                        { label: t('labels.replacementSource'), value: snapshot.sourcePath ?? '-' },
                        { label: t('labels.beforeFile'), value: basename(snapshot.before.file_path || snapshot.meta.fileName || snapshot.meta.path) },
                        { label: t('labels.currentFile'), value: basename(preview?.file_path || replacementInfo?.fileName || replacementInfo?.path) },
                      ]}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">{t('inspector.notChanged')}</div>
                  )}
                </InfoSection>

                {canFallbackToNode ? (
                  <InfoSection title={t('sections.fallbackActions')}>
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">{t('inspector.replaceViaNode')}</div>
                      <Button variant="secondary" onClick={onJumpToNode}>
                        <Route className="h-4 w-4" />
                        {t('inspector.goNodeReplace')}
                      </Button>
                    </div>
                  </InfoSection>
                ) : null}

                {selection.type !== 'apk' ? (
                  <InfoSection title={t('labels.bundleContext')}>
                    <InfoList
                      items={[
                        {
                          label: t('labels.bundlePath'),
                          value:
                            selection.type === 'bundle-resource'
                              ? bundleSummaryItem?.bundle_path ?? entry?.path ?? '-'
                              : entry?.path ?? '-',
                        },
                        { label: t('detailKeys.engine_version'), value: bundleContext?.engine_version ?? '-' },
                        { label: t('detailKeys.compression'), value: bundleContext?.compression ?? '-' },
                        { label: t('detailKeys.node_count'), value: bundleContext?.node_count != null ? `${bundleContext.node_count}` : '-' },
                        { label: t('detailKeys.resource_count'), value: bundleContext?.resource_count != null ? `${bundleContext.resource_count}` : '-' },
                      ]}
                    />
                  </InfoSection>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PreviewToolbar({
  selection,
  entry,
  bundleManifest,
  isReplaceable,
  onReplace,
  onAnalyzeBundle,
  onExtractBundle,
  onBuildBundle,
  onReplaceBundle,
  onJumpToBundle,
  onBackToBundle,
}: {
  selection: Selection
  entry: Entry | null
  bundleManifest: BundleManifest | null
  isReplaceable: boolean
  onReplace: () => void
  onAnalyzeBundle: () => void
  onExtractBundle: () => void
  onBuildBundle: () => void
  onReplaceBundle: () => void
  onJumpToBundle: () => void
  onBackToBundle: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap items-center gap-2">
      {selection.type === 'apk' ? (
        <Button onClick={onReplace} disabled={!isReplaceable}>
          <Replace className="h-4 w-4" />
          {t('actions.replaceCurrent')}
        </Button>
      ) : null}

      {selection.type === 'bundle' ? (
        <>
          <Button variant="secondary" onClick={onAnalyzeBundle}>
            <FileSearch className="h-4 w-4" />
            {t('inspector.analyzeBundle')}
          </Button>
          <Button onClick={onExtractBundle}>
            <PackageOpen className="h-4 w-4" />
            {t('inspector.extractBundle')}
          </Button>
          <Button variant="outline" onClick={onBuildBundle} disabled={!bundleManifest}>
            <PackageCheck className="h-4 w-4" />
            {t('inspector.buildBundle')}
          </Button>
          <Button variant="outline" onClick={onReplaceBundle}>
            <Replace className="h-4 w-4" />
            {t('inspector.replaceBundle')}
          </Button>
        </>
      ) : null}

      {selection.type === 'bundle-node' ? (
        <>
          <Button variant="ghost" onClick={onBackToBundle}>
            {t('inspector.backToBundle')}
          </Button>
          <Button onClick={onReplace}>
            <Replace className="h-4 w-4" />
            {t('actions.replaceCurrentNode')}
          </Button>
          <Button variant="outline" onClick={onBuildBundle}>
            <PackageCheck className="h-4 w-4" />
            {t('inspector.buildBundle')}
          </Button>
        </>
      ) : null}

      {selection.type === 'bundle-resource' ? (
        <>
          {entry ? (
            <Button variant="ghost" onClick={onBackToBundle}>
              {t('inspector.backToBundle')}
            </Button>
          ) : null}
          <Button onClick={onReplace} disabled={!isReplaceable}>
            <Replace className="h-4 w-4" />
            {t('actions.replaceCurrent')}
          </Button>
          {!entry ? (
            <Button variant="secondary" onClick={onJumpToBundle}>
              {t('actions.locateBundle')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onBuildBundle}>
            <PackageCheck className="h-4 w-4" />
            {t('inspector.buildBundle')}
          </Button>
        </>
      ) : null}
    </div>
  )
}

function InfoSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{title}</div>
      <div className="rounded-lg border border-white/60 bg-white/75 p-3">{children}</div>
    </section>
  )
}

function InfoList({
  items,
}: {
  items: Array<{ label: string; value: string } | null>
}) {
  const filtered = items.filter((item): item is { label: string; value: string } => Boolean(item))
  return (
    <div className="space-y-2">
      {filtered.map((item) => (
        <div key={`${item.label}:${item.value}`} className="border-b border-white/60 pb-2 last:border-b-0 last:pb-0">
          <div className="text-[11px] text-muted-foreground">{item.label}</div>
          <div className={cn('mt-1 break-all text-sm leading-6 text-foreground')}>{item.value}</div>
        </div>
      ))}
    </div>
  )
}
