import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  analyzeBundle,
  bootstrapProject,
  buildApk,
  buildBundle,
  chooseApk,
  chooseReplacementFile,
  extractAllBundles,
  extractBundle,
  extractProject,
  listBundleResources,
  loadActivityLogs,
  loadBundleManifest,
  loadManifest,
  openPath,
  previewApkEntry,
  previewBundleNode,
  previewBundleResource,
  replaceApkEntry,
  replaceBundleNode,
  replaceBundleResource,
  scanProject,
  signApk,
  toolStatus,
} from '@/shared/api/tauri'
import type {
  ActivityLogItem,
  BundleManifest,
  BundleResourceSummary,
  PreviewResult,
  ProjectState,
  ToolStatus,
} from '@/shared/types/workspace'

const projectKey = ['project']
const toolsKey = ['tools']
const logsKey = ['logs']

export function bundleManifestKey(bundlePath: string) {
  return ['bundle-manifest', bundlePath]
}

export function bundleResourcesKey(group?: string, query?: string) {
  return ['bundle-resources', group ?? '', query ?? '']
}

export function apkPreviewKey(path?: string) {
  return ['apk-preview', path ?? '']
}

export function bundleNodePreviewKey(bundlePath?: string, nodeId?: string) {
  return ['bundle-node-preview', bundlePath ?? '', nodeId ?? '']
}

export function bundleResourcePreviewKey(bundlePath?: string, resourceId?: string) {
  return ['bundle-resource-preview', bundlePath ?? '', resourceId ?? '']
}

export function useProject() {
  const queryClient = useQueryClient()

  const projectQuery = useQuery({
    queryKey: projectKey,
    queryFn: bootstrapProject,
  })

  const toolsQuery = useQuery({
    queryKey: toolsKey,
    queryFn: toolStatus,
  })

  const logsQuery = useQuery({
    queryKey: logsKey,
    queryFn: loadActivityLogs,
    initialData: [] as ActivityLogItem[],
  })

  const chooseApkMutation = useMutation({
    mutationFn: chooseApk,
    onSuccess: async (apkPath) => {
      if (!apkPath) {
        return
      }
      const project = await scanProject(apkPath)
      queryClient.setQueryData(projectKey, project)
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  const scanMutation = useMutation({
    mutationFn: async (apkPath?: string) => scanProject(apkPath),
    onSuccess: (data) => {
      queryClient.setQueryData(projectKey, data)
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  const extractMutation = useMutation<ProjectState, Error, boolean>({
    mutationFn: async (force = true) => extractProject(force),
    onSuccess: (data) => {
      queryClient.setQueryData<ProjectState | null>(projectKey, data)
      void queryClient.invalidateQueries({ queryKey: logsKey })
      void queryClient.invalidateQueries({ queryKey: toolsKey })
      void queryClient.invalidateQueries({ queryKey: ['bundle-manifest'] })
      void queryClient.invalidateQueries({ queryKey: ['bundle-resources'] })
    },
  })

  const refreshManifestMutation = useMutation({
    mutationFn: loadManifest,
    onSuccess: (manifest) => {
      queryClient.setQueryData<ProjectState | null>(projectKey, (current) => {
        if (!current) {
          return current
        }
        return { ...current, manifest }
      })
    },
  })

  const replaceApkMutation = useMutation({
    mutationFn: async ({ targetPath, sourcePath }: { targetPath: string; sourcePath: string }) =>
      replaceApkEntry(targetPath, sourcePath),
    onSuccess: (data) => {
      queryClient.setQueryData<ProjectState | null>(projectKey, data)
      void queryClient.invalidateQueries({ queryKey: logsKey })
      void queryClient.invalidateQueries({ queryKey: ['bundle-manifest'] })
      void queryClient.invalidateQueries({ queryKey: ['bundle-resources'] })
    },
  })

  const buildApkMutation = useMutation({
    mutationFn: buildApk,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  const signApkMutation = useMutation<Awaited<ReturnType<typeof signApk>>, Error, string | undefined>({
    mutationFn: signApk,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: logsKey })
      void queryClient.invalidateQueries({ queryKey: toolsKey })
    },
  })

  const extractAllBundlesMutation = useMutation<BundleManifest[], Error, boolean>({
    mutationFn: async (force = true) => extractAllBundles(force),
    onSuccess: (manifests) => {
      for (const manifest of manifests) {
        const bundlePath = projectQuery.data?.manifest?.entries.find((entry) => {
          if (entry.kind !== 'bundle') {
            return false
          }
          const normalizedWorkPath = `${projectQuery.data?.work_dir ?? ''}/${entry.path}`.replace(/\\/g, '/')
          const normalizedSource = manifest.source_bundle.replace(/\\/g, '/')
          return normalizedWorkPath === normalizedSource
        })?.path
        if (bundlePath) {
          queryClient.setQueryData(bundleManifestKey(bundlePath), manifest)
        }
      }
      void queryClient.invalidateQueries({ queryKey: logsKey })
      void queryClient.invalidateQueries({ queryKey: ['bundle-manifest'] })
      void queryClient.invalidateQueries({ queryKey: ['bundle-resources'] })
    },
  })

  const chooseReplacementMutation = useMutation({
    mutationFn: chooseReplacementFile,
  })

  return {
    project: projectQuery.data ?? null,
    tools: toolsQuery.data ?? ({ tools: {}, summary: '' } satisfies ToolStatus),
    logs: logsQuery.data ?? [],
    isLoading:
      projectQuery.isLoading ||
      toolsQuery.isLoading ||
      chooseApkMutation.isPending ||
      scanMutation.isPending ||
      extractMutation.isPending ||
      refreshManifestMutation.isPending ||
      replaceApkMutation.isPending ||
      buildApkMutation.isPending ||
      signApkMutation.isPending ||
      extractAllBundlesMutation.isPending ||
      chooseReplacementMutation.isPending,
    busyAction: chooseApkMutation.isPending
      ? 'choose-apk'
      : scanMutation.isPending
        ? 'scan'
        : extractMutation.isPending
          ? 'extract'
          : replaceApkMutation.isPending
            ? 'replace-apk'
            : buildApkMutation.isPending
              ? 'build-apk'
              : signApkMutation.isPending
                ? 'sign-apk'
                : extractAllBundlesMutation.isPending
                  ? 'extract-all-bundles'
                  : refreshManifestMutation.isPending
                    ? 'refresh-manifest'
                    : chooseReplacementMutation.isPending
                      ? 'choose-replacement'
                      : null,
    error:
      projectQuery.error ??
      toolsQuery.error ??
      chooseApkMutation.error ??
      scanMutation.error ??
      extractMutation.error ??
      refreshManifestMutation.error ??
      replaceApkMutation.error ??
      buildApkMutation.error ??
      signApkMutation.error ??
      extractAllBundlesMutation.error ??
      chooseReplacementMutation.error ??
      null,
    chooseApk: () => chooseApkMutation.mutateAsync(),
    scan: (apkPath?: string) => scanMutation.mutateAsync(apkPath),
    extract: (force = true) => extractMutation.mutateAsync(force),
    refreshManifest: refreshManifestMutation.mutateAsync,
    replaceApkEntry: (targetPath: string, sourcePath: string) =>
      replaceApkMutation.mutateAsync({ targetPath, sourcePath }),
    buildApk: () => buildApkMutation.mutateAsync(),
    signApk: (unsignedApk?: string) => signApkMutation.mutateAsync(unsignedApk),
    extractAllBundles: (force = true) => extractAllBundlesMutation.mutateAsync(force),
    chooseReplacementFile: () => chooseReplacementMutation.mutateAsync(),
    invalidateBundleResources: () => queryClient.invalidateQueries({ queryKey: ['bundle-resources'] }),
    invalidateLogs: () => queryClient.invalidateQueries({ queryKey: logsKey }),
    queryClient,
  }
}

export function useBundleManifest(bundlePath?: string) {
  return useQuery({
    queryKey: bundleManifestKey(bundlePath ?? ''),
    queryFn: () => loadBundleManifest(bundlePath!),
    enabled: Boolean(bundlePath),
  })
}

export function useBundleResourceList(group?: string, query?: string, enabled = true) {
  return useQuery({
    queryKey: bundleResourcesKey(group, query),
    queryFn: () => listBundleResources(group, query),
    enabled,
    initialData: [] as BundleResourceSummary[],
  })
}

export function useBundleResourceCounts(enabled = true) {
  const groups = ['', 'image', 'text', 'audio', 'other'] as const
  const queries = useQueries({
    queries: groups.map((group) => ({
      queryKey: bundleResourcesKey(group, ''),
      queryFn: () => listBundleResources(group, ''),
      enabled,
      initialData: [] as BundleResourceSummary[],
    })),
  })

  return {
    all: queries[0]?.data?.length ?? 0,
    image: queries[1]?.data?.length ?? 0,
    text: queries[2]?.data?.length ?? 0,
    audio: queries[3]?.data?.length ?? 0,
    other: queries[4]?.data?.length ?? 0,
    isLoading: queries.some((query) => query.isLoading),
  }
}

export function useApkPreview(path?: string) {
  return useQuery({
    queryKey: apkPreviewKey(path),
    queryFn: () => previewApkEntry(path!),
    enabled: Boolean(path),
  })
}

export function useBundleNodePreview(bundlePath?: string, nodeId?: string) {
  return useQuery({
    queryKey: bundleNodePreviewKey(bundlePath, nodeId),
    queryFn: () => previewBundleNode(bundlePath!, nodeId!),
    enabled: Boolean(bundlePath && nodeId),
  })
}

export function useBundleResourcePreview(bundlePath?: string, resourceId?: string) {
  return useQuery({
    queryKey: bundleResourcePreviewKey(bundlePath, resourceId),
    queryFn: () => previewBundleResource(bundlePath!, resourceId!),
    enabled: Boolean(bundlePath && resourceId),
  })
}

export function useBundleActions(bundlePath?: string) {
  const queryClient = useQueryClient()

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      if (!bundlePath) {
        throw new Error('bundlePath 不能为空')
      }
      return analyzeBundle(bundlePath)
    },
  })

  const extractMutation = useMutation<BundleManifest, Error, boolean>({
    mutationFn: async (force = true) => {
      if (!bundlePath) {
        throw new Error('bundlePath 不能为空')
      }
      return extractBundle(bundlePath, force)
    },
    onSuccess: (manifest) => {
      queryClient.setQueryData(bundleManifestKey(bundlePath ?? ''), manifest)
      void queryClient.invalidateQueries({ queryKey: ['bundle-resources'] })
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  const replaceNodeMutation = useMutation({
    mutationFn: async ({ nodeId, sourcePath }: { nodeId: string; sourcePath: string }) => {
      if (!bundlePath) {
        throw new Error('bundlePath 不能为空')
      }
      return replaceBundleNode(bundlePath, nodeId, sourcePath)
    },
    onSuccess: (manifest) => {
      queryClient.setQueryData(bundleManifestKey(bundlePath ?? ''), manifest)
      void queryClient.invalidateQueries({ queryKey: projectKey })
      void queryClient.invalidateQueries({ queryKey: ['bundle-resources'] })
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  const replaceResourceMutation = useMutation({
    mutationFn: async ({ resourceId, sourcePath }: { resourceId: string; sourcePath: string }) => {
      if (!bundlePath) {
        throw new Error('bundlePath 不能为空')
      }
      return replaceBundleResource(bundlePath, resourceId, sourcePath)
    },
    onSuccess: (manifest) => {
      queryClient.setQueryData(bundleManifestKey(bundlePath ?? ''), manifest)
      void queryClient.invalidateQueries({ queryKey: projectKey })
      void queryClient.invalidateQueries({ queryKey: ['bundle-resources'] })
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  const buildMutation = useMutation({
    mutationFn: async () => {
      if (!bundlePath) {
        throw new Error('bundlePath 不能为空')
      }
      return buildBundle(bundlePath)
    },
    onSuccess: (manifest) => {
      queryClient.setQueryData(bundleManifestKey(bundlePath ?? ''), manifest)
      void queryClient.invalidateQueries({ queryKey: logsKey })
    },
  })

  return {
    analyze: () => analyzeMutation.mutateAsync(),
    extract: (force = true) => extractMutation.mutateAsync(force),
    replaceNode: (payload: { nodeId: string; sourcePath: string }) => replaceNodeMutation.mutateAsync(payload),
    replaceResource: (payload: { resourceId: string; sourcePath: string }) =>
      replaceResourceMutation.mutateAsync(payload),
    build: () => buildMutation.mutateAsync(),
    info: analyzeMutation.data ?? null,
    isPending:
      analyzeMutation.isPending ||
      extractMutation.isPending ||
      replaceNodeMutation.isPending ||
      replaceResourceMutation.isPending ||
      buildMutation.isPending,
    error:
      analyzeMutation.error ??
      extractMutation.error ??
      replaceNodeMutation.error ??
      replaceResourceMutation.error ??
      buildMutation.error ??
      null,
  }
}

export async function openLocalPath(path: string) {
  return openPath(path)
}

export type { BundleManifest, BundleResourceSummary, PreviewResult }
