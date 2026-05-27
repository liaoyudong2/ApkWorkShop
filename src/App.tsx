import { AlertTriangle } from 'lucide-react'

import { AppShell } from '@/features/workbench/components/app-shell'
import { openLocalPath, useProject } from '@/features/workbench/hooks/use-project'
import { Card, CardContent } from '@/shared/ui/card'

export default function App() {
  const {
    project,
    tools,
    logs,
    isLoading,
    busyAction,
    chooseApk,
    extract,
    replaceApkEntry,
    buildApk,
    signApk,
    extractAllBundles,
    chooseReplacementFile,
    invalidateBundleResources,
    error,
  } = useProject()

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {error ? (
        <div className="shrink-0 px-4 pt-4 lg:px-6">
          <Card className="border-red-200 bg-red-50/90 shadow-none">
            <CardContent className="flex items-start gap-3 px-4 py-4 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error instanceof Error ? error.message : String(error)}</span>
            </CardContent>
          </Card>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <AppShell
          project={project}
          tools={tools}
          logs={logs}
          isLoading={isLoading}
          busyAction={busyAction}
          onChooseApk={chooseApk}
          onExtract={() => extract(true)}
          onReplaceApkEntry={replaceApkEntry}
          onBuildApk={buildApk}
          onSignApk={() => signApk()}
          onExtractAllBundles={() => extractAllBundles(true)}
          onChooseReplacementFile={chooseReplacementFile}
          onOpenPath={openLocalPath}
          onInvalidateBundleResources={invalidateBundleResources}
        />
      </div>
    </div>
  )
}
