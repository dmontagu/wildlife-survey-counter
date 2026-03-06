import { ZoomInIcon } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { MARKER_HALO_COLOR, minimapMarkerColorFor, SELECTION_COLOR } from '../colors'
import type { ViewportActions } from '../hooks/useViewport'
import { isIgnoredAnnotation } from '../lib/annotations'
import { useAppState } from '../state'
import type { Annotation } from '../types'
import ShortcutKey from './ShortcutKey'

interface MinimapProps {
  vp: ViewportActions
  canvasWidth: number
  canvasHeight: number
  zoomLevel: number
}

const MINIMAP_WIDTH = 200

export default function Minimap({ vp, canvasWidth, canvasHeight, zoomLevel }: MinimapProps) {
  const state = useAppState()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef(0)

  // Keep annotation state in refs so the RAF loop always reads the latest values
  // without restarting the animation on every annotation change
  const annotationsRef = useRef<Annotation[]>(state.annotations)
  const showRejectedRef = useRef(state.showRejected)
  const thresholdRef = useRef(state.confidenceThreshold)
  const selectedIdsRef = useRef(state.selectedIds)
  annotationsRef.current = state.annotations
  showRejectedRef.current = state.showRejected
  thresholdRef.current = state.confidenceThreshold
  selectedIdsRef.current = state.selectedIds

  const imgW = state.image?.width ?? 1
  const imgH = state.image?.height ?? 1
  const aspect = imgH / imgW
  const minimapH = Math.round(MINIMAP_WIDTH * aspect)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !state.image) return

    const ctx = canvas.getContext('2d')!
    const scale = MINIMAP_WIDTH / imgW

    function render() {
      animRef.current = requestAnimationFrame(render)

      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(0, 0, MINIMAP_WIDTH, minimapH)

      ctx.drawImage(state.image!.element, 0, 0, MINIMAP_WIDTH, minimapH)

      // Compute viewport rect in minimap coords
      const v = vp.viewport.current
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
      ctx.drawImage(state.image!.element, 0, 0, MINIMAP_WIDTH, minimapH)
      ctx.restore()

      // Draw annotations as bright dots (read from refs for latest state)
      for (const ann of annotationsRef.current) {
        if (isIgnoredAnnotation(ann) && !showRejectedRef.current) continue
        if (ann.detection_confidence !== null && ann.detection_confidence < thresholdRef.current) continue
        const ax = ann.x * scale
        const ay = ann.y * scale
        const isSelected = selectedIdsRef.current.has(ann.id)

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

  return (
    <div className="absolute bottom-3 right-3 hidden items-end gap-2 lg:flex lg:flex-col">
      <div className="flex flex-col items-end gap-2">
        <div className="rounded-full border border-white/10 bg-slate-950/72 px-2.5 py-1 text-[11px] font-medium text-slate-100 shadow-lg backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/58">
          <div className="flex items-center gap-1.5">
            <ZoomInIcon className="size-3" />
            <span>{zoomLevel < 1 ? `${(zoomLevel * 100).toFixed(0)}%` : `${zoomLevel.toFixed(1)}x`}</span>
          </div>
        </div>
        <div className="rounded-full border border-cyan-400/25 bg-slate-950/78 px-2.5 py-1 text-[11px] font-medium text-slate-100 shadow-lg backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/62">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-300/85">Pan</span>
            <ShortcutKey shortcut="Space" compact />
            <span className="text-slate-300/85">+ drag</span>
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-border shadow-lg">
        <canvas
          ref={canvasRef}
          width={MINIMAP_WIDTH}
          height={minimapH}
          onClick={handleClick}
          className="block cursor-pointer"
        />
      </div>
    </div>
  )
}
