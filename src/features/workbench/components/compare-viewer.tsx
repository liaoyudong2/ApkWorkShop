import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { PreviewResult } from '@/shared/types/workspace'
import type { CompareMode, PreviewSnapshot } from '@/features/workbench/lib/workbench'
import { SegmentedTabs } from '@/shared/ui/tabs'
import { Button } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'

const BASE_SCALE = 1
const MIN_SCALE = 0.25
const MAX_SCALE = 4
const SCALE_STEP = 0.5
const STAGE_MAX_EDGE = 256

export interface ImagePreviewMetrics {
  naturalWidth: number
  naturalHeight: number
  contentLeft: number
  contentTop: number
  contentWidth: number
  contentHeight: number
  transparentLeft: number
  transparentTop: number
  transparentRight: number
  transparentBottom: number
}

const imageMetricsCache = new Map<string, ImagePreviewMetrics>()
const imageMetricsPromiseCache = new Map<string, Promise<ImagePreviewMetrics>>()

function buildFallbackMetrics(width: number, height: number): ImagePreviewMetrics {
  return {
    naturalWidth: width,
    naturalHeight: height,
    contentLeft: 0,
    contentTop: 0,
    contentWidth: width,
    contentHeight: height,
    transparentLeft: 0,
    transparentTop: 0,
    transparentRight: 0,
    transparentBottom: 0,
  }
}

function analyzeImageMetrics(src: string) {
  const cached = imageMetricsCache.get(src)
  if (cached) {
    return Promise.resolve(cached)
  }

  const pending = imageMetricsPromiseCache.get(src)
  if (pending) {
    return pending
  }

  const task = new Promise<ImagePreviewMetrics>((resolve) => {
    const image = new Image()
    image.onload = () => {
      const fallback = buildFallbackMetrics(image.naturalWidth, image.naturalHeight)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) {
          imageMetricsCache.set(src, fallback)
          resolve(fallback)
          return
        }

        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0)
        const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)

        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const alpha = data[(y * width + x) * 4 + 3]
            if (alpha <= 8) {
              continue
            }
            if (x < minX) minX = x
            if (y < minY) minY = y
            if (x > maxX) maxX = x
            if (y > maxY) maxY = y
          }
        }

        const metrics =
          maxX >= minX && maxY >= minY
            ? {
                naturalWidth: width,
                naturalHeight: height,
                contentLeft: minX,
                contentTop: minY,
                contentWidth: maxX - minX + 1,
                contentHeight: maxY - minY + 1,
                transparentLeft: minX,
                transparentTop: minY,
                transparentRight: width - maxX - 1,
                transparentBottom: height - maxY - 1,
              }
            : fallback

        imageMetricsCache.set(src, metrics)
        resolve(metrics)
      } catch {
        imageMetricsCache.set(src, fallback)
        resolve(fallback)
      }
    }
    image.onerror = () => resolve(buildFallbackMetrics(0, 0))
    image.src = src
  }).finally(() => {
    imageMetricsPromiseCache.delete(src)
  })

  imageMetricsPromiseCache.set(src, task)
  return task
}

function useImagePreviewMetrics(src?: string | null) {
  const [metrics, setMetrics] = useState<ImagePreviewMetrics | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!src) {
      setMetrics(null)
      return
    }

    const cached = imageMetricsCache.get(src)
    if (cached) {
      setMetrics(cached)
      return
    }

    setMetrics(null)
    void analyzeImageMetrics(src).then((value) => {
      if (!cancelled) {
        setMetrics(value)
      }
    })

    return () => {
      cancelled = true
    }
  }, [src])

  return metrics
}

export function CompareViewer({
  preview,
  snapshot,
  mode,
  allowedModes,
  onModeChange,
  onImageMetricsChange,
}: {
  preview: PreviewResult | null
  snapshot: PreviewSnapshot | null
  mode: CompareMode
  allowedModes: CompareMode[]
  onModeChange: (mode: CompareMode) => void
  onImageMetricsChange?: (metrics: ImagePreviewMetrics | null) => void
}) {
  const { t } = useTranslation()
  const imageMetrics = useImagePreviewMetrics(preview?.image_data_url)

  useEffect(() => {
    onImageMetricsChange?.(imageMetrics ?? null)
  }, [imageMetrics, onImageMetricsChange])

  if (!preview) {
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {allowedModes.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">{t('labels.compareMode')}</div>
          <SegmentedTabs
            value={mode}
            onChange={(value) => onModeChange(value as CompareMode)}
            items={allowedModes.map((item) => ({
              value: item,
              label:
                item === 'current'
                  ? t('inspector.currentVersion')
                  : item === 'before'
                    ? t('inspector.beforeVersion')
                    : item === 'compare'
                      ? t('inspector.compareVersion')
                      : t('inspector.diffVersion'),
            }))}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {mode === 'compare' ? (
          <ImageCompare current={preview} before={snapshot?.before ?? null} currentMetrics={imageMetrics} />
        ) : mode === 'diff' ? (
          <TextDiff current={preview.text ?? ''} before={snapshot?.before.text ?? ''} />
        ) : mode === 'before' ? (
          <VersionPreview preview={snapshot?.before ?? null} emptyText={t('inspector.beforeSnapshotMissing')} />
        ) : (
          <VersionPreview preview={preview} emptyText={t('inspector.noPreview')} metrics={imageMetrics} />
        )}
      </div>
    </div>
  )
}

function VersionPreview({
  preview,
  emptyText,
  metrics,
}: {
  preview: PreviewResult | null
  emptyText: string
  metrics?: ImagePreviewMetrics | null
}) {
  const { t } = useTranslation()

  if (!preview) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{emptyText}</div>
  }

  if (preview.image_data_url) {
    return <StaticImageStage src={preview.image_data_url} alt={preview.title} metrics={metrics} />
  }

  if (preview.audio_data_url) {
    return (
      <div className="rounded-lg border border-slate-300/90 bg-white/80 shadow-sm">
        <div className="border-b border-slate-300/90 px-3 py-2 text-xs font-medium text-muted-foreground">
          {t('inspector.previewAudio')}
        </div>
        <div className="p-4">
          <audio key={`${preview.title}:${preview.audio_data_url}`} controls preload="metadata" className="w-full">
            <source src={preview.audio_data_url} />
          </audio>
        </div>
      </div>
    )
  }

  if (preview.text) {
    return (
      <div className="flex h-full min-h-[260px] flex-col overflow-hidden rounded-lg border border-slate-300/90 bg-white/80 shadow-sm">
        <div className="border-b border-slate-300/90 px-3 py-2 text-xs font-medium text-muted-foreground">
          {preview.mode === 'text' ? t('inspector.previewText') : t('inspector.previewContent')}
        </div>
        <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs leading-6 text-foreground whitespace-pre-wrap break-all">
          {preview.text}
        </pre>
      </div>
    )
  }

  return <div className="flex h-full min-h-[260px] items-center justify-center rounded-lg border border-white/60 bg-white/70 text-sm text-muted-foreground">{t('inspector.previewUnsupported')}</div>
}

function ImageCompare({
  current,
  before,
  currentMetrics,
}: {
  current: PreviewResult
  before: PreviewResult | null
  currentMetrics?: ImagePreviewMetrics | null
}) {
  const { t } = useTranslation()
  if (!before?.image_data_url) {
    return <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-muted-foreground">{t('inspector.beforeSnapshotMissing')}</div>
  }
  return (
    <div className="grid h-full min-h-[260px] gap-3 lg:grid-cols-2">
      <CompareImageCard title={t('inspector.beforeVersion')} src={before.image_data_url} />
      <CompareImageCard title={t('inspector.currentVersion')} src={current.image_data_url ?? ''} metrics={currentMetrics} />
    </div>
  )
}

function CompareImageCard({
  title,
  src,
  metrics,
}: {
  title: string
  src: string
  metrics?: ImagePreviewMetrics | null
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/60 bg-white/80">
      <div className="border-b border-white/60 px-3 py-2 text-xs font-medium text-muted-foreground">{title}</div>
      <StaticImageStage src={src} alt={title} compact metrics={metrics} />
    </div>
  )
}

function StaticImageStage({
  src,
  alt,
  compact = false,
  metrics,
}: {
  src: string
  alt: string
  compact?: boolean
  metrics?: ImagePreviewMetrics | null
}) {
  const { t } = useTranslation()
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const localMetrics = useImagePreviewMetrics(src)
  const resolvedMetrics = metrics ?? localMetrics

  const stageMinHeight = compact ? 'min-h-[220px]' : 'min-h-[300px]'
  const imageAreaSize = compact ? 220 : 256
  const fullWidth = resolvedMetrics?.naturalWidth ?? 0
  const fullHeight = resolvedMetrics?.naturalHeight ?? 0
  const fitScale = useMemo(() => {
    if (!fullWidth || !fullHeight) {
      return BASE_SCALE
    }
    const limitScale = Math.min(STAGE_MAX_EDGE / fullWidth, STAGE_MAX_EDGE / fullHeight, BASE_SCALE)
    return limitScale
  }, [fullHeight, fullWidth])

  const computedWidth = fullWidth ? fullWidth * fitScale : undefined
  const computedHeight = fullHeight ? fullHeight * fitScale : undefined

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-2 p-4">
        {resolvedMetrics ? (
          <div className="text-xs text-muted-foreground">
            {t('inspector.scaleFit')} {Math.round(fitScale * 100)}%
          </div>
        ) : null}
        <button
          type="button"
          className={cn(
            stageMinHeight,
            'min-h-0 flex-1 overflow-hidden rounded-lg border border-white/60 bg-white/45 p-4 text-left',
            'cursor-zoom-in',
          )}
          onClick={() => setFullscreenOpen(true)}
        >
          <div className="flex h-full min-h-full min-w-full items-center justify-center overflow-hidden">
            <div
              className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/60 bg-[linear-gradient(45deg,rgba(255,255,255,0.7)_25%,rgba(245,245,245,0.7)_25%,rgba(245,245,245,0.7)_50%,rgba(255,255,255,0.7)_50%,rgba(255,255,255,0.7)_75%,rgba(245,245,245,0.7)_75%,rgba(245,245,245,0.7)_100%)] bg-[length:16px_16px]"
              style={{
                width: `${imageAreaSize}px`,
                height: `${imageAreaSize}px`,
                maxWidth: '100%',
                maxHeight: '100%',
              }}
            >
              <img
                src={src}
                alt={alt}
                className="block max-w-none select-none"
                draggable={false}
                style={{
                  width: computedWidth ?? 'auto',
                  height: computedHeight ?? 'auto',
                }}
              />
            </div>
          </div>
        </button>
      </div>

      {fullscreenOpen ? <FullscreenImagePreview src={src} alt={alt} onClose={() => setFullscreenOpen(false)} /> : null}
    </>
  )
}

function FullscreenImagePreview({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(BASE_SCALE)
  const [dragging, setDragging] = useState(false)
  const dragStateRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const metrics = useImagePreviewMetrics(src)
  const fullWidth = metrics?.naturalWidth ?? 0
  const fullHeight = metrics?.naturalHeight ?? 0
  const computedWidth = fullWidth ? fullWidth * scale : undefined
  const computedHeight = fullHeight ? fullHeight * scale : undefined
  const canPan = Boolean(viewportRef.current && computedWidth && computedHeight)
  const dimensionText =
    fullWidth && fullHeight ? `${fullWidth} x ${fullHeight}` : '-'

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan || !viewportRef.current) {
      return
    }
    dragStateRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: viewportRef.current.scrollLeft,
      top: viewportRef.current.scrollTop,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current || !viewportRef.current) {
      return
    }
    const dx = event.clientX - dragStateRef.current.x
    const dy = event.clientY - dragStateRef.current.y
    viewportRef.current.scrollLeft = dragStateRef.current.left - dx
    viewportRef.current.scrollTop = dragStateRef.current.top - dy
    event.preventDefault()
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragStateRef.current = null
    setDragging(false)
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999]" onClick={onClose}>
      <div className="absolute inset-0" style={{ backgroundColor: 'rgba(0, 0, 0, 0.82)' }} />
      <div className="absolute inset-x-0 top-0 z-[10000] grid grid-cols-[1fr_auto_1fr] items-center px-6 py-5 text-white">
        <div className="rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-sm backdrop-blur-sm">
          {t('inspector.scaleFit')} {Math.round(scale * 100)}%
        </div>
        <div className="justify-self-center rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-sm backdrop-blur-sm">
          {dimensionText}
        </div>
        <div className="flex items-center justify-self-end gap-2" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="outline"
            size="sm"
            className="border-white/20 bg-black/35 text-white hover:bg-white/20"
            onClick={() => setScale((current) => Math.max(MIN_SCALE, current - SCALE_STEP))}
            disabled={scale <= MIN_SCALE}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-white/20 bg-black/35 text-white hover:bg-white/20"
            onClick={() => setScale((current) => Math.min(MAX_SCALE, current + SCALE_STEP))}
            disabled={scale >= MAX_SCALE}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-white/20 bg-black/35 text-white hover:bg-white/20"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={cn(
          'absolute inset-0 overflow-auto px-8 pb-8 pt-20',
          canPan ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
        )}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
      >
        <div className="flex min-h-full min-w-full items-center justify-center">
          <img
            src={src}
            alt={alt}
            className="block max-w-none select-none shadow-2xl"
            draggable={false}
            style={{
              width: computedWidth ?? 'auto',
              height: computedHeight ?? 'auto',
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

function TextDiff({ current, before }: { current: string; before: string }) {
  const { t } = useTranslation()
  if (!before) {
    return <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-muted-foreground">{t('inspector.beforeSnapshotMissing')}</div>
  }

  return (
    <div className="grid h-full min-h-[260px] gap-3 lg:grid-cols-2">
      <TextPane title={t('inspector.beforeVersion')} value={before} />
      <TextPane title={t('inspector.currentVersion')} value={current} />
    </div>
  )
}

function TextPane({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex h-full min-h-[260px] flex-col overflow-hidden rounded-lg border border-slate-300/90 bg-white/80 shadow-sm">
      <div className="border-b border-slate-300/90 px-3 py-2 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs leading-6 text-foreground whitespace-pre-wrap break-all">{value}</pre>
    </div>
  )
}
