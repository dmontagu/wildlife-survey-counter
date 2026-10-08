import { useEffect, useState } from 'react'
import type { ViewportActions } from '../hooks/useViewport'
import type { CountingPreview, MarkerVisibilityMode } from '../types'

/** Separate from the annotation canvas so pulsing never redraws the full-resolution photo. */
export default function CountingPreviewOverlay({
  preview,
  vp,
  visibility,
}: {
  preview: CountingPreview
  vp: ViewportActions
  visibility: MarkerVisibilityMode
}) {
  const [view, setView] = useState({ ...vp.viewport.current })
  useEffect(() => {
    let frame = 0
    let previous = { ...vp.viewport.current }
    const update = () => {
      const next = vp.viewport.current
      if (next.scale !== previous.scale || next.offsetX !== previous.offsetX || next.offsetY !== previous.offsetY) {
        previous = { ...next }
        setView(previous)
      }
      frame = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [vp])

  const box = ([left, top, right, bottom]: [number, number, number, number]) => ({
    x: left * view.scale + view.offsetX,
    y: top * view.scale + view.offsetY,
    width: (right - left) * view.scale,
    height: (bottom - top) * view.scale,
  })

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="counting-preview">
      <svg className="absolute inset-0 size-full overflow-hidden" role="img" aria-label="Live AI counting preview">
        <title>Temporary detections and region progress. These may change during review.</title>
        {preview.regions.map((region) => {
          const bounds = box(region.bounds)
          const checked = region.status === 'checked'
          return (
            <g key={region.id} data-region-status={region.status}>
              <rect
                {...bounds}
                className={checked ? 'fill-none stroke-primary/45' : 'fill-background/15 stroke-foreground/35'}
                strokeWidth="1"
                strokeDasharray={checked ? undefined : '4 5'}
              />
              {checked && bounds.width > 32 && bounds.height > 32 && (
                <g transform={`translate(${bounds.x + 13} ${bounds.y + 13})`}>
                  <circle r="8" className="fill-background/75" />
                  <path d="M-4 0 L-1 3 L4 -3" className="fill-none stroke-primary" strokeWidth="1.5" />
                </g>
              )}
            </g>
          )
        })}
        {preview.focus && (
          <g>
            <rect {...box(preview.focus)} className="ai-region-pulse fill-primary stroke-primary" strokeWidth="2" />
            <rect {...box(preview.focus)} className="fill-none stroke-primary/80" strokeWidth="1.5" />
          </g>
        )}
        {visibility !== 'hidden' && (
          <g opacity={visibility === 'dimmed' ? 0.24 : 1}>
            {preview.points.map((point) => (
              <g
                key={point.id}
                data-testid="preview-detection"
                transform={`translate(${point.x * view.scale + view.offsetX} ${point.y * view.scale + view.offsetY})`}
                className="ai-preview-marker"
              >
                <circle r="6" className="fill-background/25 stroke-background/90" strokeWidth="4" />
                <circle
                  r="6"
                  className="fill-none stroke-foreground"
                  strokeWidth="1.5"
                  strokeDasharray={point.possible ? '2 3' : undefined}
                />
                <path d="M-2 0 H2 M0 -2 V2" className="stroke-foreground" strokeWidth="1" />
              </g>
            ))}
          </g>
        )}
      </svg>
      <div className="absolute bottom-16 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-popover/85 px-3 py-1.5 text-xs text-muted-foreground">
        Live preview · temporary markers
      </div>
    </div>
  )
}
