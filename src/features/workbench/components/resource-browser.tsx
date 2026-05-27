import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { WorkbenchIcon } from '@/features/workbench/components/workbench-icons'
import type {
  BundleManifest,
  BundleNode,
  BundleResource,
  BundleResourceSummary,
  Entry,
} from '@/shared/types/workspace'
import {
  type BundleBrowserTab,
  type FilterChip as FilterChipType,
  type GroupId,
  type Selection,
  iconNameForKind,
  isBundleSummaryGroup,
} from '@/features/workbench/lib/workbench'
import { cn, compactPath, formatSize } from '@/shared/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { ScrollArea } from '@/shared/ui/scroll-area'
import { FilterChip, SegmentedTabs } from '@/shared/ui/tabs'

const LIST_ROW_HEIGHT = 64
const LIST_OVERSCAN = 8

export function ResourceBrowser({
  group,
  query,
  filters,
  selection,
  entries,
  bundleResources,
  bundleManifest,
  bundleTab,
  currentBundlePath,
  onQueryChange,
  onToggleFilter,
  onSelectEntry,
  onSelectBundleResourceSummary,
  onBundleTabChange,
  onSelectBundleNode,
  onSelectBundleResource,
  onJumpBundle,
}: {
  group: GroupId
  query: string
  filters: Set<FilterChipType>
  selection: Selection | null
  entries: Entry[]
  bundleResources: BundleResourceSummary[]
  bundleManifest: BundleManifest | null
  bundleTab: BundleBrowserTab
  currentBundlePath: string | null
  onQueryChange: (value: string) => void
  onToggleFilter: (filter: FilterChipType) => void
  onSelectEntry: (entry: Entry) => void
  onSelectBundleResourceSummary: (item: BundleResourceSummary) => void
  onBundleTabChange: (tab: BundleBrowserTab) => void
  onSelectBundleNode: (node: BundleNode) => void
  onSelectBundleResource: (resource: BundleResource) => void
  onJumpBundle: (bundlePath: string) => void
}) {
  const { t } = useTranslation()
  const bundleSummaryMode = isBundleSummaryGroup(group)
  const bundleMode = Boolean(currentBundlePath && !bundleSummaryMode)

  const title = bundleMode
    ? t('labels.bundleTab')
    : bundleSummaryMode
      ? t('sections.bundleResourceList')
      : t('sections.resourceList')

  const count = bundleMode
    ? bundleTab === 'resources'
      ? bundleManifest?.resources.length ?? 0
      : bundleManifest?.nodes.length ?? 0
    : bundleSummaryMode
      ? bundleResources.length
      : entries.length

  const searchPlaceholder = bundleSummaryMode
    ? t('labels.searchBundleResource')
    : t('labels.search')

  const canShowFilters = !bundleSummaryMode

  const filteredBundleNodes = useMemo(() => {
    if (!bundleManifest) {
      return []
    }
    const normalized = query.trim().toLowerCase()
    return bundleManifest.nodes.filter((node) => {
      if (filters.has('changed') && !node.changed) {
        return false
      }
      if (!normalized) {
        return true
      }
      return [node.path, node.name, node.kind, node.file_name].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [bundleManifest, filters, query])

  const filteredBundleResources = useMemo(() => {
    if (!bundleManifest) {
      return []
    }
    const normalized = query.trim().toLowerCase()
    return bundleManifest.resources.filter((resource) => {
      if (filters.has('replaceable') && !resource.replaceable) {
        return false
      }
      if (filters.has('changed') && !resource.changed) {
        return false
      }
      if (filters.has('image') && resource.kind !== 'image') {
        return false
      }
      if (filters.has('text') && resource.kind !== 'text') {
        return false
      }
      if (!normalized) {
        return true
      }
      return [
        resource.name,
        resource.type,
        resource.kind,
        resource.node_path,
        resource.file_name,
      ].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [bundleManifest, filters, query])

  return (
    <Card className="min-h-0 overflow-hidden xl:flex xl:flex-col">
      <CardHeader className="px-3.5 py-2.5">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription className="text-xs">{`${t('labels.totalCount')}: ${count}`}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2.5 px-3.5 pb-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-9 flex-1" placeholder={searchPlaceholder} value={query} onChange={(event) => onQueryChange(event.target.value)} />
            {bundleMode ? (
              <SegmentedTabs
                value={bundleTab}
                onChange={(value) => onBundleTabChange(value as BundleBrowserTab)}
                items={[
                  { value: 'resources', label: t('inspector.resourcesTab') },
                  { value: 'nodes', label: t('inspector.nodesTab') },
                ]}
              />
            ) : null}
          </div>
          {canShowFilters ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('inspector.filters')}</span>
              <FilterChip active={filters.has('replaceable')} onClick={() => onToggleFilter('replaceable')}>
                {t('labels.replaceableOnly')}
              </FilterChip>
              <FilterChip active={filters.has('changed')} onClick={() => onToggleFilter('changed')}>
                {t('labels.changedOnlyChip')}
              </FilterChip>
              <FilterChip active={filters.has('image')} onClick={() => onToggleFilter('image')}>
                {t('labels.imageOnly')}
              </FilterChip>
              <FilterChip active={filters.has('text')} onClick={() => onToggleFilter('text')}>
                {t('labels.textOnly')}
              </FilterChip>
            </div>
          ) : null}
        </div>

        {bundleMode ? (
          bundleTab === 'resources' ? (
            <BundleResourceList
              items={filteredBundleResources}
              selection={selection}
              onSelect={onSelectBundleResource}
              emptyText={t('inspector.noBundleResources')}
            />
          ) : (
            <BundleNodeList
              items={filteredBundleNodes}
              selection={selection}
              onSelect={onSelectBundleNode}
              emptyText={t('inspector.noBundleNodes')}
            />
          )
        ) : bundleSummaryMode ? (
          <BundleSummaryList
            items={bundleResources}
            selection={selection}
            onSelect={onSelectBundleResourceSummary}
            onJumpBundle={onJumpBundle}
          />
        ) : (
          <ApkEntryList entries={entries} selection={selection} onSelect={onSelectEntry} />
        )}
      </CardContent>
    </Card>
  )
}

function ApkEntryList({
  entries,
  selection,
  onSelect,
}: {
  entries: Entry[]
  selection: Selection | null
  onSelect: (entry: Entry) => void
}) {
  const { t } = useTranslation()

  if (entries.length === 0) {
    return <EmptyList text={t('empty.noBrowserItems')} />
  }

  return (
    <VirtualList
      items={entries}
      itemHeight={LIST_ROW_HEIGHT}
      renderItem={(entry) => {
          const active =
            (selection?.type === 'apk' && selection.path === entry.path) ||
            (selection?.type === 'bundle' && selection.bundlePath === entry.path)
        return (
          <button
            key={entry.path}
            type="button"
            className={cn(
              'grid h-[56px] grid-cols-[32px_minmax(0,1fr)_72px_72px_auto] items-center gap-3 rounded-md border px-3 py-2 text-left transition',
              active ? 'border-primary bg-sky-50/90' : 'border-white/60 bg-white/55 hover:bg-white/85',
            )}
            onClick={() => onSelect(entry)}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/80">
              <WorkbenchIcon name={iconNameForKind(entry.kind) as never} className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{entry.name}</div>
              <div className="truncate text-xs text-muted-foreground">{entry.path}</div>
            </div>
            <div className="text-xs text-muted-foreground">{entry.kind}</div>
            <div className="text-xs text-muted-foreground">{formatSize(entry.size)}</div>
            <div className="flex flex-col items-end gap-1">
              {entry.replaceable ? <StateTag text="R" active /> : <StateTag text="R" />}
              {entry.changed ? <StateTag text={t('common.yes')} active /> : <StateTag text={t('common.no')} />}
            </div>
          </button>
        )
      }}
    />
  )
}

function BundleSummaryList({
  items,
  selection,
  onSelect,
  onJumpBundle,
}: {
  items: BundleResourceSummary[]
  selection: Selection | null
  onSelect: (item: BundleResourceSummary) => void
  onJumpBundle: (bundlePath: string) => void
}) {
  const { t } = useTranslation()

  if (items.length === 0) {
    return <EmptyList text={t('empty.noBrowserItems')} />
  }

  return (
    <VirtualList
      items={items}
      itemHeight={LIST_ROW_HEIGHT}
      renderItem={(item) => {
          const active =
            selection?.type === 'bundle-resource' &&
            selection.bundlePath === item.bundle_path &&
            selection.resourceId === item.resource.id
        return (
          <div
            key={`${item.bundle_path}:${item.resource.id}`}
            className={cn(
              'grid h-[56px] grid-cols-[32px_minmax(0,1fr)_72px_72px_auto] items-center gap-3 rounded-md border px-3 py-2 transition',
              active ? 'border-primary bg-sky-50/90' : 'border-white/60 bg-white/55',
            )}
          >
            <button type="button" className="contents text-left" onClick={() => onSelect(item)}>
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/80">
                <WorkbenchIcon name={iconNameForKind(item.resource.kind) as never} className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{item.resource.name || item.resource.type}</div>
                <div className="truncate text-xs text-muted-foreground">{compactPath(item.bundle_path, 48)}</div>
              </div>
              <div className="text-xs text-muted-foreground">{item.resource.kind}</div>
              <div className="text-xs text-muted-foreground">{formatSize(item.resource.size)}</div>
            </button>
            <button
              type="button"
              onClick={() => onJumpBundle(item.bundle_path)}
              className="inline-flex items-center gap-1 text-xs text-primary"
            >
              {t('actions.locateBundle')}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      }}
    />
  )
}

function BundleResourceList({
  items,
  selection,
  onSelect,
  emptyText,
}: {
  items: BundleResource[]
  selection: Selection | null
  onSelect: (resource: BundleResource) => void
  emptyText: string
}) {
  if (items.length === 0) {
    return <EmptyList text={emptyText} />
  }

  return (
    <VirtualList
      items={items}
      itemHeight={LIST_ROW_HEIGHT}
      renderItem={(resource) => {
          const active =
            selection?.type === 'bundle-resource' &&
            selection.resourceId === resource.id
        return (
          <button
            key={resource.id}
            type="button"
            className={cn(
              'grid h-[56px] grid-cols-[32px_minmax(0,1fr)_84px_72px_auto] items-center gap-3 rounded-md border px-3 py-2 text-left transition',
              active ? 'border-primary bg-sky-50/90' : 'border-white/60 bg-white/55 hover:bg-white/85',
            )}
            onClick={() => onSelect(resource)}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/80">
              <WorkbenchIcon name={iconNameForKind(resource.kind) as never} className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{resource.name || resource.type}</div>
              <div className="truncate text-xs text-muted-foreground">{resource.node_path}</div>
            </div>
            <div className="text-xs text-muted-foreground">{resource.type}</div>
            <div className="text-xs text-muted-foreground">{formatSize(resource.size)}</div>
            <div className="flex flex-col items-end gap-1">
              {resource.replaceable ? <StateTag text="R" active /> : <StateTag text="R" />}
              {resource.changed ? <StateTag text="C" active /> : <StateTag text="C" />}
            </div>
          </button>
        )
      }}
    />
  )
}

function BundleNodeList({
  items,
  selection,
  onSelect,
  emptyText,
}: {
  items: BundleNode[]
  selection: Selection | null
  onSelect: (node: BundleNode) => void
  emptyText: string
}) {
  if (items.length === 0) {
    return <EmptyList text={emptyText} />
  }

  return (
    <VirtualList
      items={items}
      itemHeight={LIST_ROW_HEIGHT}
      renderItem={(node) => {
          const active = selection?.type === 'bundle-node' && selection.nodeId === node.id
        return (
          <button
            key={node.id}
            type="button"
            className={cn(
              'grid h-[56px] grid-cols-[32px_minmax(0,1fr)_72px_72px_auto] items-center gap-3 rounded-md border px-3 py-2 text-left transition',
              active ? 'border-primary bg-sky-50/90' : 'border-white/60 bg-white/55 hover:bg-white/85',
            )}
            onClick={() => onSelect(node)}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/80">
              <WorkbenchIcon name={iconNameForKind(node.kind) as never} className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{node.name}</div>
              <div className="truncate text-xs text-muted-foreground">{node.path}</div>
            </div>
            <div className="text-xs text-muted-foreground">{node.kind}</div>
            <div className="text-xs text-muted-foreground">{formatSize(node.size)}</div>
            <div className="flex items-center justify-end">
              {node.changed ? <CheckCircle2 className="h-4 w-4 text-primary" /> : null}
            </div>
          </button>
        )
      }}
    />
  )
}

function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
}: {
  items: T[]
  itemHeight: number
  renderItem: (item: T, index: number) => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }

    const updateHeight = () => setViewportHeight(node.clientHeight)
    updateHeight()

    const observer = new ResizeObserver(() => updateHeight())
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const totalHeight = items.length * itemHeight
  const safeViewportHeight = viewportHeight || itemHeight * 8
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - LIST_OVERSCAN)
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + safeViewportHeight) / itemHeight) + LIST_OVERSCAN,
  )
  const visibleItems = items.slice(startIndex, endIndex)
  const offsetY = startIndex * itemHeight

  return (
    <ScrollArea
      ref={containerRef}
      className="min-h-0 flex-1 pr-1"
      onScroll={(event) => setScrollTop((event.currentTarget as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          className="grid gap-1.5"
          style={{
            position: 'absolute',
            insetInline: 0,
            top: offsetY,
          }}
        >
          {visibleItems.map((item, index) => renderItem(item, startIndex + index))}
        </div>
      </div>
    </ScrollArea>
  )
}

function StateTag({ text, active = false }: { text: string; active?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[22px] items-center justify-center rounded-full border px-1.5 py-0.5 text-[10px]',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-white/70 text-muted-foreground',
      )}
    >
      {text}
    </span>
  )
}

function EmptyList({ text }: { text: string }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">{text}</div>
}
