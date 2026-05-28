export type EntryKind =
  | 'image'
  | 'audio'
  | 'text'
  | 'bundle'
  | 'dex'
  | 'native'
  | 'android-resource'
  | 'binary'

export interface Counts {
  dex: number
  native_libs: number
  res: number
  assets: number
  unity_bundles: number
  unity_addressable_bundles: number
}

export interface UnityInfo {
  detected: boolean
  il2cpp: boolean
  addressables: boolean
}

export interface SignatureInfo {
  v1_present: boolean
  apk_signing_block_present: boolean
  signature_files: string[]
}

export interface AddressablesInfo {
  version: string
  build_target: string
  settings_hash: string
  catalog_count: number
  bundle_count: number
  bundle_samples: string[]
  resource_types: string[]
}

export interface ScanReport {
  apk: string
  name: string
  size_bytes: number
  entry_count: number
  counts: Counts
  unity: UnityInfo
  signature: SignatureInfo
  addressables: AddressablesInfo
  optional_tools: Record<string, boolean>
}

export interface Entry {
  path: string
  name: string
  kind: EntryKind
  size: number
  compressed: number
  crc: string
  method: number
  modified: number[]
  is_dir: boolean
  changed: boolean
  replaceable: boolean
  external_attr: number
  create_system: number
}

export interface Replacement {
  kind?: string
  path: string
  source_path: string
  size: number
  crc: string
  replaced_at: string
  node_id?: string
  node_path?: string
  resource_id?: string
}

export interface Manifest {
  schema_version: number
  tool: string
  source_apk: string
  source_size: number
  extracted_at: string
  entries: Entry[]
  replacements: Replacement[]
}

export interface BuildResult {
  output_apk: string
  signed: boolean
  message: string
}

export interface ToolStatus {
  tools: Record<string, boolean>
  summary: string
}

export interface PreviewResult {
  mode: string
  title: string
  text?: string | null
  summary?: string | null
  image_data_url?: string | null
  audio_data_url?: string | null
  file_path?: string | null
}

export interface BundleAnalyzeInfo {
  node_count?: number
  resource_count?: number
  compression?: string
  engine_version?: string
}

export interface BundleNode {
  id: string
  path: string
  name: string
  offset: number
  size: number
  flags: number
  crc?: string | null
  changed: boolean
  file_name: string
  kind: string
}

export interface BundleResource {
  id: string
  node_id: string
  node_path: string
  path_id: number
  class_id: number
  type: string
  name: string
  kind: string
  size: number
  crc?: string | null
  file_name: string
  details?: string | null
  replaceable: boolean
  changed: boolean
}

export interface BundleInfo {
  source_path: string
  signature: string
  format_version: number
  player_version: string
  engine_version: string
  total_size: number
  compressed_size: number
  uncompressed_size: number
  flags: number
  compression: string
  blocks_info_at_end: boolean
  directory_at_end: boolean
  block_count: number
  node_count: number
  resource_count: number
  nodes: BundleNode[]
  uncompressed_bytes: number
}

export interface BundleManifest {
  schema_version: number
  tool: string
  source_bundle: string
  extracted_at: string
  info: BundleInfo
  nodes: BundleNode[]
  resources: BundleResource[]
  replacements: Replacement[]
}

export interface BundleResourceSummary {
  bundle_path: string
  bundle_name: string
  resource: BundleResource
  bundle_changed: boolean
}

export interface BundleResourceCounts {
  all: number
  image: number
  text: number
  audio: number
  other: number
}

export interface ActivityLogItem {
  level: string
  message: string
  at: string
}

export interface ProjectState {
  scan: ScanReport
  manifest?: Manifest | null
  work_dir: string
  dist_dir: string
}

export type TaskProgressKind = 'extract-apk' | 'extract-all-bundles'

export interface TaskProgress {
  kind: TaskProgressKind
  current: number
  total: number
  percent: number
  label: string
  path?: string | null
  finished: boolean
}
