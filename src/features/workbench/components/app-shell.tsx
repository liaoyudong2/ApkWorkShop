import {
  BadgeInfo,
  Boxes,
  CheckCircle2,
  FileArchive,
  FileAudio2,
  FileCode2,
  FileImage,
  FileSearch,
  FileText,
  FolderArchive,
  FolderOpen,
  Hammer,
  ImageIcon,
  ListFilter,
  PackageCheck,
  PackageOpen,
  RefreshCcw,
  Replace,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { ScrollArea } from '@/shared/ui/scroll-area'
import {
  useApkPreview,
  useBundleActions,
  useBundleManifest,
  useBundleNodePreview,
  useBundleResourceCounts,
  useBundleResourceList,
  useBundleResourcePreview,
} from '@/features/workbench/hooks/use-project'
import type {
  ActivityLogItem,
  BundleManifest,
  BundleNode,
  BundleResource,
  BundleResourceSummary,
  Entry,
  PreviewResult,
  ProjectState,
  ToolStatus,
} from '@/shared/types/workspace'
import { cn, compactPath, formatDateTime, formatSize } from '@/shared/lib/utils'

type GroupId =
  | 'all'
  | 'assets'
  | 'res'
  | 'lib'
  | 'classes'
  | 'meta'
  | 'images'
  | 'texts'
  | 'bundles'
  | 'bundle_resources'
  | 'bundle_images'
  | 'bundle_texts'
  | 'bundle_audio'
  | 'bundle_other'
  | 'changed'

type Selection =
  | { type: 'apk'; path: string }
  | { type: 'bundle'; bundlePath: string }
  | { type: 'bundle-node'; bundlePath: string; nodeId: string }
  | { type: 'bundle-resource'; bundlePath: string; resourceId: string }

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string

interface MetaFieldItem {
  label: string
  value: string
}

type MetaBlock =
  | { type: 'fields'; items: MetaFieldItem[] }
  | { type: 'note'; value: string }

interface AppShellProps {
  project: ProjectState | null
  tools: ToolStatus
  logs: ActivityLogItem[]
  isLoading: boolean
  busyAction?: string | null
  onChooseApk: () => Promise<unknown>
  onExtract: () => Promise<unknown>
  onRefreshManifest: () => Promise<unknown>
  onReplaceApkEntry: (targetPath: string, sourcePath: string) => Promise<unknown>
  onBuildApk: () => Promise<unknown>
  onSignApk: () => Promise<unknown>
  onExtractAllBundles: () => Promise<unknown>
  onChooseReplacementFile: () => Promise<string | null | undefined>
  onOpenPath: (path: string) => Promise<unknown>
  onInvalidateBundleResources: () => void
}

const groups: Array<{
  id: GroupId
  labelKey: string
  icon: typeof Boxes
  match?: (entry: Entry) => boolean
  bundleGroup?: '' | 'image' | 'text' | 'audio' | 'other'
}> = [
  { id: 'all', labelKey: 'labels.all', icon: Boxes },
  { id: 'assets', labelKey: 'labels.assets', icon: FolderOpen, match: (entry) => entry.path.startsWith('assets/') },
  { id: 'res', labelKey: 'labels.res', icon: FolderOpen, match: (entry) => entry.path.startsWith('res/') },
  { id: 'lib', labelKey: 'labels.lib', icon: FolderOpen, match: (entry) => entry.path.startsWith('lib/') },
  { id: 'classes', labelKey: 'labels.classes', icon: FileCode2, match: (entry) => entry.path.endsWith('.dex') },
  { id: 'meta', labelKey: 'labels.metaInf', icon: BadgeInfo, match: (entry) => entry.path.startsWith('META-INF/') },
  { id: 'images', labelKey: 'labels.images', icon: ImageIcon, match: (entry) => entry.kind === 'image' },
  { id: 'texts', labelKey: 'labels.texts', icon: FileText, match: (entry) => entry.kind === 'text' },
  { id: 'bundles', labelKey: 'labels.bundles', icon: FileArchive, match: (entry) => entry.kind === 'bundle' },
  { id: 'bundle_resources', labelKey: 'labels.bundleResources', icon: Boxes, bundleGroup: '' },
  { id: 'bundle_images', labelKey: 'labels.bundleImages', icon: FileImage, bundleGroup: 'image' },
  { id: 'bundle_texts', labelKey: 'labels.bundleTexts', icon: FileText, bundleGroup: 'text' },
  { id: 'bundle_audio', labelKey: 'labels.bundleAudio', icon: FileAudio2, bundleGroup: 'audio' },
  { id: 'bundle_other', labelKey: 'labels.bundleOther', icon: ListFilter, bundleGroup: 'other' },
  { id: 'changed', labelKey: 'labels.changedOnly', icon: Replace, match: (entry) => entry.changed },
]

const detailKeyMap: Record<string, string> = {
  '名称': 'name',
  '路径': 'path',
  '类型': 'type',
  '大小': 'size',
  'crc': 'crc',
  '压缩方式': 'compression_method',
  'unity 类型': 'unity_type',
  '预览类型': 'preview_type',
  'classid': 'class_id',
  'pathid': 'path_id',
  '节点': 'node',
  '导出文件': 'export_file',
  '可替换': 'replaceable',
  '已替换': 'changed',
  'addressables': 'addressables',
  'bundle 总数': 'bundle_count',
  'texture_width': 'texture_width',
  'texture_height': 'texture_height',
  'texture_format': 'texture_format',
  'mip_count': 'mip_count',
  'readable': 'readable',
  'image_data_size': 'image_data_size',
  'stream_size': 'stream_size',
  'stream_offset': 'stream_offset',
  'stream_path': 'stream_path',
  'file_size': 'file_size',
  'compression': 'compression',
  'engine_version': 'engine_version',
  'node_count': 'node_count',
  'resource_count': 'resource_count',
}

const detailValueMap: Record<string, string> = {
  image: 'detailValues.image',
  text: 'detailValues.text',
  binary: 'detailValues.binary',
  audio: 'detailValues.audio',
  bundle: 'detailValues.bundle',
  other: 'detailValues.other',
}

function normalizeDetailKey(value: string) {
  return value.trim().replaceAll('：', ':').toLowerCase().replace(/\s+/g, ' ')
}

function translateDetailLabel(rawLabel: string, t: TranslateFn) {
  const directKey = normalizeDetailKey(rawLabel)
  const snakeKey = directKey.replaceAll(' ', '_')
  const translationKey = detailKeyMap[directKey] ?? detailKeyMap[snakeKey]
  return translationKey ? t(`detailKeys.${translationKey}`, { defaultValue: rawLabel.trim() }) : rawLabel.trim()
}

function translateDetailValue(rawValue: string, t: TranslateFn) {
  const value = rawValue.trim() || '-'
  const normalized = value.toLowerCase()
  if (normalized === '是' || normalized === 'yes' || normalized === 'true') {
    return t('common.yes')
  }
  if (normalized === '否' || normalized === 'no' || normalized === 'false') {
    return t('common.no')
  }
  const translationKey = detailValueMap[normalized]
  return translationKey ? t(translationKey, { defaultValue: value }) : value
}

function parseMetaBlock(segment: string, t: TranslateFn): MetaFieldItem | null {
  const normalized = segment.trim()
  if (!normalized) {
    return null
  }
  const colonIndex = Math.max(normalized.indexOf(':'), normalized.indexOf('：'))
  if (colonIndex < 0) {
    return null
  }
  const label = normalized.slice(0, colonIndex).trim()
  const value = normalized.slice(colonIndex + 1).trim()
  if (!label) {
    return null
  }
  return {
    label: translateDetailLabel(label, t),
    value: translateDetailValue(value, t),
  }
}

function parseMetaContent(value: string, t: TranslateFn): MetaBlock[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const items = line
        .split('|')
        .map((part) => parseMetaBlock(part, t))
        .filter((item): item is MetaFieldItem => Boolean(item))
      if (items.length > 0) {
        return { type: 'fields', items } satisfies MetaBlock
      }
      return { type: 'note', value: line } satisfies MetaBlock
    })
}

export function AppShell({
  project,
  tools,
  logs,
  isLoading,
  busyAction,
  onChooseApk,
  onExtract,
  onRefreshManifest,
  onReplaceApkEntry,
  onBuildApk,
  onSignApk,
  onExtractAllBundles,
  onChooseReplacementFile,
  onOpenPath,
  onInvalidateBundleResources,
}: AppShellProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<GroupId>('all')
  const [selection, setSelection] = useState<Selection | null>(null)

  const entries = project?.manifest?.entries ?? []
  const groupDef = groups.find((item) => item.id === group) ?? groups[0]
  const isBundleResourceMode = group.startsWith('bundle_')
  const bundleGroup = groupDef.bundleGroup

  const bundleResourceQuery = useBundleResourceList(bundleGroup, isBundleResourceMode ? query : '', isBundleResourceMode)
  const bundleResources = bundleResourceQuery.data ?? []
  const bundleResourceCounts = useBundleResourceCounts(Boolean(project?.manifest))

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (entry.is_dir) {
        return false
      }
      if (groupDef.match && !groupDef.match(entry)) {
        return false
      }
      if (!normalized) {
        return true
      }
      return (
        entry.path.toLowerCase().includes(normalized) ||
        entry.kind.toLowerCase().includes(normalized) ||
        entry.name.toLowerCase().includes(normalized)
      )
    })
  }, [entries, groupDef, query])

  useEffect(() => {
    if (!selection) {
      return
    }
    if (selection.type === 'apk') {
      const exists = filteredEntries.some((entry) => entry.path === selection.path)
      if (!exists && filteredEntries.length > 0 && !isBundleResourceMode) {
        setSelection({ type: 'apk', path: filteredEntries[0].path })
      }
    }
  }, [filteredEntries, isBundleResourceMode, selection])

  useEffect(() => {
    if (selection || !project?.manifest) {
      return
    }
    if (isBundleResourceMode) {
      if (bundleResources.length > 0) {
        const item = bundleResources[0]
        setSelection({ type: 'bundle-resource', bundlePath: item.bundle_path, resourceId: item.resource.id })
      }
      return
    }
    if (filteredEntries.length > 0) {
      const first = filteredEntries[0]
      setSelection(first.kind === 'bundle' ? { type: 'bundle', bundlePath: first.path } : { type: 'apk', path: first.path })
    }
  }, [bundleResources, filteredEntries, isBundleResourceMode, project?.manifest, selection])

  const selectedEntry = useMemo(() => {
    if (!selection || selection.type !== 'apk') {
      return null
    }
    return entries.find((entry) => entry.path === selection.path) ?? null
  }, [entries, selection])

  const selectedBundlePath = useMemo(() => {
    if (!selection) {
      return null
    }
    if (selection.type === 'bundle') {
      return selection.bundlePath
    }
    if (selection.type === 'bundle-node' || selection.type === 'bundle-resource') {
      return selection.bundlePath
    }
    const entry = entries.find((item) => item.path === selection.path)
    return entry?.kind === 'bundle' ? entry.path : null
  }, [entries, selection])

  const selectedBundleEntry = useMemo(() => {
    if (!selectedBundlePath) {
      return null
    }
    return entries.find((entry) => entry.path === selectedBundlePath) ?? null
  }, [entries, selectedBundlePath])

  const apkPreview = useApkPreview(selection?.type === 'apk' ? selection.path : undefined)
  const bundleManifestQuery = useBundleManifest(selectedBundlePath ?? undefined)
  const bundleNodePreview = useBundleNodePreview(
    selection?.type === 'bundle-node' ? selection.bundlePath : undefined,
    selection?.type === 'bundle-node' ? selection.nodeId : undefined,
  )
  const bundleResourcePreview = useBundleResourcePreview(
    selection?.type === 'bundle-resource' ? selection.bundlePath : undefined,
    selection?.type === 'bundle-resource' ? selection.resourceId : undefined,
  )
  const bundleActions = useBundleActions(selectedBundlePath ?? undefined)

  const bundleManifest = bundleManifestQuery.data ?? null

  const selectedBundleNode = useMemo(() => {
    if (!bundleManifest || selection?.type !== 'bundle-node') {
      return null
    }
    return bundleManifest.nodes.find((node) => node.id === selection.nodeId) ?? null
  }, [bundleManifest, selection])

  const selectedBundleResource = useMemo(() => {
    if (!bundleManifest || !selection || selection.type !== 'bundle-resource') {
      return null
    }
    return bundleManifest.resources.find((resource) => resource.id === selection.resourceId) ?? null
  }, [bundleManifest, selection])

  const busyText = busyAction ? t(`busy.${busyAction}` as never, { defaultValue: busyAction }) : t('status.ready')

  const counts = useMemo(() => {
    const out = new Map<GroupId, number>()
    for (const item of groups) {
      if (item.bundleGroup !== undefined) {
        const count =
          item.bundleGroup === ''
            ? bundleResourceCounts.all
            : item.bundleGroup === 'image'
              ? bundleResourceCounts.image
              : item.bundleGroup === 'text'
                ? bundleResourceCounts.text
                : item.bundleGroup === 'audio'
                  ? bundleResourceCounts.audio
                  : bundleResourceCounts.other
        out.set(item.id, count)
      } else {
        const count = entries.filter((entry) => !entry.is_dir && (!item.match || item.match(entry))).length
        out.set(item.id, count)
      }
    }
    return out
  }, [bundleResourceCounts.all, bundleResourceCounts.audio, bundleResourceCounts.image, bundleResourceCounts.other, bundleResourceCounts.text, entries])

  async function handleReplaceApk(entry: Entry) {
    const sourcePath = await onChooseReplacementFile()
    if (!sourcePath) {
      return
    }
    await onReplaceApkEntry(entry.path, sourcePath)
    if (entry.kind === 'bundle') {
      onInvalidateBundleResources()
    }
  }

  async function handleReplaceBundleNode(node: BundleNode) {
    if (!selectedBundlePath) {
      return
    }
    const sourcePath = await onChooseReplacementFile()
    if (!sourcePath) {
      return
    }
    await bundleActions.replaceNode({ nodeId: node.id, sourcePath })
  }

  async function handleReplaceBundleResource(resource: BundleResource) {
    if (!selectedBundlePath) {
      return
    }
    const sourcePath = await onChooseReplacementFile()
    if (!sourcePath) {
      return
    }
    await bundleActions.replaceResource({ resourceId: resource.id, sourcePath })
  }

  async function handleExtractBundle(force = true) {
    if (!selectedBundlePath) {
      return
    }
    await bundleActions.extract(force)
  }

  async function handleBuildBundle() {
    if (!selectedBundlePath) {
      return
    }
    await bundleActions.build()
  }

  async function handleExtractAllBundles() {
    await onExtractAllBundles()
    setGroup('bundle_resources')
    setQuery('')
    setSelection(null)
  }

  function handleJumpToBundle(item: BundleResourceSummary) {
    setGroup('bundles')
    setQuery('')
    setSelection({ type: 'bundle', bundlePath: item.bundle_path })
  }

  return (
    <div className="h-full overflow-hidden bg-background">
      <div className="mx-auto grid h-full max-w-[1840px] grid-rows-[auto_minmax(0,1fr)_120px] gap-3 px-3 py-3 lg:px-4">
        <header>
          <Card className="overflow-hidden">
            <CardContent className="flex flex-col gap-2.5 px-4 py-3">
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
                  <CardDescription className="text-[11px] leading-5">
                    {tools.summary}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <ToolbarButton icon={FolderOpen} label={t('actions.chooseApk')} onClick={() => void onChooseApk()} disabled={isLoading} size="sm" />
                  <ToolbarButton
                    icon={FolderArchive}
                    label={t('actions.extract')}
                    onClick={() => void onExtract()}
                    disabled={isLoading || !project}
                    size="sm"
                  />
                  <ToolbarButton
                    icon={RefreshCcw}
                    label={t('actions.refresh')}
                    onClick={() => void onRefreshManifest()}
                    disabled={isLoading || !project?.manifest}
                    variant="outline"
                    size="sm"
                  />
                  <ToolbarButton
                    icon={PackageOpen}
                    label={t('actions.extractAllBundles')}
                    onClick={() => void handleExtractAllBundles()}
                    disabled={isLoading || !project?.manifest}
                    variant="secondary"
                    size="sm"
                  />
                  <ToolbarButton
                    icon={Hammer}
                    label={t('actions.buildApk')}
                    onClick={() => void onBuildApk()}
                    disabled={isLoading || !project?.manifest}
                    variant="outline"
                    size="sm"
                  />
                  <ToolbarButton
                    icon={ShieldCheck}
                    label={t('actions.signApk')}
                    onClick={() => void onSignApk()}
                    disabled={isLoading || !project?.manifest}
                    variant="outline"
                    size="sm"
                  />
                  <ToolbarButton
                    icon={FolderOpen}
                    label={t('actions.openDist')}
                    onClick={() => void onOpenPath(project?.dist_dir ?? '')}
                    disabled={!project?.dist_dir}
                    variant="ghost"
                    size="sm"
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
            </CardContent>
          </Card>
        </header>

        <section className="grid min-h-0 gap-3 xl:grid-cols-[180px_minmax(0,1fr)_400px]">
          <Card className="min-h-0 overflow-hidden xl:flex xl:flex-col">
            <CardHeader className="px-3.5 py-2.5">
              <div>
                <CardTitle>{t('sections.resourceTree')}</CardTitle>
                <CardDescription className="text-xs">{t('sections.resourceTreeDesc')}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 px-2.5 pb-2.5">
              <ScrollArea className="h-full pr-0.5">
                <div className="grid gap-1">
                  {groups.map((item) => {
                    const Icon = item.icon
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setGroup(item.id)}
                        className={cn(
                          'grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition',
                          group === item.id ? 'bg-primary text-primary-foreground' : 'bg-white/60 hover:bg-white',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="truncate">{t(item.labelKey)}</span>
                        <span className="text-xs">{counts.get(item.id) ?? 0}</span>
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-h-0 overflow-hidden xl:flex xl:flex-col">
            <CardHeader className="px-3.5 py-2.5">
              <div className="space-y-1">
                <CardTitle>{isBundleResourceMode ? t('sections.bundleResourceList') : t('sections.resourceList')}</CardTitle>
                <CardDescription className="text-xs">
                  {isBundleResourceMode
                    ? `${t('labels.totalCount')}: ${bundleResources.length}`
                    : project?.manifest
                      ? `${t('labels.totalCount')}: ${filteredEntries.length}`
                      : t('empty.noManifest')}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-2.5 px-3.5 pb-3">
              <Input
                className="h-9"
                placeholder={isBundleResourceMode ? t('labels.searchBundleResource') : t('labels.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {isBundleResourceMode ? (
                <BundleResourceTable
                  items={bundleResources}
                  selection={selection}
                  onSelect={(item) => setSelection({ type: 'bundle-resource', bundlePath: item.bundle_path, resourceId: item.resource.id })}
                />
              ) : (
                <ApkEntryTable
                  entries={filteredEntries}
                  selection={selection}
                  onSelect={(entry) =>
                    setSelection(entry.kind === 'bundle' ? { type: 'bundle', bundlePath: entry.path } : { type: 'apk', path: entry.path })
                  }
                />
              )}
            </CardContent>
          </Card>

          <Card className="min-h-0 overflow-hidden xl:flex xl:flex-col">
            <CardHeader className="px-3.5 py-2.5">
              <div>
                <CardTitle>{t('sections.inspector')}</CardTitle>
                <CardDescription className="text-xs">{t('sections.inspectorDesc')}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 px-3.5 pb-3">
              <ScrollArea className="h-full pr-0.5">
                {!selection ? (
                  <EmptyHint>{t('empty.noSelection')}</EmptyHint>
                ) : selection.type === 'apk' && selectedEntry ? (
                  <ApkInspector
                    entry={selectedEntry}
                    preview={apkPreview.data ?? null}
                    onReplace={() => void handleReplaceApk(selectedEntry)}
                  />
                ) : selection.type === 'bundle' && selectedBundleEntry ? (
                  <BundleInspector
                    entry={selectedBundleEntry}
                    manifest={bundleManifest}
                    info={bundleActions.info}
                    error={bundleActions.error ? (bundleActions.error instanceof Error ? bundleActions.error.message : String(bundleActions.error)) : null}
                    onAnalyze={() => void bundleActions.analyze()}
                    onExtract={() => void handleExtractBundle(Boolean(bundleManifest))}
                    onBuild={() => void handleBuildBundle()}
                    onReplaceBundle={() => void handleReplaceApk(selectedBundleEntry)}
                    onSelectNode={(node) => setSelection({ type: 'bundle-node', bundlePath: selectedBundleEntry.path, nodeId: node.id })}
                    onSelectResource={(resource) =>
                      setSelection({ type: 'bundle-resource', bundlePath: selectedBundleEntry.path, resourceId: resource.id })
                    }
                  />
                ) : selection.type === 'bundle-node' && selectedBundleEntry && selectedBundleNode ? (
                  <BundleNodeInspector
                    entry={selectedBundleEntry}
                    node={selectedBundleNode}
                    preview={bundleNodePreview.data ?? null}
                    onBack={() => setSelection({ type: 'bundle', bundlePath: selectedBundleEntry.path })}
                    onReplace={() => void handleReplaceBundleNode(selectedBundleNode)}
                  />
                ) : selection.type === 'bundle-resource' && selectedBundleEntry && selectedBundleResource ? (
                  <BundleResourceInspector
                    entry={selectedBundleEntry}
                    resource={selectedBundleResource}
                    preview={bundleResourcePreview.data ?? null}
                    onBack={() => setSelection({ type: 'bundle', bundlePath: selectedBundleEntry.path })}
                    onReplace={
                      selectedBundleResource.replaceable
                        ? () => void handleReplaceBundleResource(selectedBundleResource)
                        : undefined
                    }
                  />
                ) : selection.type === 'bundle-resource' && !selectedBundleEntry ? (
                  <AggregatedBundleResourceInspector
                    item={
                      bundleResources.find(
                        (item) =>
                          item.bundle_path === selection.bundlePath && item.resource.id === selection.resourceId,
                      ) ?? null
                    }
                    preview={bundleResourcePreview.data ?? null}
                    onJump={handleJumpToBundle}
                    onBuild={() => selectedBundlePath && void bundleActions.build()}
                    onReplaceBundle={() => selectedBundleEntry && void handleReplaceApk(selectedBundleEntry)}
                  />
                ) : (
                  <EmptyHint>{t('empty.noSelection')}</EmptyHint>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </section>

        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="px-3.5 py-2.5">
            <div>
              <CardTitle>{t('sections.activity')}</CardTitle>
              <CardDescription className="text-xs">{t('sections.activityDesc')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 h-full px-3.5 pb-3">
            <ScrollArea className="h-full pr-0.5">
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
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant = 'default',
  size = 'default',
}: {
  icon: typeof FileArchive
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'secondary' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'icon'
}) {
  return (
    <Button onClick={onClick} disabled={disabled} variant={variant} size={size}>
      <Icon className="h-4 w-4" />
      {label}
    </Button>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm leading-7 text-muted-foreground">{children}</p>
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/60 bg-white/70 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

function ApkEntryTable({
  entries,
  selection,
  onSelect,
}: {
  entries: Entry[]
  selection: Selection | null
  onSelect: (entry: Entry) => void
}) {
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_76px_76px_40px] gap-2 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span>Path</span>
        <span>Kind</span>
        <span>Size</span>
        <span>变更</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 pr-1">
        <div className="grid gap-1">
          {entries.map((entry) => {
            const active =
              (selection?.type === 'apk' && selection.path === entry.path) ||
              (selection?.type === 'bundle' && selection.bundlePath === entry.path)
            return (
              <button
                key={entry.path}
                type="button"
                className={cn(
                  'grid grid-cols-[minmax(0,1fr)_76px_76px_40px] gap-2 rounded-md border px-2.5 py-1.5 text-left transition',
                  active ? 'border-primary bg-sky-50/90' : 'border-white/60 bg-white/55 hover:bg-white/85',
                )}
                onClick={() => onSelect(entry)}
              >
                <div className="truncate text-sm font-medium">{entry.path}</div>
                <div className="text-xs text-muted-foreground">{entry.kind}</div>
                <div className="text-xs text-muted-foreground">{formatSize(entry.size)}</div>
                <div className="text-xs text-muted-foreground">{entry.changed ? '是' : ''}</div>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </>
  )
}

function BundleResourceTable({
  items,
  selection,
  onSelect,
}: {
  items: BundleResourceSummary[]
  selection: Selection | null
  onSelect: (item: BundleResourceSummary) => void
}) {
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1.25fr)_72px_72px_minmax(0,0.9fr)_40px] gap-2 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span>Resource</span>
        <span>Kind</span>
        <span>Size</span>
        <span>Bundle</span>
        <span>变更</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 pr-1">
        <div className="grid gap-1">
          {items.map((item) => {
            const active =
              selection?.type === 'bundle-resource' &&
              selection.bundlePath === item.bundle_path &&
              selection.resourceId === item.resource.id
            return (
              <button
                key={`${item.bundle_path}:${item.resource.id}`}
                type="button"
                className={cn(
                  'grid grid-cols-[minmax(0,1.25fr)_72px_72px_minmax(0,0.9fr)_40px] gap-2 rounded-md border px-2.5 py-1.5 text-left transition',
                  active ? 'border-primary bg-sky-50/90' : 'border-white/60 bg-white/55 hover:bg-white/85',
                )}
                onClick={() => onSelect(item)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.resource.name || item.resource.type}</div>
                  <div className="truncate text-xs text-muted-foreground">{item.resource.type}</div>
                </div>
                <div className="text-xs text-muted-foreground">{item.resource.kind}</div>
                <div className="text-xs text-muted-foreground">{formatSize(item.resource.size)}</div>
                <div className="truncate text-xs text-muted-foreground">{compactPath(item.bundle_path, 40)}</div>
                <div className="text-xs text-muted-foreground">
                  {item.resource.changed || item.bundle_changed ? '是' : ''}
                </div>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </>
  )
}

function ApkInspector({
  entry,
  preview,
  onReplace,
}: {
  entry: Entry
  preview: PreviewResult | null
  onReplace: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={onReplace} disabled={!entry.replaceable}>
          <Replace className="h-4 w-4" />
          {t('inspector.replaceFile')}
        </Button>
      </div>
      <PreviewPanel preview={preview} />
      <MetaGrid
        items={[
          { label: t('labels.filePath'), value: entry.path, wide: true },
          { label: t('labels.fileType'), value: entry.kind },
          { label: t('labels.fileCrc'), value: entry.crc },
          { label: t('labels.compressedSize'), value: formatSize(entry.compressed) },
          { label: t('labels.compressionMethod'), value: `${entry.method}` },
        ]}
      />
    </div>
  )
}

function BundleInspector({
  entry,
  manifest,
  info,
  error,
  onAnalyze,
  onExtract,
  onBuild,
  onReplaceBundle,
  onSelectNode,
  onSelectResource,
}: {
  entry: Entry
  manifest: BundleManifest | null
  info: { node_count?: number; resource_count?: number; compression?: string; engine_version?: string } | null
  error: string | null
  onAnalyze: () => void
  onExtract: () => void
  onBuild: () => void
  onReplaceBundle: () => void
  onSelectNode: (node: BundleNode) => void
  onSelectResource: (resource: BundleResource) => void
}) {
  const { t } = useTranslation()
  const summary = manifest?.info ?? info
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onAnalyze}>
          <FileSearch className="h-4 w-4" />
          {t('inspector.analyzeBundle')}
        </Button>
        <Button onClick={onExtract}>
          <PackageOpen className="h-4 w-4" />
          {t('inspector.extractBundle')}
        </Button>
        <Button variant="outline" onClick={onBuild} disabled={!manifest}>
          <PackageCheck className="h-4 w-4" />
          {t('inspector.buildBundle')}
        </Button>
        <Button variant="outline" onClick={onReplaceBundle}>
          <Replace className="h-4 w-4" />
          {t('inspector.replaceBundle')}
        </Button>
      </div>
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      <MetaGrid
        items={[
          { label: t('labels.bundlePath'), value: entry.path, wide: true },
          {
            label: t('labels.bundleInfo'),
            value: summary
              ? `格式: ${summary.compression ?? '-'} / Unity ${summary.engine_version ?? '-'} | 节点: ${summary.node_count ?? 0} | 资源: ${summary.resource_count ?? 0}`
              : t('inspector.summaryPending'),
            wide: true,
          },
        ]}
      />
      {!manifest ? (
        <EmptyHint>{t('inspector.noBundleManifest')}</EmptyHint>
      ) : (
        <>
          <SubSection title={t('inspector.bundleNodes')}>
            <div className="grid gap-2">
              {manifest.nodes.slice(0, 24).map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node)}
                  className="grid grid-cols-[minmax(0,1fr)_72px_72px_36px] gap-3 rounded-md border border-white/60 bg-white/55 px-3 py-2 text-left hover:bg-white/85"
                >
                  <span className="truncate text-sm font-medium">{compactPath(node.path, 52)}</span>
                  <span className="text-xs text-muted-foreground">{node.kind}</span>
                  <span className="text-xs text-muted-foreground">{formatSize(node.size)}</span>
                  <span className="text-xs text-muted-foreground">{node.changed ? t('inspector.yes') : ''}</span>
                </button>
              ))}
            </div>
          </SubSection>
          <SubSection title={t('inspector.bundleResources')}>
            <div className="grid gap-2">
              {manifest.resources.slice(0, 24).map((resource) => (
                <button
                  key={resource.id}
                  type="button"
                  onClick={() => onSelectResource(resource)}
                  className="grid grid-cols-[minmax(0,1fr)_84px_72px_36px] gap-3 rounded-md border border-white/60 bg-white/55 px-3 py-2 text-left hover:bg-white/85"
                >
                  <span className="truncate text-sm font-medium">{resource.name || resource.type}</span>
                  <span className="text-xs text-muted-foreground">{resource.kind}</span>
                  <span className="text-xs text-muted-foreground">{formatSize(resource.size)}</span>
                  <span className="text-xs text-muted-foreground">{resource.changed ? t('inspector.yes') : ''}</span>
                </button>
              ))}
            </div>
          </SubSection>
        </>
      )}
    </div>
  )
}

function BundleNodeInspector({
  entry,
  node,
  preview,
  onBack,
  onReplace,
}: {
  entry: Entry
  node: BundleNode
  preview: PreviewResult | null
  onBack: () => void
  onReplace: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onBack}>
          {t('inspector.backToBundle')}
        </Button>
        <Button onClick={onReplace}>
          <Replace className="h-4 w-4" />
          {t('inspector.replaceNode')}
        </Button>
      </div>
      <PreviewPanel preview={preview} />
      <MetaGrid
        items={[
          { label: t('labels.bundlePath'), value: entry.path, wide: true },
          { label: t('labels.nodePath'), value: node.path, wide: true },
          { label: t('labels.nodeType'), value: node.kind },
          { label: t('labels.fileCrc'), value: node.crc || '-' },
        ]}
      />
    </div>
  )
}

function BundleResourceInspector({
  entry,
  resource,
  preview,
  onBack,
  onReplace,
}: {
  entry: Entry
  resource: BundleResource
  preview: PreviewResult | null
  onBack: () => void
  onReplace?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onBack}>
          {t('inspector.backToBundle')}
        </Button>
        {onReplace ? (
          <Button onClick={onReplace}>
            <Replace className="h-4 w-4" />
            {t('inspector.replaceResource')}
          </Button>
        ) : null}
      </div>
      <PreviewPanel preview={preview} />
      <MetaGrid
        items={[
          { label: t('labels.bundlePath'), value: entry.path, wide: true },
          { label: t('labels.resourceName'), value: resource.name || resource.type, wide: true },
          { label: t('labels.resourceType'), value: `${resource.type} / ${resource.kind}` },
          { label: t('labels.resourceNode'), value: resource.node_path },
        ]}
      />
    </div>
  )
}

function AggregatedBundleResourceInspector({
  item,
  preview,
  onJump,
  onBuild,
  onReplaceBundle,
}: {
  item: BundleResourceSummary | null
  preview: PreviewResult | null
  onJump: (item: BundleResourceSummary) => void
  onBuild: () => void
  onReplaceBundle: () => void
}) {
  const { t } = useTranslation()
  if (!item) {
    return <EmptyHint>{t('inspector.unsupportedResource')}</EmptyHint>
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => onJump(item)}>
          {t('inspector.jumpToBundle')}
        </Button>
        <Button variant="outline" onClick={onBuild}>
          {t('inspector.buildBundle')}
        </Button>
        <Button variant="outline" onClick={onReplaceBundle}>
          {t('inspector.replaceBundle')}
        </Button>
      </div>
      <PreviewPanel preview={preview} />
      <MetaGrid
        items={[
          { label: t('labels.bundlePath'), value: item.bundle_path, wide: true },
          { label: t('labels.resourceName'), value: item.resource.name || item.resource.type, wide: true },
          { label: t('labels.resourceType'), value: `${item.resource.type} / ${item.resource.kind}` },
        ]}
      />
    </div>
  )
}

function PreviewPanel({ preview }: { preview: PreviewResult | null }) {
  const { t } = useTranslation()
  if (!preview) {
    return <EmptyHint>{t('inspector.noPreview')}</EmptyHint>
  }
  return (
    <div className="space-y-3">
      {preview.image_data_url ? (
        <div className="overflow-hidden rounded-md border border-white/60 bg-white/70">
          <div className="border-b border-white/60 px-3 py-2 text-xs font-medium text-muted-foreground">
            {preview.title}
          </div>
          <img src={preview.image_data_url} alt={preview.title} className="max-h-[320px] w-full object-contain" />
        </div>
      ) : null}
      {preview.audio_data_url ? (
        <div className="overflow-hidden rounded-md border border-slate-300/90 bg-white/80 shadow-sm">
          <div className="border-b border-slate-300/90 px-3 py-2 text-xs font-medium text-muted-foreground">
            {t('inspector.previewAudio')}
          </div>
          <div className="p-3">
            <audio key={`${preview.title}:${preview.audio_data_url}`} controls preload="metadata" className="w-full">
              <source src={preview.audio_data_url} />
            </audio>
          </div>
        </div>
      ) : null}
      {preview.text ? (
        <div className="overflow-hidden rounded-md border border-slate-300/90 bg-white/80 shadow-sm">
          <div className="border-b border-slate-300/90 px-3 py-2 text-xs font-medium text-muted-foreground">
            {preview.mode === 'text' ? t('inspector.previewText') : t('inspector.previewContent')}
          </div>
          <pre className="max-h-[360px] overflow-auto p-3 text-xs leading-6 text-foreground whitespace-pre-wrap break-all">
            {preview.text}
          </pre>
        </div>
      ) : null}
      <MetaGrid
        items={[
          ...(preview.file_path ? [{ label: t('labels.previewFile'), value: preview.file_path, wide: true }] : []),
        ]}
      />
      {preview.summary ? <MetaDetailsList title={t('labels.summary')} value={preview.summary} /> : null}
    </div>
  )
}

function MetaGrid({
  items,
}: {
  items: Array<{ label: string; value: string; wide?: boolean }>
}) {
  const filtered = items.filter((item) => item.value && item.value.trim().length > 0)
  if (filtered.length === 0) {
    return null
  }
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {filtered.map((item) => (
        <div
          key={`${item.label}:${item.value}`}
          className={cn(
            'rounded-md border border-white/60 bg-white/65 px-3 py-2.5',
            item.wide ? 'md:col-span-2' : '',
          )}
        >
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{item.label}</div>
          <div className="mt-1 break-all text-sm leading-6 text-foreground">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function MetaDetailsList({ title, value }: { title: string; value: string }) {
  const { t } = useTranslation()
  const blocks = useMemo(() => parseMetaContent(value, t), [t, value])
  if (blocks.length === 0) {
    return null
  }
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{title}</div>
      <div className="space-y-2">
        {blocks.map((block, index) =>
          block.type === 'note' ? (
            <div key={`${title}:note:${index}`} className="rounded-md border border-white/60 bg-white/65 px-3 py-2.5 text-sm leading-6 text-foreground">
              {block.value}
            </div>
          ) : (
            <div
              key={`${title}:fields:${index}`}
              className="overflow-hidden rounded-md border border-white/60 bg-white/65"
            >
              <div className="divide-y divide-white/70">
                {block.items.map((item) => (
                  <div key={`${item.label}:${item.value}`} className="px-3 py-2.5">
                    <div className="text-[11px] text-muted-foreground">{item.label}</div>
                    <div className="mt-1 break-all text-sm leading-6 text-foreground">{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {children}
    </div>
  )
}
