import { ZoomInIcon } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { MARKER_HALO_COLOR, minimapMarkerColorFor, SELECTION_COLOR } from '../colors'
import { MAX_ZOOM_SPEED, MIN_ZOOM_SPEED } from '../config'
import type { ViewportActions } from '../hooks/useViewport'
import { isIgnoredAnnotation } from '../lib/annotations'
import { useAppState, useDispatch } from '../state'
import type { Annotation, MarkerVisibilityMode } from '../types'

interface MinimapProps {
  vp: ViewportActions
  canvasWidth: number
  canvasHeight: number
  zoomLevel: number
}

const MINIMAP_WIDTH = 200

/**
 * Everything a minimap frame is painted from. Each frame is compared against the previously
 * painted one so identical frames can be skipped.
 *
 * The main canvas' `vp.dirty` flag can't be shared for this: its renderer clears the flag as it
 * draws, so whichever of the two loops ran first would starve the other.
 */
interface MinimapFrameInputs {
  offsetX: number
  offsetY: number
  scale: number
  annotations: Annotation[]
  selectedIds: Set<number>
  showRejected: boolean
  threshold: number
  markerVisibility: MarkerVisibilityMode
}

export default function Minimap({ vp, canvasWidth, canvasHeight, zoomLevel }: MinimapProps) {
  const state = useAppState()
  const dispatch = useDispatch()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef(0)

  // Keep annotation state in refs so the RAF loop always reads the latest values
  // without restarting the animation on every annotation change
  const annotationsRef = useRef<Annotation[]>(state.annotations)
  const showRejectedRef = useRef(state.showRejected)
  const thresholdRef = useRef(state.confidenceThreshold)
  const selectedIdsRef = useRef(state.selectedIds)
  const markerVisibilityRef = useRef(state.markerVisibility)
  annotationsRef.current = state.annotations
  showRejectedRef.current = state.showRejected
  thresholdRef.current = state.confidenceThreshold
  selectedIdsRef.current = state.selectedIds
  markerVisibilityRef.current = state.markerVisibility

  const imgW = state.image?.width ?? 1
  const imgH = state.image?.height ?? 1
  const aspect = imgH / imgW
  // Never let the height reach 0: drawImage() throws for a zero-height canvas source (extreme panoramas).
  const minimapH = Math.max(1, Math.round(MINIMAP_WIDTH * aspect))

  useEffect(() => {
    const canvas = canvasRef.current
    const image = state.image
    if (!canvas || !image) return

    const ctx = canvas.getContext('2d')!
    const scale = MINIMAP_WIDTH / imgW

    // Pre-render the downscaled image once per image load. Rescaling the full-resolution element is
    // by far the most expensive part of a frame, and the result never changes while the image doesn't.
    const base = document.createElement('canvas')
    base.width = MINIMAP_WIDTH
    base.height = minimapH
    base.getContext('2d')?.drawImage(image.element, 0, 0, MINIMAP_WIDTH, minimapH)

    // Inputs of the last painted frame; null forces a paint on the first frame after (re)mount.
    let painted: MinimapFrameInputs | null = null

    function render() {
      animRef.current = requestAnimationFrame(render)

      const v = vp.viewport.current
      const prev = painted
      // Skip frames that would paint exactly the same pixels — panning, zooming and every
      // annotation change land in one of these, so idle frames cost a handful of comparisons.
      if (
        prev !== null &&
        prev.offsetX === v.offsetX &&
        prev.offsetY === v.offsetY &&
        prev.scale === v.scale &&
        prev.annotations === annotationsRef.current &&
        prev.selectedIds === selectedIdsRef.current &&
        prev.showRejected === showRejectedRef.current &&
        prev.threshold === thresholdRef.current &&
        prev.markerVisibility === markerVisibilityRef.current
      ) {
        return
      }
      painted = {
        offsetX: v.offsetX,
        offsetY: v.offsetY,
        scale: v.scale,
        annotations: annotationsRef.current,
        selectedIds: selectedIdsRef.current,
        showRejected: showRejectedRef.current,
        threshold: thresholdRef.current,
        markerVisibility: markerVisibilityRef.current,
      }

      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(0, 0, MINIMAP_WIDTH, minimapH)

      ctx.drawImage(base, 0, 0)

      // Compute viewport rect in minimap coords
      const vx = (-v.offsetX / v.scale) * scale
      const vy = (-v.offsetY / v.scale) * scale
      const vw = (canvasWidth / v.scale) * scale
      const vh = (canvasHeight / v.scale) * scale

      // Darken area outside viewport so annotations pop and viewed region is clear
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.fillRect(0, 0, MINIMAP_WIDTH, minimapH)
      // Restore full brightness inside viewport
      ctx.save()
      ctx.beginPath()
      ctx.rect(vx, vy, vw, vh)
      ctx.clip()
      ctx.drawImage(base, 0, 0)
      ctx.restore()

      // Draw annotations with selected markers last so they stay on top in dense clusters.
      const visibleAnnotations =
        markerVisibilityRef.current === 'hidden'
          ? []
          : annotationsRef.current.filter((ann) => {
              if (isIgnoredAnnotation(ann) && !showRejectedRef.current) return false
              if (ann.detection_confidence !== null && ann.detection_confidence < thresholdRef.current) return false
              return true
            })
      const orderedAnnotations = [
        ...visibleAnnotations.filter((ann) => !selectedIdsRef.current.has(ann.id)),
        ...visibleAnnotations.filter((ann) => selectedIdsRef.current.has(ann.id)),
      ]

      for (const ann of orderedAnnotations) {
        const ax = ann.x * scale
        const ay = ann.y * scale
        const isSelected = selectedIdsRef.current.has(ann.id)
        const markerAlpha = markerVisibilityRef.current === 'dimmed' ? 0.26 : 1

        ctx.save()
        ctx.globalAlpha = markerAlpha
        if (isSelected) {
          ctx.beginPath()
          ctx.arc(ax, ay, 4.5, 0, Math.PI * 2)
          ctx.strokeStyle = MARKER_HALO_COLOR
          ctx.lineWidth = 2.5
          ctx.stroke()

          ctx.beginPath()
          ctx.arc(ax, ay, 4.2, 0, Math.PI * 2)
          ctx.strokeStyle = SELECTION_COLOR
          ctx.lineWidth = 1.8
          ctx.stroke()
        }

        ctx.beginPath()
        ctx.arc(ax, ay, 3.25, 0, Math.PI * 2)
        ctx.fillStyle = MARKER_HALO_COLOR
        ctx.fill()

        ctx.beginPath()
        ctx.arc(ax, ay, 2.1, 0, Math.PI * 2)
        ctx.fillStyle = minimapMarkerColorFor(ann)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
        ctx.lineWidth = 0.75
        ctx.stroke()
        ctx.restore()
      }

      // Viewport outline
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(vx, vy, vw, vh)
    }

    animRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animRef.current)
  }, [state.image, vp, canvasWidth, canvasHeight, imgW, minimapH])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!state.image) return
      const rect = canvasRef.current!.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const scale = MINIMAP_WIDTH / imgW

      const imgX = mx / scale
      const imgY = my / scale

      const v = vp.viewport.current
      v.offsetX = canvasWidth / 2 - imgX * v.scale
      v.offsetY = canvasHeight / 2 - imgY * v.scale
      vp.clampViewport()
      vp.dirty.current = true
    },
    [state.image, vp, canvasWidth, canvasHeight, imgW],
  )

  if (!state.image) return null

  const adjustZoomSpeed = (delta: number) => {
    const next = Math.max(MIN_ZOOM_SPEED, Math.min(MAX_ZOOM_SPEED, Math.round((state.zoomSpeed + delta) * 100) / 100))
    dispatch({ type: 'SET_ZOOM_SPEED', speed: next })
  }

  return (
    <div className="pointer-events-none absolute right-3 bottom-3 hidden flex-col items-end gap-2 lg:flex">
      <div className="pointer-events-auto relative overflow-hidden rounded-lg border border-border shadow-md">
        <div className="pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-1 rounded-full border border-border bg-popover/75 px-2 py-0.5 text-xs font-medium text-foreground tabular-nums backdrop-blur-sm">
          <ZoomInIcon className="size-3" />
          <span>{zoomLevel < 1 ? `${(zoomLevel * 100).toFixed(0)}%` : `${zoomLevel.toFixed(1)}x`}</span>
        </div>
        <canvas
          ref={canvasRef}
          width={MINIMAP_WIDTH}
          height={minimapH}
          onClick={handleClick}
          className="block cursor-pointer"
        />
      </div>
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover/85 py-1 pr-1 pl-2.5 text-xs shadow-md backdrop-blur-md">
        <span className="text-muted-foreground">Zoom speed</span>
        <div className="flex items-center gap-0.5">
          <ZoomSpeedButton
            onClick={() => adjustZoomSpeed(-0.25)}
            disabled={state.zoomSpeed <= MIN_ZOOM_SPEED}
            label="Decrease wheel sensitivity"
          >
            −
          </ZoomSpeedButton>
          <ZoomSpeedButton
            onClick={() => dispatch({ type: 'SET_ZOOM_SPEED', speed: 1 })}
            label="Reset zoom speed"
            className="tabular-nums"
          >
            {state.zoomSpeed.toFixed(2)}x
          </ZoomSpeedButton>
          <ZoomSpeedButton
            onClick={() => adjustZoomSpeed(0.25)}
            disabled={state.zoomSpeed >= MAX_ZOOM_SPEED}
            label="Increase wheel sensitivity"
          >
            +
          </ZoomSpeedButton>
        </div>
      </div>
    </div>
  )
}

function ZoomSpeedButton({
  children,
  className = '',
  disabled = false,
  label,
  onClick,
}: {
  children: React.ReactNode
  className?: string
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={[
        'rounded-md px-2 py-1 font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  )
}
