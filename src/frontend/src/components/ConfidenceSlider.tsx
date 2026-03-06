import { useCallback, useEffect, useRef } from 'react'
import { useAppState, useDispatch } from '../state'
import { Button } from './ui/button'

export default function ConfidenceSlider() {
  const state = useAppState()
  const dispatch = useDispatch()
  const histogramRef = useRef<HTMLCanvasElement>(null)

  const hasConfidence = state.annotations.some((a) => a.detection_confidence !== null)

  useEffect(() => {
    const canvas = histogramRef.current
    if (!canvas || !hasConfidence) return

    const ctx = canvas.getContext('2d')!
    const w = canvas.width
    const h = canvas.height
    const bins = 50
    const counts = new Array(bins).fill(0) as number[]

    for (const ann of state.annotations) {
      if (ann.detection_confidence === null) continue
      const bin = Math.min(bins - 1, Math.floor(ann.detection_confidence * bins))
      counts[bin] = (counts[bin] ?? 0) + 1
    }

    const maxCount = Math.max(1, ...counts)

    ctx.clearRect(0, 0, w, h)

    const barW = w / bins
    for (let i = 0; i < bins; i++) {
      const barH = (counts[i]! / maxCount) * h
      const binCenter = (i + 0.5) / bins
      ctx.fillStyle = binCenter < state.confidenceThreshold ? 'rgba(239, 68, 68, 0.45)' : 'rgba(34, 197, 94, 0.45)'
      ctx.fillRect(i * barW, h - barH, barW - 0.5, barH)
    }

    // Threshold line
    const tx = state.confidenceThreshold * w
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(tx, 0)
    ctx.lineTo(tx, h)
    ctx.stroke()
  }, [state.annotations, state.confidenceThreshold, hasConfidence])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      dispatch({
        type: 'SET_THRESHOLD',
        threshold: Number.parseFloat(e.target.value),
      })
    },
    [dispatch],
  )

  const handleCommit = useCallback(() => {
    dispatch({ type: 'COMMIT_THRESHOLD' })
  }, [dispatch])

  if (!hasConfidence) return null

  const belowCount = state.annotations.filter(
    (a) =>
      a.detection_confidence !== null &&
      a.detection_confidence < state.confidenceThreshold &&
      a.state === 'auto-detected',
  ).length

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Conf</span>
      <div className="relative w-[120px] h-6 rounded border border-border bg-secondary overflow-hidden">
        <canvas ref={histogramRef} width={120} height={24} className="absolute inset-0" />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={state.confidenceThreshold}
          onChange={handleChange}
          className="absolute inset-0 w-[120px] h-6 opacity-[0.01] cursor-pointer"
        />
      </div>
      <span className="text-xs text-muted-foreground min-w-[30px] tabular-nums">
        {state.confidenceThreshold.toFixed(2)}
      </span>
      {belowCount > 0 && (
        <Button variant="destructive" size="xs" onClick={handleCommit}>
          Reject {belowCount}
        </Button>
      )}
    </div>
  )
}
