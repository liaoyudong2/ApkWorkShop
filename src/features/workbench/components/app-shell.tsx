import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ActivityDrawer } from '@/features/workbench/components/activity-drawer'
import { PreviewStudio } from '@/features/workbench/components/preview-studio'
import { ResourceBrowser } from '@/features/workbench/components/resource-browser'
import { WorkbenchHeader } from '@/features/workbench/components/workbench-header'
import { WorkbenchSidebar } from '@/features/workbench/components/workbench-sidebar'
import {
  buildSnapshotMetaFromApkEntry,
  buildSnapshotMetaFromBundleNode,
  buildSnapshotMetaFromBundleResource,
  clonePreviewResult,
  defaultCompareMode,
  findBundleResourceSummary,
  isBundleSummaryGroup,
  isSelectionReplaceable,
  latestReplacementForApk,
  latestReplacementForBundleNode,
  latestReplacementForBundleResource,
  selectionKey,
  type BundleBrowserTab,
  type CompareMode,
  type FilterChip,
  type GroupId,
  type PreviewSnapshot,
  type Selection,
  workbenchGroups,
} from '@/features/workbench/lib/workbench'
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
  BundleResourceSummary,
  Entry,
  PreviewResult,
  ProjectState,
  ToolStatus,
} from '@/shared/types/workspace'
import { Button } from '@/shared/ui/button'

const DEFAULT_GROUP: GroupId = 'all'

function matchApkGroup(entry: Entry, group: GroupId) {
  const def = workbenchGroups.find((item) => item.id === group && item.section === 'apk')
  if (!def || !def.match) {
    return group === 'all'
  }
  return def.match(entry)
}

function matchEntryFilters(entry: Entry, filters: Set<FilterChip>) {
  if (filters.has('replaceable') && !entry.replaceable) {
    return false
  }
  if (filters.has('changed') && !entry.changed) {
    return false
  }
  if (filters.has('image') && entry.kind !== 'image') {
    return false
  }
  if (filters.has('text') && entry.kind !== 'text') {
    return false
  }
  return true
}

function matchEntryQuery(entry: Entry, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  return [entry.name, entry.path, entry.kind].some((value) => value.toLowerCase().includes(normalized))
}

function matchSummaryFilters(item: BundleResourceSummary, filters: Set<FilterChip>) {
  const resource = item.resource
  if (filters.has('replaceable') && !resource.replaceable) {
    return false
  }
  if (filters.has('changed') && !resource.changed && !item.bundle_changed) {
    return false
  }
  if (filters.has('image') && resource.kind !== 'image') {
    return false
  }
  if (filters.has('text') && resource.kind !== 'text') {
    return false
  }
  return true
}

function matchSummaryQuery(item: BundleResourceSummary, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  return [
    item.bundle_path,
    item.bundle_name,
    item.resource.id,
    item.resource.name,
    item.resource.type,
    item.resource.kind,
    item.resource.node_path,
    item.resource.file_name,
  ].some((value) => value.toLowerCase().includes(normalized))
}

export function AppShell({
  project,
  tools,
  logs,
  isLoading,
  busyAction,
  onChooseApk,
  onExtract,
  onReplaceApkEntry,
  onBuildApk,
  onSignApk,
  onExtractAllBundles,
  onChooseReplacementFile,
  onOpenPath,
  onInvalidateBundleResources,
}: {
  project: ProjectState | null
  tools: ToolStatus
  logs: ActivityLogItem[]
  isLoading: boolean
  busyAction: string | null
  onChooseApk: () => Promise<string | null | undefined> | void
  onExtract: () => Promise<unknown> | void
  onReplaceApkEntry: (targetPath: string, sourcePath: string) => Promise<unknown>
  onBuildApk: () => Promise<unknown> | void
  onSignApk: () => Promise<unknown> | void
  onExtractAllBundles: () => Promise<unknown> | void
  onChooseReplacementFile: () => Promise<string | null>
  onOpenPath: (path: string) => Promise<void> | void
  onInvalidateBundleResources: () => Promise<unknown> | void
}) {
  const { t } = useTranslation()
  const [group, setGroup] = useState<GroupId>(DEFAULT_GROUP)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [bundleTab, setBundleTab] = useState<BundleBrowserTab>('resources')
  const [logExpanded, setLogExpanded] = useState(false)
  const [filters, setFilters] = useState<Set<FilterChip>>(new Set())
  const [compareMode, setCompareMode] = useState<CompareMode>('current')
  const [previewPaneVisible, setPreviewPaneVisible] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [dragError, setDragError] = useState<string | null>(null)
  const snapshotCacheRef = useRef<Record<string, PreviewSnapshot>>({})
  const currentPreviewRef = useRef<PreviewResult | null>(null)

  const manifest = project?.manifest ?? null
  const entries = manifest?.entries.filter((entry) => !entry.is_dir) ?? []
  const replacements = manifest?.replacements ?? []
  const busyText = busyAction ? t(`busy.${busyAction}`) : t('status.ready')

  const bundleResourceCounts = useBundleResourceCounts(Boolean(manifest))
  const bundleSummaryMode = isBundleSummaryGroup(group)
  const bundleSummaryGroup = useMemo(() => {
    switch (group) {
      case 'bundle_images':
        return 'image'
      case 'bundle_texts':
        return 'text'
      case 'bundle_audio':
        return 'audio'
      case 'bundle_other':
        return 'other'
      default:
        return ''
    }
  }, [group])

  const bundleSummaryQuery = useBundleResourceList(
    bundleSummaryGroup,
    bundleSummaryMode ? query : '',
    Boolean(manifest) && bundleSummaryMode,
  )

  const selectedEntry = useMemo(() => {
    if (!selection || selection.type !== 'apk') {
      return null
    }
    return entries.find((entry) => entry.path === selection.path) ?? null
  }, [entries, selection])

  const selectedBundleEntry = useMemo(() => {
    if (!selection) {
      return null
    }
    const bundlePath =
      selection.type === 'bundle'
        ? selection.bundlePath
        : selection.type === 'bundle-node' || selection.type === 'bundle-resource'
          ? selection.bundlePath
          : selectedEntry?.kind === 'bundle'
            ? selectedEntry.path
            : null
    if (!bundlePath) {
      return null
    }
    return entries.find((entry) => entry.path === bundlePath && entry.kind === 'bundle') ?? null
  }, [entries, selectedEntry, selection])

  const currentBundlePath = selectedBundleEntry?.path ?? null
  const bundleManifestQuery = useBundleManifest(currentBundlePath ?? undefined)
  const bundleActions = useBundleActions(currentBundlePath ?? undefined)

  const bundleNodeId = selection?.type === 'bundle-node' ? selection.nodeId : undefined
  const bundleResourceId =
    selection?.type === 'bundle-resource' ? selection.resourceId : undefined

  const apkPreview = useApkPreview(selection?.type === 'apk' ? selection.path : undefined)
  const bundleNodePreview = useBundleNodePreview(currentBundlePath ?? undefined, bundleNodeId)
  const bundleResourcePreview = useBundleResourcePreview(currentBundlePath ?? undefined, bundleResourceId)
  const bundleManifestRefetch = bundleManifestQuery.refetch
  const apkPreviewRefetch = apkPreview.refetch
  const bundleNodePreviewRefetch = bundleNodePreview.refetch
  const bundleResourcePreviewRefetch = bundleResourcePreview.refetch

  const bundleManifest = bundleManifestQuery.data ?? null
  const bundleSummaryItemsRaw = bundleSummaryQuery.data ?? []

  const bundleSummaryItems = useMemo(
    () =>
      bundleSummaryItemsRaw.filter(
        (item) => matchSummaryFilters(item, filters) && matchSummaryQuery(item, query),
      ),
    [bundleSummaryItemsRaw, filters, query],
  )

  const filteredEntries = useMemo(() => {
    if (!manifest) {
      return []
    }
    return entries.filter((entry) => {
      if (bundleSummaryMode) {
        return false
      }
      if (!matchEntryFilters(entry, filters)) {
        return false
      }
      if (!matchEntryQuery(entry, query)) {
        return false
      }
      if (group === 'all') {
        return true
      }
      return matchApkGroup(entry, group)
    })
  }, [entries, filters, group, manifest, query, bundleSummaryMode])

  const selectedBundleNode = useMemo(() => {
    if (!bundleManifest || selection?.type !== 'bundle-node') {
      return null
    }
    return bundleManifest.nodes.find((node) => node.id === selection.nodeId) ?? null
  }, [bundleManifest, selection])

  const selectedBundleResource = useMemo(() => {
    if (!bundleManifest || selection?.type !== 'bundle-resource') {
      return null
    }
    return bundleManifest.resources.find((resource) => resource.id === selection.resourceId) ?? null
  }, [bundleManifest, selection])

  const bundleSummaryItem = useMemo(
    () => findBundleResourceSummary(bundleSummaryItemsRaw, selection),
    [bundleSummaryItemsRaw, selection],
  )

  const selectedBundleNodeFromResource = useMemo(() => {
    const nodeId = selectedBundleResource?.node_id ?? bundleSummaryItem?.resource.node_id
    if (!bundleManifest || !nodeId) {
      return null
    }
    return bundleManifest.nodes.find((node) => node.id === nodeId) ?? null
  }, [bundleManifest, bundleSummaryItem?.resource.node_id, selectedBundleResource?.node_id])

  const activePreview = useMemo<PreviewResult | null>(() => {
    if (selection?.type === 'apk') {
      return apkPreview.data ?? null
    }
    if (selection?.type === 'bundle-node') {
      return bundleNodePreview.data ?? null
    }
    if (selection?.type === 'bundle-resource') {
      return bundleResourcePreview.data ?? null
    }
    return null
  }, [apkPreview.data, bundleNodePreview.data, bundleResourcePreview.data, selection])

  useEffect(() => {
    currentPreviewRef.current = activePreview
  }, [activePreview])

  const selectedSnapshot = useMemo(() => {
    const key = selectionKey(selection)
    return key ? snapshotCacheRef.current[key] ?? null : null
  }, [selection, activePreview, bundleManifest, manifest])

  useEffect(() => {
    if (!selection) {
      setCompareMode('current')
      return
    }
    const key = selectionKey(selection)
    if (!key) {
      setCompareMode('current')
      return
    }
    if (snapshotCacheRef.current[key] && activePreview) {
      setCompareMode(defaultCompareMode(activePreview))
      return
    }
    setCompareMode('current')
  }, [activePreview, selection])

  useEffect(() => {
    if (selection) {
      return
    }
    if (!entries.length) {
      return
    }
    setSelection({ type: 'apk', path: entries[0].path })
  }, [entries, selection])

  useEffect(() => {
    if (!selection) {
      return
    }
    if (selection.type === 'apk') {
      const exists = entries.some((entry) => entry.path === selection.path)
      if (!exists) {
        setSelection(entries[0] ? { type: 'apk', path: entries[0].path } : null)
      }
      return
    }
    if ((selection.type === 'bundle' || selection.type === 'bundle-node' || selection.type === 'bundle-resource') && currentBundlePath) {
      const exists = entries.some((entry) => entry.path === currentBundlePath)
      if (!exists) {
        setSelection(entries[0] ? { type: 'apk', path: entries[0].path } : null)
      }
    }
  }, [currentBundlePath, entries, selection])

  const apkCounts = useMemo(() => {
    const map = new Map<GroupId, number>()
    const apkGroups = workbenchGroups.filter((item) => item.section === 'apk')
    for (const item of apkGroups) {
      if (item.id === 'all') {
        map.set(item.id, entries.length)
        continue
      }
      map.set(
        item.id,
        entries.filter((entry) => matchApkGroup(entry, item.id)).length,
      )
    }
    return map
  }, [entries])

  const counts = useMemo(() => {
    const map = new Map(apkCounts)
    map.set('bundle_resources', bundleResourceCounts.all)
    map.set('bundle_images', bundleResourceCounts.image)
    map.set('bundle_texts', bundleResourceCounts.text)
    map.set('bundle_audio', bundleResourceCounts.audio)
    map.set('bundle_other', bundleResourceCounts.other)
    return map
  }, [apkCounts, bundleResourceCounts])

  const activeBundleError = useMemo(() => {
    if (bundleManifestQuery.error instanceof Error) {
      return bundleManifestQuery.error.message
    }
    if (bundleActions.error instanceof Error) {
      return bundleActions.error.message
    }
    return dragError
  }, [bundleActions.error, bundleManifestQuery.error, dragError])

  const isReplaceable = useMemo(
    () => isSelectionReplaceable(selection, selectedEntry, selectedBundleResource ?? bundleSummaryItem?.resource ?? null),
    [bundleSummaryItem?.resource, selectedBundleResource, selectedEntry, selection],
  )

  const recordSnapshot = useCallback(
    (sourcePath: string) => {
      const preview = currentPreviewRef.current
      if (!selection || !preview) {
        return
      }
      const key = selectionKey(selection)
      if (!key) {
        return
      }

      let snapshot: PreviewSnapshot | null = null
      if (selection.type === 'apk' && selectedEntry) {
        const replacement = latestReplacementForApk(selectedEntry.path, replacements)
        snapshot = {
          before: clonePreviewResult(preview),
          meta: buildSnapshotMetaFromApkEntry(selectedEntry),
          replacedAt: replacement?.replaced_at ?? new Date().toISOString(),
          sourcePath,
        }
      } else if (selection.type === 'bundle-node' && selectedBundleNode) {
        const replacement = latestReplacementForBundleNode(selectedBundleNode.id, bundleManifest?.replacements)
        snapshot = {
          before: clonePreviewResult(preview),
          meta: buildSnapshotMetaFromBundleNode(selectedBundleNode),
          replacedAt: replacement?.replaced_at ?? new Date().toISOString(),
          sourcePath,
        }
      } else if (selection.type === 'bundle-resource') {
        const resource = selectedBundleResource ?? bundleSummaryItem?.resource
        if (!resource) {
          return
        }
        const replacement = latestReplacementForBundleResource(resource.id, bundleManifest?.replacements)
        snapshot = {
          before: clonePreviewResult(preview),
          meta: buildSnapshotMetaFromBundleResource(resource),
          replacedAt: replacement?.replaced_at ?? new Date().toISOString(),
          sourcePath,
        }
      }

      if (snapshot) {
        snapshotCacheRef.current[key] = snapshot
      }
    },
    [
      bundleManifest?.replacements,
      bundleSummaryItem?.resource,
      replacements,
      selectedBundleNode,
      selectedBundleResource,
      selectedEntry,
      selection,
    ],
  )

  const openReplacePicker = useCallback(async () => {
    const sourcePath = await onChooseReplacementFile()
    if (!sourcePath) {
      return null
    }
    return sourcePath
  }, [onChooseReplacementFile])

  const applyReplacement = useCallback(
    async (sourcePath: string) => {
      if (!selection) {
        return
      }
      setDragError(null)
      recordSnapshot(sourcePath)

      if (selection.type === 'apk') {
        if (!selectedEntry) {
          throw new Error(t('empty.noSelection'))
        }
        await onReplaceApkEntry(selectedEntry.path, sourcePath)
        await apkPreviewRefetch()
        setCompareMode(defaultCompareMode(currentPreviewRef.current))
        return
      }

      if (selection.type === 'bundle-node') {
        await bundleActions.replaceNode({ nodeId: selection.nodeId, sourcePath })
        await onInvalidateBundleResources()
        await Promise.all([bundleManifestRefetch(), bundleNodePreviewRefetch()])
        setCompareMode(defaultCompareMode(currentPreviewRef.current))
        return
      }

      if (selection.type === 'bundle-resource') {
        const resourceId = selectedBundleResource?.id ?? bundleSummaryItem?.resource.id
        if (!resourceId) {
          throw new Error(t('inspector.unsupportedResource'))
        }
        await bundleActions.replaceResource({ resourceId, sourcePath })
        await onInvalidateBundleResources()
        await Promise.all([bundleManifestRefetch(), bundleResourcePreviewRefetch()])
        setCompareMode(defaultCompareMode(currentPreviewRef.current))
      }
    },
    [
      apkPreviewRefetch,
      bundleActions,
      bundleManifestRefetch,
      bundleNodePreviewRefetch,
      bundleResourcePreviewRefetch,
      bundleSummaryItem?.resource.id,
      onInvalidateBundleResources,
      onReplaceApkEntry,
      recordSnapshot,
      selectedBundleResource?.id,
      selectedEntry,
      selection,
      t,
    ],
  )

  const handleReplaceCurrent = useCallback(async () => {
    if (!isReplaceable) {
      return
    }
    const sourcePath = await openReplacePicker()
    if (!sourcePath) {
      return
    }
    await applyReplacement(sourcePath)
  }, [applyReplacement, isReplaceable, openReplacePicker])

  const handleReplaceBundleFile = useCallback(async () => {
    if (!selectedBundleEntry) {
      return
    }
    const sourcePath = await openReplacePicker()
    if (!sourcePath) {
      return
    }
    await onReplaceApkEntry(selectedBundleEntry.path, sourcePath)
  }, [onReplaceApkEntry, openReplacePicker, selectedBundleEntry])

  const handleJumpBundle = useCallback(
    (bundlePath: string) => {
      setGroup('bundles')
      setBundleTab('resources')
      setSelection({ type: 'bundle', bundlePath })
      setQuery('')
    },
    [],
  )

  const toggleFilter = useCallback((filter: FilterChip) => {
    setFilters((current) => {
      const next = new Set(current)
      if (next.has(filter)) {
        next.delete(filter)
      } else {
        next.add(filter)
      }
      return next
    })
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void getCurrentWindow()
      .onDragDropEvent(async (payload) => {
        const event = payload.payload as DragDropEvent
        if (event.type === 'enter' || event.type === 'over') {
          setDragError(null)
          if (selection && isReplaceable) {
            setDragActive(true)
          }
          return
        }
        if (event.type === 'leave') {
          setDragActive(false)
          return
        }
        if (event.type === 'drop') {
          setDragActive(false)
          if (!selection || !isReplaceable) {
            setDragError(t('inspector.previewOnly'))
            return
          }
          if (event.paths.length !== 1) {
            setDragError(t('inspector.replaceHint'))
            return
          }
          try {
            await applyReplacement(event.paths[0])
          } catch (error) {
            setDragError(error instanceof Error ? error.message : String(error))
          }
        }
      })
      .then((fn) => {
        unlisten = fn
      })
    return () => {
      unlisten?.()
    }
  }, [applyReplacement, isReplaceable, selection, t])

  const dragLabel = useMemo(() => {
    if (!dragActive) {
      return activeBundleError
    }
    if (selection?.type === 'bundle-node') {
      return t('inspector.dropReplaceNode')
    }
    return t('inspector.dropReplace')
  }, [activeBundleError, dragActive, selection?.type, t])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 py-4 lg:px-6">
      <WorkbenchHeader
        project={project}
        tools={tools}
        busyText={busyText}
        isLoading={isLoading || bundleActions.isPending}
        onChooseApk={() => void onChooseApk()}
        onExtract={() => void onExtract()}
        onExtractAllBundles={() => void onExtractAllBundles()}
        onBuildApk={() => void onBuildApk()}
        onSignApk={() => void onSignApk()}
        onOpenDist={() => {
          if (project?.dist_dir) {
            void onOpenPath(project.dist_dir)
          }
        }}
      />

      <div
        className={`grid min-h-0 flex-1 ${
          previewPaneVisible
            ? 'grid-cols-[208px_minmax(0,1fr)_32px_minmax(520px,36vw)]'
            : 'grid-cols-[208px_minmax(0,1fr)_32px]'
        } gap-0`}
      >
        <WorkbenchSidebar
          group={group}
          counts={counts}
          currentBundlePath={currentBundlePath}
          onSelectGroup={setGroup}
          onBackToApk={() => {
            setGroup('all')
            if (selectedBundleEntry) {
              setSelection({ type: 'apk', path: selectedBundleEntry.path })
            }
          }}
        />

        <ResourceBrowser
          group={group}
          query={query}
          filters={filters}
          selection={selection}
          entries={filteredEntries}
          bundleResources={bundleSummaryItems}
          bundleManifest={bundleManifest}
          bundleTab={bundleTab}
          currentBundlePath={currentBundlePath}
          onQueryChange={setQuery}
          onToggleFilter={toggleFilter}
          onSelectEntry={(entry) => {
            setCompareMode('current')
            if (entry.kind === 'bundle') {
              setSelection({ type: 'bundle', bundlePath: entry.path })
              setBundleTab('resources')
            } else {
              setSelection({ type: 'apk', path: entry.path })
            }
          }}
          onSelectBundleResourceSummary={(item) => {
            setPreviewPaneVisible(true)
            setCompareMode('current')
            setSelection({ type: 'bundle-resource', bundlePath: item.bundle_path, resourceId: item.resource.id })
          }}
          onBundleTabChange={setBundleTab}
          onSelectBundleNode={(node) => {
            if (!currentBundlePath) {
              return
            }
            setSelection({ type: 'bundle-node', bundlePath: currentBundlePath, nodeId: node.id })
          }}
          onSelectBundleResource={(resource) => {
            if (!currentBundlePath) {
              return
            }
            setSelection({ type: 'bundle-resource', bundlePath: currentBundlePath, resourceId: resource.id })
          }}
          onJumpBundle={handleJumpBundle}
        />

        <div className="flex min-h-0 items-center justify-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-14 w-7 rounded-l-lg rounded-r-none border border-r-0 border-white/70 bg-white/88 shadow-sm"
            onClick={() => setPreviewPaneVisible((value) => !value)}
            title={t('actions.togglePreview')}
          >
            {previewPaneVisible ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        {previewPaneVisible ? (
          <PreviewStudio
            selection={selection}
            entry={selection?.type === 'apk' ? selectedEntry : selectedBundleEntry}
            bundleManifest={bundleManifest}
            bundleInfo={bundleActions.info}
            bundleError={activeBundleError}
            bundleNode={selectedBundleNode}
            bundleResource={selectedBundleResource}
            bundleSummaryItem={bundleSummaryItem}
            preview={activePreview}
            snapshot={selectedSnapshot}
            compareMode={compareMode}
            isReplaceable={isReplaceable}
            dragActive={dragActive}
            dragLabel={dragLabel}
            onCompareModeChange={setCompareMode}
            onReplace={() => void handleReplaceCurrent()}
            onAnalyzeBundle={() => void bundleActions.analyze()}
            onExtractBundle={() => void bundleActions.extract(true)}
            onBuildBundle={() => void bundleActions.build()}
            onReplaceBundle={() => void handleReplaceBundleFile()}
            onJumpToBundle={() => {
              const target = bundleSummaryItem?.bundle_path ?? currentBundlePath
              if (target) {
                handleJumpBundle(target)
              }
            }}
            onBackToBundle={() => {
              if (currentBundlePath) {
                setSelection({ type: 'bundle', bundlePath: currentBundlePath })
                setBundleTab('resources')
              }
            }}
            onJumpToNode={() => {
              if (currentBundlePath && selectedBundleNodeFromResource) {
                setBundleTab('nodes')
                setSelection({
                  type: 'bundle-node',
                  bundlePath: currentBundlePath,
                  nodeId: selectedBundleNodeFromResource.id,
                })
              }
            }}
          />
        ) : null}
      </div>

      <ActivityDrawer logs={logs} expanded={logExpanded} onToggle={() => setLogExpanded((value) => !value)} />
    </div>
  )
}
