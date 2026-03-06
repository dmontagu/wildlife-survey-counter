import { useCallback, useEffect, useRef } from 'react'
import {
  type DragOverlay,
  getVisibleAnnotationsForState,
  type LassoPath,
  type SelectionRect,
  useCanvasRenderer,
} from '../hooks/useCanvasRenderer'
import { useKeyboard } from '../hooks/useKeyboard'
import type { ViewportActions } from '../hooks/useViewport'
import { useAppState, useDispatch } from '../state'
import type { Annotation, AppState } from '../types'

type DragType = 'select-rect' | 'move-annotation' | 'add-annotation' | 'resize-bbox' | 'move-bbox' | 'pan' | null
type HandleType = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se' | 'interior'

interface BboxHandle {
  annotationId: number
  type: HandleType
  bbox: [number, number, number, number]
}

interface CanvasProps {
  vp: ViewportActions
  onCanvasSize?: (w: number, h: number) => void
}

const HANDLE_HIT_RADIUS = 8

function makeAnnotation(
  state: AppState,
  x: number,
  y: number,
  bbox: [number, number, number, number] | null,
): Annotation {
  const maxId = state.annotations.reduce((max, a) => Math.max(max, a.id), 0)
  return {
    id: maxId + 1,
    x,
    y,
    bbox,
    detection_confidence: null,
    classification_confidence: null,
    source: 'manual',
    label: 'elk',
    category: state.activeCategory,
    state: 'manually-added',
  }
}

export default function Canvas({ vp, onCanvasSize }: CanvasProps) {
  const state = useAppState()
  const dispatch = useDispatch()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const annotationsHidden = useRef(false)
  const selectionRect = useRef<SelectionRect | null>(null)
  const lassoPath = useRef<LassoPath | null>(null)
  const dragOverlay = useRef<DragOverlay>({
    annotationId: null,
    dragPos: null,
    bboxDraft: null,
    bboxResizeDraft: null,
  })

  // Dragging state
  const isDragging = useRef(false)
  const dragType = useRef<DragType>(null)
  const dragStart = useRef<[number, number]>([0, 0])
  const dragStartImage = useRef<[number, number]>([0, 0])
  const dragAnnotationOrigPos = useRef<{ x: number; y: number } | null>(null)
  const dragBboxHandle = useRef<BboxHandle | null>(null)

  // Space pan state (shared with viewport for Space+scroll zoom)
  const spaceHeld = vp.spaceHeld

  // Keyboard shortcuts — C/R/Delete dispatch with empty ids, we intercept and fill selectedIds
  const wrappedDispatch = useCallback(
    (action: Parameters<typeof dispatch>[0]) => {
      if (action.type === 'CONFIRM' && action.ids.length === 0 && state.selectedIds.size > 0) {
        dispatch({ type: 'CONFIRM', ids: [...state.selectedIds] })
        return
      }
      if (action.type === 'REJECT' && action.ids.length === 0 && state.selectedIds.size > 0) {
        dispatch({ type: 'REJECT', ids: [...state.selectedIds] })
        return
      }
      if (action.type === 'DELETE_OR_REJECT' && action.ids.length === 0 && state.selectedIds.size > 0) {
        dispatch({ type: 'DELETE_OR_REJECT', ids: [...state.selectedIds] })
        return
      }
      if (action.type === 'SET_CATEGORY' && action.ids.length === 0 && state.selectedIds.size > 0) {
        dispatch({ type: 'SET_CATEGORY', ids: [...state.selectedIds], category: action.category })
        return
      }
      if (action.type === 'SET_ACTIVE_CATEGORY') {
        dispatch(action)
        if (state.selectedIds.size > 0) {
          dispatch({ type: 'SET_CATEGORY', ids: [...state.selectedIds], category: action.category })
        }
        return
      }
      dispatch(action)
    },
    [dispatch, state.selectedIds],
  )

  useKeyboard(wrappedDispatch, annotationsHidden, vp.dirty)
  useCanvasRenderer(canvasRef, state, vp, annotationsHidden, selectionRect, lassoPath, dragOverlay)

  // Resize canvas to fill container
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.scale(dpr, dpr)
      vp.canvasSize.current = { w: width, h: height }
      vp.dirty.current = true
      onCanvasSize?.(width, height)

      if (
        state.image &&
        ((vp.viewport.current.scale === 1 && vp.viewport.current.offsetX === 0) || vp.viewport.current.scale < 0.01)
      ) {
        vp.fitToWindow(state.image.width, state.image.height, width, height)
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [state.image, vp, onCanvasSize])

  // Fit image when it first loads
  useEffect(() => {
    if (!state.image || !containerRef.current) return
    vp.imageSize.current = { w: state.image.width, h: state.image.height }
    const { width, height } = containerRef.current.getBoundingClientRect()
    vp.fitToWindow(state.image.width, state.image.height, width, height)
  }, [state.image, vp])

  // Update cursor immediately when interaction mode changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || spaceHeld.current) return
    canvas.style.cursor = state.interactionMode === 'add' ? 'crosshair' : 'default'
  }, [state.interactionMode, spaceHeld])

  // Wheel handler
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', vp.handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', vp.handleWheel)
  }, [vp.handleWheel])

  // Track whether Cmd/Ctrl is held (for cursor updates)
  const metaHeld = useRef(false)

  // Space key → pan via mouse movement (no click needed)
  // Also handles Cmd/Ctrl keydown/keyup for cursor feedback
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space' && !spaceHeld.current) {
        e.preventDefault()
        spaceHeld.current = true
        canvas!.style.cursor = 'grabbing'
      }
      if (e.key === 'Meta' || e.key === 'Control') {
        metaHeld.current = true
        if (!spaceHeld.current && !isDragging.current) {
          canvas!.style.cursor = 'grab'
        }
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') {
        spaceHeld.current = false
        canvas!.style.cursor = metaHeld.current ? 'grab' : ''
      }
      if (e.key === 'Meta' || e.key === 'Control') {
        metaHeld.current = false
        if (!spaceHeld.current && !isDragging.current) {
          canvas!.style.cursor = ''
        }
      }
    }

    function onMouseMoveRaw(e: MouseEvent) {
      if (spaceHeld.current) {
        vp.viewport.current.offsetX += e.movementX
        vp.viewport.current.offsetY += e.movementY
        vp.clampViewport()
        vp.dirty.current = true
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousemove', onMouseMoveRaw)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousemove', onMouseMoveRaw)
    }
  }, [vp, spaceHeld])

  const getCanvasPos = useCallback((e: React.MouseEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }, [])

  const findAnnotationAt = useCallback(
    (sx: number, sy: number): number | null => {
      const visible = getVisibleAnnotationsForState(state)
      let bestId: number | null = null
      let bestDist = 15

      for (const ann of visible) {
        const [ax, ay] = vp.imageToScreen(ann.x, ann.y)
        const dist = Math.hypot(ax - sx, ay - sy)
        if (dist < bestDist) {
          bestDist = dist
          bestId = ann.id
        }
      }
      return bestId
    },
    [state, vp],
  )

  const findBboxHandleAt = useCallback(
    (sx: number, sy: number): BboxHandle | null => {
      for (const id of state.selectedIds) {
        const ann = state.annotations.find((a) => a.id === id)
        if (!ann?.bbox) continue

        const [x1, y1, x2, y2] = ann.bbox
        const [bsx1, bsy1] = vp.imageToScreen(x1, y1)
        const [bsx2, bsy2] = vp.imageToScreen(x2, y2)
        const mx = (bsx1 + bsx2) / 2
        const my = (bsy1 + bsy2) / 2

        const handles: [number, number, HandleType][] = [
          [bsx1, bsy1, 'nw'],
          [mx, bsy1, 'n'],
          [bsx2, bsy1, 'ne'],
          [bsx1, my, 'w'],
          [bsx2, my, 'e'],
          [bsx1, bsy2, 'sw'],
          [mx, bsy2, 's'],
          [bsx2, bsy2, 'se'],
        ]

        for (const [hx, hy, handleType] of handles) {
          if (Math.hypot(hx - sx, hy - sy) <= HANDLE_HIT_RADIUS) {
            return { annotationId: ann.id, type: handleType, bbox: ann.bbox }
          }
        }

        // Check interior
        if (sx >= bsx1 && sx <= bsx2 && sy >= bsy1 && sy <= bsy2) {
          return { annotationId: ann.id, type: 'interior', bbox: ann.bbox }
        }
      }
      return null
    },
    [state, vp],
  )

  // --- Mouse event handlers ---

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const [sx, sy] = getCanvasPos(e)
      isDragging.current = false
      dragStart.current = [sx, sy]
      dragStartImage.current = vp.screenToImage(sx, sy)
      dragAnnotationOrigPos.current = null
      dragBboxHandle.current = null

      // Priority 1: Alt → force create when bbox creation is enabled
      if (e.altKey && state.bboxCreationEnabled) {
        dragType.current = 'add-annotation'
        return
      }

      // Priority 1b: Space held → pan
      if (spaceHeld.current) {
        dragType.current = 'pan'
        isDragging.current = true
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
        return
      }

      // Priority 2: Bbox handle hit
      const handle = findBboxHandleAt(sx, sy)
      if (handle) {
        if (handle.type === 'interior') {
          dragType.current = 'move-bbox'
        } else {
          dragType.current = 'resize-bbox'
        }
        dragBboxHandle.current = handle
        return
      }

      // Priority 3: Annotation hit
      const hitId = findAnnotationAt(sx, sy)
      if (hitId !== null) {
        if (e.shiftKey) {
          dispatch({ type: 'SELECT', ids: [hitId], append: true })
        } else if (!state.selectedIds.has(hitId)) {
          dispatch({ type: 'SELECT', ids: [hitId] })
        }
        const ann = state.annotations.find((a) => a.id === hitId)
        if (ann) {
          dragAnnotationOrigPos.current = { x: ann.x, y: ann.y }
        }
        dragType.current = 'move-annotation'
        dragOverlay.current.annotationId = hitId
        return
      }

      // Priority 4: Cmd/Ctrl on empty → pan
      if (e.metaKey || e.ctrlKey) {
        dragType.current = 'pan'
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
        return
      }

      // Priority 5: Shift on empty → select-rect
      if (e.shiftKey) {
        dragType.current = 'select-rect'
        return
      }

      // Priority 6: Mode-dependent
      if (state.interactionMode === 'add') {
        dragType.current = 'add-annotation'
      } else {
        dispatch({ type: 'DESELECT_ALL' })
        dragType.current = 'select-rect'
      }
    },
    [
      getCanvasPos,
      findAnnotationAt,
      findBboxHandleAt,
      dispatch,
      state.bboxCreationEnabled,
      state.selectedIds,
      state.annotations,
      state.interactionMode,
      vp,
      spaceHeld,
    ],
  )

  // Cursor feedback
  const updateCursor = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas || spaceHeld.current) return

      const [sx, sy] = getCanvasPos(e)

      // Alt held → crosshair when bbox creation is enabled
      if (e.altKey && state.bboxCreationEnabled) {
        canvas.style.cursor = 'crosshair'
        return
      }

      // Space held → grabbing (panning is immediate)
      if (spaceHeld.current) {
        canvas.style.cursor = 'grabbing'
        return
      }

      // Check bbox handles
      const handle = findBboxHandleAt(sx, sy)
      if (handle) {
        const cursorMap: Record<HandleType, string> = {
          nw: 'nwse-resize',
          se: 'nwse-resize',
          ne: 'nesw-resize',
          sw: 'nesw-resize',
          n: 'ns-resize',
          s: 'ns-resize',
          w: 'ew-resize',
          e: 'ew-resize',
          interior: 'move',
        }
        canvas.style.cursor = cursorMap[handle.type]
        return
      }

      // Check annotation hit
      const hitId = findAnnotationAt(sx, sy)
      if (hitId !== null) {
        canvas.style.cursor = 'pointer'
        return
      }

      // Cmd/Ctrl held → grab
      if (e.metaKey || e.ctrlKey) {
        canvas.style.cursor = 'grab'
        return
      }

      // Add mode on empty → crosshair
      if (state.interactionMode === 'add') {
        canvas.style.cursor = 'crosshair'
        return
      }

      canvas.style.cursor = 'default'
    },
    [getCanvasPos, findBboxHandleAt, findAnnotationAt, state.bboxCreationEnabled, state.interactionMode, spaceHeld],
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Skip during pointer lock (Space pan handled by raw mousemove listener)
      if (spaceHeld.current) return

      if (e.buttons !== 1) {
        updateCursor(e)
        return
      }

      const [sx, sy] = getCanvasPos(e)
      const [startX, startY] = dragStart.current
      const dist = Math.hypot(sx - startX, sy - startY)

      if (!isDragging.current && dist < 4) return
      isDragging.current = true

      const dt = dragType.current

      if (dt === 'select-rect') {
        if (!selectionRect.current) {
          selectionRect.current = { startX, startY, endX: sx, endY: sy }
        }
        selectionRect.current.endX = sx
        selectionRect.current.endY = sy
        vp.dirty.current = true
      } else if (dt === 'move-annotation') {
        const [ix, iy] = vp.screenToImage(sx, sy)
        dragOverlay.current.dragPos = { x: Math.round(ix), y: Math.round(iy) }
        vp.dirty.current = true
      } else if (dt === 'add-annotation') {
        if (state.bboxCreationEnabled) {
          dragOverlay.current.bboxDraft = {
            startX,
            startY,
            endX: sx,
            endY: sy,
          }
        }
        vp.dirty.current = true
      } else if (dt === 'resize-bbox' || dt === 'move-bbox') {
        const handle = dragBboxHandle.current
        if (!handle) return
        const [ix, iy] = vp.screenToImage(sx, sy)
        const [ox1, oy1, ox2, oy2] = handle.bbox

        let nx1 = ox1
        let ny1 = oy1
        let nx2 = ox2
        let ny2 = oy2

        if (dt === 'move-bbox') {
          const [startIx, startIy] = dragStartImage.current
          const dx = ix - startIx
          const dy = iy - startIy
          nx1 = ox1 + dx
          ny1 = oy1 + dy
          nx2 = ox2 + dx
          ny2 = oy2 + dy
        } else {
          const ht = handle.type
          if (ht === 'nw' || ht === 'w' || ht === 'sw') nx1 = ix
          if (ht === 'nw' || ht === 'n' || ht === 'ne') ny1 = iy
          if (ht === 'ne' || ht === 'e' || ht === 'se') nx2 = ix
          if (ht === 'sw' || ht === 's' || ht === 'se') ny2 = iy
        }

        // Ensure min size
        const minDim = 5
        if (Math.abs(nx2 - nx1) < minDim) nx2 = nx1 + minDim
        if (Math.abs(ny2 - ny1) < minDim) ny2 = ny1 + minDim

        dragOverlay.current.bboxResizeDraft = {
          annotationId: handle.annotationId,
          bbox: [Math.min(nx1, nx2), Math.min(ny1, ny2), Math.max(nx1, nx2), Math.max(ny1, ny2)],
        }
        vp.dirty.current = true
      } else if (dt === 'pan' || dt === null) {
        // Pan: middle mouse, Cmd/Ctrl+drag, Space+drag, or fallthrough
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
        vp.viewport.current.offsetX += e.movementX
        vp.viewport.current.offsetY += e.movementY
        vp.clampViewport()
        vp.dirty.current = true
        dragType.current = 'pan'
      }
    },
    [getCanvasPos, state.bboxCreationEnabled, vp, updateCursor, spaceHeld],
  )

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const [sx, sy] = getCanvasPos(e)
      const dt = dragType.current

      // Handle add-annotation: click = point, drag = bbox (fallback to point if bbox too small)
      if (dt === 'add-annotation') {
        const [ix, iy] = vp.screenToImage(sx, sy)
        if (state.image && ix >= 0 && iy >= 0 && ix <= state.image.width && iy <= state.image.height) {
          if (state.bboxCreationEnabled && isDragging.current && dragOverlay.current.bboxDraft) {
            const draft = dragOverlay.current.bboxDraft
            const [ix1, iy1] = vp.screenToImage(Math.min(draft.startX, draft.endX), Math.min(draft.startY, draft.endY))
            const [ix2, iy2] = vp.screenToImage(Math.max(draft.startX, draft.endX), Math.max(draft.startY, draft.endY))

            if (Math.abs(ix2 - ix1) > 3 && Math.abs(iy2 - iy1) > 3) {
              // Large enough for bbox
              const cx = Math.round((ix1 + ix2) / 2)
              const cy = Math.round((iy1 + iy2) / 2)
              dispatch({
                type: 'ADD_ANNOTATION',
                annotation: makeAnnotation(state, cx, cy, [
                  Math.round(ix1),
                  Math.round(iy1),
                  Math.round(ix2),
                  Math.round(iy2),
                ]),
              })
            } else {
              // Too small for bbox — add point at click location
              dispatch({
                type: 'ADD_ANNOTATION',
                annotation: makeAnnotation(state, Math.round(ix), Math.round(iy), null),
              })
            }
          } else {
            // No drag — add point
            dispatch({
              type: 'ADD_ANNOTATION',
              annotation: makeAnnotation(state, Math.round(ix), Math.round(iy), null),
            })
          }
        }
      }

      if (
        dt === 'move-annotation' &&
        isDragging.current &&
        dragOverlay.current.dragPos &&
        dragOverlay.current.annotationId !== null
      ) {
        dispatch({
          type: 'MOVE_ANNOTATION',
          id: dragOverlay.current.annotationId,
          x: dragOverlay.current.dragPos.x,
          y: dragOverlay.current.dragPos.y,
        })
      }

      if (dt === 'resize-bbox' || dt === 'move-bbox') {
        if (isDragging.current && dragOverlay.current.bboxResizeDraft) {
          dispatch({
            type: 'RESIZE_BBOX',
            id: dragOverlay.current.bboxResizeDraft.annotationId,
            bbox: dragOverlay.current.bboxResizeDraft.bbox,
          })
        }
      }

      if (selectionRect.current && isDragging.current) {
        const sr = selectionRect.current
        const x1 = Math.min(sr.startX, sr.endX)
        const y1 = Math.min(sr.startY, sr.endY)
        const x2 = Math.max(sr.startX, sr.endX)
        const y2 = Math.max(sr.startY, sr.endY)

        const visible = getVisibleAnnotationsForState(state)
        const inside = visible.filter((ann) => {
          const [ax, ay] = vp.imageToScreen(ann.x, ann.y)
          return ax >= x1 && ax <= x2 && ay >= y1 && ay <= y2
        })

        if (inside.length > 0) {
          dispatch({
            type: 'SELECT',
            ids: inside.map((a) => a.id),
            append: e.shiftKey,
          })
        }

        selectionRect.current = null
        vp.dirty.current = true
      }

      if (lassoPath.current && isDragging.current) {
        const points = lassoPath.current.points
        if (points.length > 2) {
          const visible = getVisibleAnnotationsForState(state)
          const inside = visible.filter((ann) => {
            const [ax, ay] = vp.imageToScreen(ann.x, ann.y)
            return pointInPolygon(ax, ay, points)
          })
          if (inside.length > 0) {
            dispatch({
              type: 'SELECT',
              ids: inside.map((a) => a.id),
              append: e.shiftKey,
            })
          }
        }
        lassoPath.current = null
        vp.dirty.current = true
      }

      // Reset all drag state
      const wasPan = dragType.current === 'pan'
      dragOverlay.current = {
        annotationId: null,
        dragPos: null,
        bboxDraft: null,
        bboxResizeDraft: null,
      }
      isDragging.current = false
      dragType.current = null
      dragAnnotationOrigPos.current = null
      dragBboxHandle.current = null
      vp.dirty.current = true

      // Restore cursor after pan: grabbing if space held, grab if cmd/ctrl held, otherwise reset
      if (wasPan && canvasRef.current) {
        if (spaceHeld.current) {
          canvasRef.current.style.cursor = 'grabbing'
        } else if (e.metaKey || e.ctrlKey) {
          canvasRef.current.style.cursor = 'grab'
        } else {
          canvasRef.current.style.cursor = ''
        }
      }
    },
    [state, vp, getCanvasPos, dispatch, spaceHeld],
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const [sx, sy] = getCanvasPos(e)
      const hitId = findAnnotationAt(sx, sy)
      if (hitId !== null) {
        const ann = state.annotations.find((a) => a.id === hitId)
        if (ann && containerRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect()
          const targetScale = 4
          vp.viewport.current.scale = targetScale
          vp.viewport.current.offsetX = width / 2 - ann.x * targetScale
          vp.viewport.current.offsetY = height / 2 - ann.y * targetScale
          vp.clampViewport()
          vp.dirty.current = true
          dispatch({ type: 'SELECT', ids: [hitId] })
        }
      }
    },
    [getCanvasPos, findAnnotationAt, state.annotations, vp, dispatch],
  )

  const onMouseDownCapture = useCallback((e: React.MouseEvent) => {
    // Middle mouse button → pan
    if (e.button === 1) {
      dragType.current = 'pan'
      isDragging.current = true
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
      e.preventDefault()
    }
  }, [])

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDoubleClick}
        onMouseDownCapture={onMouseDownCapture}
        className="absolute top-0 left-0"
      />
    </div>
  )
}

function pointInPolygon(px: number, py: number, polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]![0]
    const yi = polygon[i]![1]
    const xj = polygon[j]![0]
    const yj = polygon[j]![1]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
