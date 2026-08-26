import { useEffect, useRef } from 'react'
import {
  categoryColorFor,
  MARKER_HALO_COLOR,
  markerColorFor,
  SELECTION_COLOR,
  SELECTION_FILL,
  textColorFor,
} from '../colors'
import { categoryOption } from '../config'
import { categoryBadgeLabel, getDisplayNumbers, getVisibleAnnotations } from '../lib/annotations'
import type { Annotation, AppState } from '../types'
import type { ViewportActions } from './useViewport'

export interface SelectionRect {
  startX: number
  startY: number
  endX: number
  endY: number
}

export interface LassoPath {
  points: [number, number][]
}

export interface DragOverlay {
  /** Annotation being dragged, rendered at temporary position */
  annotationId: number | null
  /** Image coords of the dragged annotation's current position */
  dragPos: { x: number; y: number } | null
  /** Bbox being drawn via Alt+drag or add-mode drag (screen coords) */
  bboxDraft: SelectionRect | null
  /** Bbox being resized — live image coords */
  bboxResizeDraft: {
    annotationId: number
    bbox: [number, number, number, number]
  } | null
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - radius)
  ctx.lineTo(x + radius, y)
  ctx.lineTo(x, y + radius)
  ctx.lineTo(x - radius, y)
  ctx.closePath()
}

/**
 * Equilateral triangle pointing up, `radius` from the centre to each vertex. A triangle's inradius is half its
 * circumradius, so it needs roughly twice the diamond's radius to clear the same marker dot.
 */
function drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - radius)
  ctx.lineTo(x + radius * 0.866, y + radius * 0.5)
  ctx.lineTo(x - radius * 0.866, y + radius * 0.5)
  ctx.closePath()
}

function drawCategoryIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  category: Annotation['category'],
  radius: number,
  stroke: string,
) {
  const { indicator } = categoryOption(category)
  if (indicator === 'none') return

  ctx.save()
  ctx.strokeStyle = stroke
  ctx.lineWidth = 2.6

  if (indicator === 'diamond') {
    drawDiamond(ctx, x, y, radius + 4.75)
  } else if (indicator === 'triangle') {
    drawTriangle(ctx, x, y, radius * 2 + 4)
  } else {
    if (indicator === 'dashed-ring') ctx.setLineDash([3.5, 3])
    ctx.beginPath()
    ctx.arc(x, y, radius + 2.5, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.restore()
}

function drawCategoryBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  category: Annotation['category'],
  stroke: string,
) {
  const label = categoryBadgeLabel(category)
  if (!label) return

  // Badge sits to the upper right of the marker; the left edge stays fixed and the box grows
  // to fit labels wider than one character.
  const badgeLeft = x + 5
  const badgeY = y - 10
  const badgeHeight = 10

  ctx.save()
  ctx.font = 'bold 8px sans-serif'
  const badgeWidth = Math.max(14, Math.ceil(ctx.measureText(label).width) + 6)
  const badgeX = badgeLeft + badgeWidth / 2

  ctx.fillStyle = 'rgba(20, 27, 24, 0.92)'
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.5

  if (categoryOption(category).indicator === 'diamond') {
    drawDiamond(ctx, badgeX, badgeY, 7)
  } else {
    drawRoundedRect(ctx, badgeLeft, badgeY - badgeHeight / 2, badgeWidth, badgeHeight, 3)
  }

  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = stroke
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, badgeX, badgeY + 0.5)
  ctx.restore()
}

function drawAnnotationBbox(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  radius: number,
  bbox: [number, number, number, number],
  stroke: string,
) {
  const [x1, y1, x2, y2] = bbox

  ctx.save()
  ctx.strokeStyle = MARKER_HALO_COLOR
  ctx.lineWidth = 4
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

  ctx.strokeStyle = stroke
  ctx.lineWidth = 2
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

  ctx.beginPath()
  ctx.moveTo(sx, sy - radius - 1)
  ctx.lineTo(sx, y1)
  ctx.stroke()
  ctx.restore()
}

function drawMarkerLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  color: string,
  maxDiameter: number,
) {
  const maxWidth = Math.max(8, maxDiameter - 2)
  let fontSize = 9
  let measuredWidth = Number.POSITIVE_INFINITY

  while (fontSize >= 4.5) {
    ctx.font = `bold ${fontSize}px sans-serif`
    measuredWidth = ctx.measureText(label).width
    if (measuredWidth <= maxWidth) break
    fontSize -= 0.5
  }

  if (measuredWidth > maxWidth) return

  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x, y + 0.5)
}

export function useCanvasRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  state: AppState,
  vp: ViewportActions,
  selectionRect: React.MutableRefObject<SelectionRect | null>,
  lassoPath: React.MutableRefObject<LassoPath | null>,
  dragOverlay: React.MutableRefObject<DragOverlay>,
) {
  const animFrameRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')!
    vp.dirty.current = true

    function render() {
      animFrameRef.current = requestAnimationFrame(render)
      if (!vp.dirty.current) return
      vp.dirty.current = false

      const dpr = window.devicePixelRatio || 1
      const w = canvas!.width / dpr
      const h = canvas!.height / dpr
      const v = vp.viewport.current

      // Clear with dark background matching the canvas area
      ctx.fillStyle = '#1e1e22'
      ctx.fillRect(0, 0, w, h)

      // Draw image
      if (state.image) {
        const img = state.image.element
        const sx = Math.max(0, -v.offsetX / v.scale)
        const sy = Math.max(0, -v.offsetY / v.scale)
        const sw = Math.min(img.width - sx, w / v.scale)
        const sh = Math.min(img.height - sy, h / v.scale)
        const dx = Math.max(0, v.offsetX)
        const dy = Math.max(0, v.offsetY)
        const dw = sw * v.scale
        const dh = sh * v.scale

        if (sw > 0 && sh > 0) {
          ctx.imageSmoothingEnabled = v.scale < 2
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
        }
      }

      // Draw annotations using the current marker visibility mode
      if (state.image) {
        const visibleAnnotations = getVisibleAnnotations(state.annotations, {
          showRejected: state.showRejected,
          confidenceThreshold: state.confidenceThreshold,
        })
        const orderedAnnotations =
          state.markerVisibility === 'hidden'
            ? []
            : [
                ...visibleAnnotations.filter((ann) => !state.selectedIds.has(ann.id)),
                ...visibleAnnotations.filter((ann) => state.selectedIds.has(ann.id)),
              ]
        const displayNumbers = getDisplayNumbers(visibleAnnotations)
        const margin = 20
        const overlay = dragOverlay.current

        if (state.markerVisibility !== 'hidden') {
          ctx.globalAlpha = state.markerVisibility === 'dimmed' ? 0.24 : 1
        }

        for (const ann of orderedAnnotations) {
          const isDragging = overlay.annotationId === ann.id && overlay.dragPos
          const isResizing = overlay.bboxResizeDraft?.annotationId === ann.id

          // Use drag position if this annotation is being dragged
          let drawX: number
          let drawY: number
          if (isDragging && overlay.dragPos) {
            drawX = overlay.dragPos.x
            drawY = overlay.dragPos.y
          } else {
            drawX = ann.x
            drawY = ann.y
          }

          const [sx, sy] = vp.imageToScreen(drawX, drawY)

          if (sx < -margin || sx > w + margin || sy < -margin || sy > h + margin) continue

          const color = markerColorFor(ann)
          const isSelected = state.selectedIds.has(ann.id)
          const radius = 8

          // Selection ring
          if (isSelected) {
            ctx.beginPath()
            ctx.arc(sx, sy, radius + 5.5, 0, Math.PI * 2)
            ctx.strokeStyle = MARKER_HALO_COLOR
            ctx.lineWidth = 5
            ctx.stroke()

            ctx.beginPath()
            ctx.arc(sx, sy, radius + 5, 0, Math.PI * 2)
            ctx.strokeStyle = SELECTION_COLOR
            ctx.lineWidth = 3
            ctx.stroke()
          }

          drawCategoryIndicator(ctx, sx, sy, ann.category, radius, categoryColorFor(ann.category))

          // Filled circle
          ctx.save()
          ctx.shadowColor = MARKER_HALO_COLOR
          ctx.shadowBlur = 10
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 0
          ctx.beginPath()
          ctx.arc(sx, sy, radius, 0, Math.PI * 2)
          ctx.fillStyle = isDragging ? `${color}80` : color
          ctx.fill()
          ctx.restore()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5
          ctx.stroke()

          // Number label
          if (state.showNumbers) {
            const label = String(displayNumbers.get(ann.id) ?? ann.id)
            drawMarkerLabel(ctx, label, sx, sy, textColorFor(color), radius * 2)
          }

          drawCategoryBadge(ctx, sx, sy, ann.category, categoryColorFor(ann.category))

          // Bounding box
          const drawBbox =
            isResizing && overlay.bboxResizeDraft
              ? overlay.bboxResizeDraft.bbox
              : isDragging && ann.bbox && overlay.dragPos
                ? ([
                    ann.bbox[0] + (overlay.dragPos.x - ann.x),
                    ann.bbox[1] + (overlay.dragPos.y - ann.y),
                    ann.bbox[2] + (overlay.dragPos.x - ann.x),
                    ann.bbox[3] + (overlay.dragPos.y - ann.y),
                  ] as [number, number, number, number])
                : ann.bbox

          if (drawBbox) {
            const [x1, y1, x2, y2] = drawBbox
            const [bsx1, bsy1] = vp.imageToScreen(x1, y1)
            const [bsx2, bsy2] = vp.imageToScreen(x2, y2)
            drawAnnotationBbox(ctx, sx, sy, radius, [bsx1, bsy1, bsx2, bsy2], color)

            // Draw resize handles for selected annotation
            if (isSelected && !isDragging) {
              drawBboxHandles(ctx, bsx1, bsy1, bsx2, bsy2)
            }
          }
        }
        ctx.globalAlpha = 1
      }

      // Bbox draft overlay
      const bboxDraft = dragOverlay.current.bboxDraft
      if (bboxDraft) {
        const x = Math.min(bboxDraft.startX, bboxDraft.endX)
        const y = Math.min(bboxDraft.startY, bboxDraft.endY)
        const rw = Math.abs(bboxDraft.endX - bboxDraft.startX)
        const rh = Math.abs(bboxDraft.endY - bboxDraft.startY)
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'
        ctx.fillRect(x, y, rw, rh)
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 3])
        ctx.strokeRect(x, y, rw, rh)
        ctx.setLineDash([])
      }

      // Selection rectangle overlay
      const sr = selectionRect.current
      if (sr) {
        const x = Math.min(sr.startX, sr.endX)
        const y = Math.min(sr.startY, sr.endY)
        const rw = Math.abs(sr.endX - sr.startX)
        const rh = Math.abs(sr.endY - sr.startY)
        ctx.fillStyle = SELECTION_FILL
        ctx.fillRect(x, y, rw, rh)
        ctx.strokeStyle = SELECTION_COLOR
        ctx.lineWidth = 1
        ctx.setLineDash([6, 3])
        ctx.strokeRect(x, y, rw, rh)
        ctx.setLineDash([])
      }

      // Lasso overlay
      const lp = lassoPath.current
      if (lp && lp.points.length > 1) {
        ctx.beginPath()
        ctx.moveTo(lp.points[0]![0], lp.points[0]![1])
        for (let i = 1; i < lp.points.length; i++) {
          ctx.lineTo(lp.points[i]![0], lp.points[i]![1])
        }
        ctx.closePath()
        ctx.fillStyle = SELECTION_FILL
        ctx.fill()
        ctx.strokeStyle = SELECTION_COLOR
        ctx.lineWidth = 1
        ctx.setLineDash([6, 3])
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    animFrameRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [canvasRef, state, vp, selectionRect, lassoPath, dragOverlay])
}

function drawBboxHandles(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const size = 6
  const half = size / 2
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2

  const handles = [
    [x1, y1],
    [mx, y1],
    [x2, y1],
    [x1, my],
    [x2, my],
    [x1, y2],
    [mx, y2],
    [x2, y2],
  ]

  for (const [hx, hy] of handles) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(hx! - half, hy! - half, size, size)
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 1
    ctx.strokeRect(hx! - half, hy! - half, size, size)
  }
}

export function getVisibleAnnotationsForState(state: AppState): Annotation[] {
  return getVisibleAnnotations(state.annotations, {
    showRejected: state.showRejected,
    confidenceThreshold: state.confidenceThreshold,
  })
}
