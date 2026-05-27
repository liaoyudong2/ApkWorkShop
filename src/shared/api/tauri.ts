import { invoke } from '@tauri-apps/api/core'

import type {
  ActivityLogItem,
  BuildResult,
  BundleInfo,
  BundleManifest,
  BundleResourceSummary,
  Manifest,
  PreviewResult,
  ProjectState,
  ToolStatus,
} from '@/shared/types/workspace'

export async function bootstrapProject() {
  return invoke<ProjectState | null>('bootstrap_project')
}

export async function scanProject(apkPath?: string) {
  return invoke<ProjectState | null>('scan_project', { apkPath })
}

export async function chooseApk() {
  return invoke<string | null>('choose_apk')
}

export async function chooseReplacementFile() {
  return invoke<string | null>('choose_replacement_file')
}

export async function extractProject(force = false) {
  return invoke<ProjectState>('extract_project', { force })
}

export async function loadManifest() {
  return invoke<Manifest>('load_manifest')
}

export async function replaceApkEntry(targetPath: string, sourcePath: string) {
  return invoke<ProjectState>('replace_apk_entry', { targetPath, sourcePath })
}

export async function buildApk() {
  return invoke<BuildResult>('build_apk')
}

export async function signApk(unsignedApk?: string) {
  return invoke<BuildResult>('sign_apk', { unsignedApk })
}

export async function toolStatus() {
  return invoke<ToolStatus>('tool_status')
}

export async function analyzeBundle(bundlePath: string) {
  return invoke<BundleInfo>('analyze_bundle', { bundlePath })
}

export async function extractBundle(bundlePath: string, force = false) {
  return invoke<BundleManifest>('extract_bundle', { bundlePath, force })
}

export async function extractAllBundles(force = false) {
  return invoke<BundleManifest[]>('extract_all_bundles', { force })
}

export async function loadBundleManifest(bundlePath: string) {
  return invoke<BundleManifest>('load_bundle_manifest', { bundlePath })
}

export async function replaceBundleNode(bundlePath: string, nodeId: string, sourcePath: string) {
  return invoke<BundleManifest>('replace_bundle_node', { bundlePath, nodeId, sourcePath })
}

export async function replaceBundleResource(bundlePath: string, resourceId: string, sourcePath: string) {
  return invoke<BundleManifest>('replace_bundle_resource', { bundlePath, resourceId, sourcePath })
}

export async function buildBundle(bundlePath: string) {
  return invoke<BundleManifest>('build_bundle', { bundlePath })
}

export async function previewApkEntry(targetPath: string) {
  return invoke<PreviewResult>('preview_apk_entry', { targetPath })
}

export async function previewBundleNode(bundlePath: string, nodeId: string) {
  return invoke<PreviewResult>('preview_bundle_node', { bundlePath, nodeId })
}

export async function previewBundleResource(bundlePath: string, resourceId: string) {
  return invoke<PreviewResult>('preview_bundle_resource', { bundlePath, resourceId })
}

export async function listBundleResources(group?: string, query?: string) {
  return invoke<BundleResourceSummary[]>('list_bundle_resources', { group, query })
}

export async function openPath(path: string) {
  return invoke<void>('open_path', { path })
}

export async function loadActivityLogs() {
  return invoke<ActivityLogItem[]>('activity_logs')
}
