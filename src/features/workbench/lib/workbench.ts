import type {
  BundleManifest,
  BundleNode,
  BundleResource,
  BundleResourceSummary,
  Entry,
  PreviewResult,
  Replacement,
} from '@/shared/types/workspace'

export type GroupId =
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

export type WorkbenchScope = 'apk' | 'bundle-summary' | 'bundle'

export type BundleBrowserTab = 'resources' | 'nodes'

export type CompareMode = 'current' | 'before' | 'compare' | 'diff'

export type FilterChip = 'replaceable' | 'changed' | 'image' | 'text'

export type Selection =
  | { type: 'apk'; path: string }
  | { type: 'bundle'; bundlePath: string }
  | { type: 'bundle-node'; bundlePath: string; nodeId: string }
  | { type: 'bundle-resource'; bundlePath: string; resourceId: string }

export interface PreviewSnapshotMeta {
  name: string
  type: string
  size?: number | null
  crc?: string | null
  path?: string | null
  fileName?: string | null
}

export interface PreviewSnapshot {
  before: PreviewResult
  meta: PreviewSnapshotMeta
  replacedAt: string
  sourcePath?: string | null
}

export interface NavGroupDef {
  id: GroupId
  labelKey: string
  icon: string
  section: 'apk' | 'bundle'
  match?: (entry: Entry) => boolean
  bundleGroup?: '' | 'image' | 'text' | 'audio' | 'other'
}

export const workbenchGroups: NavGroupDef[] = [
  { id: 'all', labelKey: 'labels.all', icon: 'Boxes', section: 'apk' },
  { id: 'assets', labelKey: 'labels.assets', icon: 'FolderOpen', section: 'apk', match: (entry) => entry.path.startsWith('assets/') },
  { id: 'res', labelKey: 'labels.res', icon: 'FolderOpen', section: 'apk', match: (entry) => entry.path.startsWith('res/') },
  { id: 'lib', labelKey: 'labels.lib', icon: 'FolderOpen', section: 'apk', match: (entry) => entry.path.startsWith('lib/') },
  { id: 'classes', labelKey: 'labels.classes', icon: 'FileCode2', section: 'apk', match: (entry) => entry.path.endsWith('.dex') },
  { id: 'meta', labelKey: 'labels.metaInf', icon: 'BadgeInfo', section: 'apk', match: (entry) => entry.path.startsWith('META-INF/') },
  { id: 'images', labelKey: 'labels.images', icon: 'ImageIcon', section: 'apk', match: (entry) => entry.kind === 'image' },
  { id: 'texts', labelKey: 'labels.texts', icon: 'FileText', section: 'apk', match: (entry) => entry.kind === 'text' },
  { id: 'bundles', labelKey: 'labels.bundles', icon: 'FileArchive', section: 'apk', match: (entry) => entry.kind === 'bundle' },
  { id: 'changed', labelKey: 'labels.changedOnly', icon: 'Replace', section: 'apk', match: (entry) => entry.changed },
  { id: 'bundle_resources', labelKey: 'labels.bundleResources', icon: 'Boxes', section: 'bundle', bundleGroup: '' },
  { id: 'bundle_images', labelKey: 'labels.bundleImages', icon: 'FileImage', section: 'bundle', bundleGroup: 'image' },
  { id: 'bundle_texts', labelKey: 'labels.bundleTexts', icon: 'FileText', section: 'bundle', bundleGroup: 'text' },
  { id: 'bundle_audio', labelKey: 'labels.bundleAudio', icon: 'FileAudio2', section: 'bundle', bundleGroup: 'audio' },
  { id: 'bundle_other', labelKey: 'labels.bundleOther', icon: 'ListFilter', section: 'bundle', bundleGroup: 'other' },
]

export function isBundleSummaryGroup(group: GroupId) {
  return group.startsWith('bundle_')
}

export function selectionKey(selection: Selection | null) {
  if (!selection) {
    return null
  }
  switch (selection.type) {
    case 'apk':
      return `apk:${selection.path}`
    case 'bundle':
      return `bundle:${selection.bundlePath}`
    case 'bundle-node':
      return `bundle-node:${selection.bundlePath}:${selection.nodeId}`
    case 'bundle-resource':
      return `bundle-resource:${selection.bundlePath}:${selection.resourceId}`
  }
}

export function iconNameForKind(kind: string) {
  switch (kind) {
    case 'image':
      return 'FileImage'
    case 'text':
      return 'FileText'
    case 'audio':
      return 'FileAudio2'
    case 'bundle':
      return 'FileArchive'
    case 'dex':
      return 'FileCode2'
    default:
      return 'File'
  }
}

export function basename(path: string | null | undefined) {
  if (!path) {
    return '-'
  }
  return path.split(/[\\/]/).pop() || path
}

export function buildSnapshotMetaFromApkEntry(entry: Entry): PreviewSnapshotMeta {
  return {
    name: entry.name,
    type: entry.kind,
    size: entry.size,
    crc: entry.crc,
    path: entry.path,
    fileName: entry.name,
  }
}

export function buildSnapshotMetaFromBundleNode(node: BundleNode): PreviewSnapshotMeta {
  return {
    name: node.name,
    type: node.kind,
    size: node.size,
    crc: node.crc ?? null,
    path: node.path,
    fileName: node.file_name,
  }
}

export function buildSnapshotMetaFromBundleResource(resource: BundleResource): PreviewSnapshotMeta {
  return {
    name: resource.name || resource.type,
    type: resource.kind,
    size: resource.size,
    crc: resource.crc ?? null,
    path: resource.node_path,
    fileName: resource.file_name,
  }
}

export function clonePreviewResult(preview: PreviewResult): PreviewResult {
  return JSON.parse(JSON.stringify(preview)) as PreviewResult
}

export function defaultCompareMode(preview: PreviewResult | null) {
  if (!preview) {
    return 'current' as CompareMode
  }
  if (preview.mode === 'image') {
    return 'compare' as CompareMode
  }
  if (preview.mode === 'text') {
    return 'diff' as CompareMode
  }
  if (preview.mode === 'audio') {
    return 'before' as CompareMode
  }
  return 'before' as CompareMode
}

export function allowedCompareModes(preview: PreviewResult | null, hasBefore: boolean): CompareMode[] {
  const modes: CompareMode[] = ['current']
  if (!preview || !hasBefore) {
    return modes
  }
  if (preview.mode === 'image') {
    return ['current', 'before', 'compare']
  }
  if (preview.mode === 'text') {
    return ['current', 'before', 'diff']
  }
  if (preview.mode === 'audio') {
    return ['current', 'before']
  }
  return ['current', 'before']
}

export function isSelectionReplaceable(
  selection: Selection | null,
  entry: Entry | null,
  resource: BundleResource | null,
) {
  if (!selection) {
    return false
  }
  if (selection.type === 'apk') {
    return Boolean(entry?.replaceable)
  }
  if (selection.type === 'bundle-node') {
    return true
  }
  if (selection.type === 'bundle-resource') {
    return Boolean(resource?.replaceable)
  }
  return false
}

export function latestReplacementForApk(path: string, replacements: Replacement[] | undefined) {
  if (!replacements?.length) {
    return null
  }
  return replacements
    .filter((item) => item.path === path)
    .sort((left, right) => right.replaced_at.localeCompare(left.replaced_at))[0] ?? null
}

export function latestReplacementForBundleNode(nodeId: string, replacements: Replacement[] | undefined) {
  if (!replacements?.length) {
    return null
  }
  return replacements
    .filter((item) => item.node_id === nodeId)
    .sort((left, right) => right.replaced_at.localeCompare(left.replaced_at))[0] ?? null
}

export function latestReplacementForBundleResource(resourceId: string, replacements: Replacement[] | undefined) {
  if (!replacements?.length) {
    return null
  }
  return replacements
    .filter((item) => item.resource_id === resourceId)
    .sort((left, right) => right.replaced_at.localeCompare(left.replaced_at))[0] ?? null
}

export function findBundleResourceSummary(
  items: BundleResourceSummary[],
  selection: Selection | null,
) {
  if (!selection || selection.type !== 'bundle-resource') {
    return null
  }
  return (
    items.find(
      (item) =>
        item.bundle_path === selection.bundlePath &&
        item.resource.id === selection.resourceId,
    ) ?? null
  )
}

export function findBundleContextManifest(
  manifest: BundleManifest | null,
  fallbackInfo: { node_count?: number; resource_count?: number; compression?: string; engine_version?: string } | null,
) {
  return manifest?.info ?? fallbackInfo
}
