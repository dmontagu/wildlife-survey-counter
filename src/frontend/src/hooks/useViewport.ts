import { useCallback, useMemo, useRef } from 'react'
import { isMac } from '../platform'

export interface Viewport {
  offsetX: number
  offsetY: number
  scale: number
}

export interface ViewportActions {
  viewport: React.MutableRefObject<Viewport>
  dirty: React.MutableRefObject<boolean>
  /** Image dimensions — set when image loads, used for pan clamping */
  imageSize: React.MutableRefObject<{ w: number; h: number }>
  /** Canvas CSS dimensions — set by ResizeObserver, used for pan clamping */
  canvasSize: React.MutableRefObject<{ w: number; h: number }>
  /** Zoom speed multiplier (0.25–4.0, default 1.0) */
  zoomSpeed: React.MutableRefObject<number>
  /** Whether Space is currently held (set by Canvas, read by handleWheel for zoom) */
  spaceHeld: React.MutableRefObject<boolean>
  imageToScreen: (ix: number, iy: number) => [number, number]
  screenToImage: (sx: number, sy: number) => [number, number]
  fitToWindow: (imgW: number, imgH: number, canvasW: number, canvasH: number) => void
  clampViewport: () => void
  handleWheel: (e: WheelEvent) => void
  getZoomLevel: () => number
}

// Minimum image pixels that must stay visible on each axis
const MIN_VISIBLE = 100

export function useViewport(): ViewportActions {
  const viewport = useRef<Viewport>({ offsetX: 0, offsetY: 0, scale: 1 })
  const dirty = useRef(true)
  const imageSize = useRef({ w: 0, h: 0 })
  const canvasSize = useRef({ w: 0, h: 0 })
  const zoomSpeed = useRef(1)
  const spaceHeld = useRef(false)

  const imageToScreen = useCallback((ix: number, iy: number): [number, number] => {
    const v = viewport.current
    return [ix * v.scale + v.offsetX, iy * v.scale + v.offsetY]
  }, [])

  const screenToImage = useCallback((sx: number, sy: number): [number, number] => {
    const v = viewport.current
    return [(sx - v.offsetX) / v.scale, (sy - v.offsetY) / v.scale]
  }, [])

  const clampViewport = useCallback(() => {
    const v = viewport.current
    const img = imageSize.current
    const cvs = canvasSize.current
    if (img.w === 0 || img.h === 0) return

    const imgScreenW = img.w * v.scale
    const imgScreenH = img.h * v.scale
    const minVis = Math.min(MIN_VISIBLE, imgScreenW, imgScreenH)

    // Image right edge must be at least minVis into the canvas from the left
    // Image left edge must be at least minVis before the canvas right edge
    v.offsetX = Math.max(minVis - imgScreenW, Math.min(cvs.w - minVis, v.offsetX))
    v.offsetY = Math.max(minVis - imgScreenH, Math.min(cvs.h - minVis, v.offsetY))
  }, [])

  const fitToWindow = useCallback((imgW: number, imgH: number, canvasW: number, canvasH: number) => {
    if (canvasW <= 0 || canvasH <= 0 || imgW <= 0 || imgH <= 0) return
    const scaleX = canvasW / imgW
    const scaleY = canvasH / imgH
    const scale = Math.min(scaleX, scaleY) * 0.95
    viewport.current = {
      scale,
      offsetX: (canvasW - imgW * scale) / 2,
      offsetY: (canvasH - imgH * scale) / 2,
    }
    imageSize.current = { w: imgW, h: imgH }
    canvasSize.current = { w: canvasW, h: canvasH }
    dirty.current = true
  }, [])

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const v = viewport.current

      // Zoom when: Cmd/Ctrl+scroll, Space+scroll, or on Windows bare scroll always zooms
      const shouldZoom = e.metaKey || e.ctrlKey || spaceHeld.current || !isMac
      if (shouldZoom) {
        // Zoom on cursor
        const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top

        const imgX = (mouseX - v.offsetX) / v.scale
        const imgY = (mouseY - v.offsetY) / v.scale

        // Normalize deltaY across input devices:
        // - Trackpads send deltaMode=0 with small pixel deltas (1-10)
        // - Mouse wheels send deltaMode=0 with large deltas (~100) or deltaMode=1 (lines)
        let dy = e.deltaY
        if (e.deltaMode === 1) dy *= 16 // line mode -> approximate pixels
        // Continuous zoom: larger delta = more zoom. 300px of scroll ~ 2x zoom.
        // Apply zoom speed multiplier.
        const factor = 2 ** ((-dy * zoomSpeed.current) / 300)
        const newScale = Math.max(0.01, Math.min(200, v.scale * factor))

        v.scale = newScale
        v.offsetX = mouseX - imgX * newScale
        v.offsetY = mouseY - imgY * newScale
        clampViewport()
      } else {
        // Pan (Mac trackpad two-finger scroll)
        v.offsetX -= e.deltaX
        v.offsetY -= e.deltaY
        clampViewport()
      }
      dirty.current = true
    },
    [clampViewport],
  )

  const getZoomLevel = useCallback(() => viewport.current.scale, [])

  return useMemo(
    () => ({
      viewport,
      dirty,
      imageSize,
      canvasSize,
      zoomSpeed,
      spaceHeld,
      imageToScreen,
      screenToImage,
      fitToWindow,
      clampViewport,
      handleWheel,
      getZoomLevel,
    }),
    [imageToScreen, screenToImage, fitToWindow, clampViewport, handleWheel, getZoomLevel],
  )
}
