import { LoaderCircleIcon, ScanSearchIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  assertMatchingRun,
  type CountingRun,
  countingAnnotations,
  countingAppliedKey,
  countingImage,
  countingRequest,
  countingStatus,
  isCounting,
  rememberCount,
  requestedCount,
  reusableCount,
} from '../lib/counting'
import { imageStorageId, safeGetItem } from '../lib/storage'
import { useAppState, useDispatch } from '../state'
import { Button } from './ui/button'

export default function CountingControl() {
  const state = useAppState()
  const dispatch = useDispatch()
  const image = state.image
  const identity = image ? imageStorageId(image.filename, image.basePath) : ''
  const latest = useRef(state)
  const discovery = useRef(0)
  latest.current = state
  const [result, setResult] = useState<{ identity: string; run: CountingRun } | null>(null)
  const [source, setSource] = useState<{ identity: string; file: File; hash: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<{ runId: string; annotations: string } | null>(null)
  const run = result?.identity === identity ? result.run : null
  const currentSource = source?.identity === identity ? source : null
  const isCurrent = () =>
    latest.current.image && imageStorageId(latest.current.image.filename, latest.current.image.basePath) === identity

  // Recover a run whenever its image is opened, including after a refresh or time away.
  useEffect(() => {
    if (!image) return
    const generation = ++discovery.current
    let live = true
    setError(null)
    setBusy(false)
    void (async () => {
      try {
        const file = await countingImage(image)
        const runs = await countingRequest<CountingRun[]>(`runs?sha256=${file.hash}`)
        if (!live || generation !== discovery.current) return
        setSource({ ...file, identity })
        const request = requestedCount(image)
        const next = reusableCount(runs) ?? runs.find((item) => item.id === request?.runId) ?? runs[0]
        setResult(next ? { identity, run: next } : null)
        setBaseline(request ? { runId: request.runId, annotations: request.baseline } : null)
      } catch {
        // An optional local backend need not be running just to label a photo.
        // A direct request below reports connection failures inline.
      }
    })()
    return () => {
      live = false
    }
  }, [identity, image])

  useEffect(() => {
    if (!run || !isCounting(run)) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await countingRequest<CountingRun>(`runs/${run.id}`)
        if (live) {
          setResult({ identity, run: next })
          setError(null)
        }
      } catch {
        if (live) setError('Reconnecting to your count…')
      }
      if (live) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [identity, run])

  useEffect(() => {
    const matching =
      image &&
      currentSource &&
      run &&
      run.image_sha256 === currentSource.hash &&
      run.width === image.width &&
      run.height === image.height
    dispatch({
      type: 'SET_COUNTING_PREVIEW',
      imageId: identity,
      preview: matching && isCounting(run) ? (run.preview ?? null) : null,
    })
  }, [image, currentSource, run, identity, dispatch])

  useEffect(
    () => () => {
      dispatch({ type: 'SET_COUNTING_PREVIEW', imageId: identity, preview: null })
    },
    [identity, dispatch],
  )

  const delivered =
    !!run &&
    (state.appliedCountingRunId === run.id ||
      (image && safeGetItem(countingAppliedKey(image.filename, image.basePath)) === run.id))
  const expected = baseline?.runId === run?.id ? baseline?.annotations : '[]'
  const changed = JSON.stringify(state.annotations) !== expected
  const needsReview =
    changed ||
    state.annotations.some((point) => point.reviewStatus === 'confirmed' || point.state === 'manually-added')

  useEffect(() => {
    if (!image || !run || run.status !== 'complete' || !currentSource || delivered || needsReview) return
    try {
      assertMatchingRun(run, currentSource.hash, image)
      dispatch({
        type: 'APPLY_AI_COUNT',
        imageId: identity,
        runId: run.id,
        baseline: expected,
        annotations: countingAnnotations(run),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [image, run, currentSource, delivered, needsReview, identity, expected, dispatch])

  async function start() {
    if (!image || busy || run?.status === 'complete' || (run && isCounting(run))) return
    discovery.current += 1
    dispatch({ type: 'REQUEST_AI_COUNT', imageId: identity })
    const before = JSON.stringify(latest.current.annotations)
    setBusy(true)
    setError(null)
    try {
      const file = currentSource ?? (await countingImage(image))
      const runs = await countingRequest<CountingRun[]>(`runs?sha256=${file.hash}`)
      let next = reusableCount(runs)
      const request = requestedCount(image)
      // Keep the original snapshot when reconnecting; don't silently replace intervening edits.
      let snapshot = next ? (request?.runId === next.id ? request.baseline : '[]') : before
      if (!next) {
        const capabilities = await countingRequest<{ enabled: boolean }>('capabilities')
        if (!capabilities.enabled) throw new Error('AI counting is unavailable on this server.')
        const body = new FormData()
        body.append('file', file.file, image.filename)
        next = await countingRequest<CountingRun>('runs', { method: 'POST', body })
        // Another tab may have finished between lookup and POST. Preserve existing markers.
        if (next.status === 'complete') snapshot = request?.runId === next.id ? request.baseline : '[]'
      }
      rememberCount(image, next.id, snapshot)
      if (!isCurrent()) return
      setSource({ ...file, identity })
      setBaseline({ runId: next.id, annotations: snapshot })
      setResult({ identity, run: next })
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  async function cancel() {
    if (!run) return
    setBusy(true)
    try {
      const next = await countingRequest<CountingRun>(`runs/${run.id}/cancel`, { method: 'POST' })
      if (isCurrent()) setResult({ identity, run: next })
    } catch {
      if (isCurrent()) setError('Could not cancel. Try again.')
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  function replaceEditedMarkers() {
    if (!image || !run || !currentSource) return
    try {
      assertMatchingRun(run, currentSource.hash, image)
      dispatch({
        type: 'APPLY_AI_COUNT',
        imageId: identity,
        runId: run.id,
        baseline: JSON.stringify(state.annotations),
        annotations: countingAnnotations(run),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const running = !!run && isCounting(run)
  const cost = run?.estimated_cost_usd
  const formattedCost =
    typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? cost > 0 && cost < 0.01
        ? '<$0.01'
        : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cost)
      : null
  const subscription = run?.runner === 'codex'
  return (
    <div className="flex flex-wrap items-center gap-2">
      {running || busy ? (
        <>
          <output className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
            {busy
              ? running
                ? 'Cancelling count…'
                : 'Starting count…'
              : run
                ? countingStatus(run)
                : 'Starting count…'}
          </output>
          {running && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Cancel AI count"
              onClick={() => void cancel()}
              disabled={busy}
            >
              <XIcon className="size-4" />
            </Button>
          )}
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void start()}
          disabled={!image || run?.status === 'complete'}
          title={
            run?.status === 'complete'
              ? 'This image already has a saved AI count. No new analysis is needed.'
              : 'Reuse a saved count or count elk in the background. New counts can take several minutes.'
          }
        >
          <ScanSearchIcon className="size-4" /> {run?.status === 'complete' ? 'Count saved' : 'Count elk'}
        </Button>
      )}
      {!busy && !running && run && !error && (
        <output className="text-xs text-muted-foreground">
          {delivered
            ? 'AI labels added · review on image'
            : run.status === 'complete' && needsReview
              ? 'AI count ready · your edits kept'
              : countingStatus(run)}
        </output>
      )}
      {running && run.preview && (
        <output className="text-xs tabular-nums text-muted-foreground" aria-label="AI counting progress">
          {run.preview.phase === 'review'
            ? `${run.preview.neighborhoods_checked} areas rechecked`
            : `${run.preview.regions.filter((region) => region.status === 'checked').length} / ${run.preview.regions.length} regions checked`}
          {' · '}
          {run.preview.points.length} detections so far
        </output>
      )}
      {formattedCost && (
        <output
          aria-label="AI run cost"
          className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          title={`${
            subscription
              ? 'Estimated API equivalent for this subscription run; this is not an API charge.'
              : 'Estimated API cost for this run, based on reported token usage.'
          } This amount belongs to the original run. Reusing saved labels starts no new analysis.`}
        >
          {formattedCost} {subscription ? 'API equivalent (est.)' : 'estimated cost'}
        </output>
      )}
      {!busy && run?.status === 'complete' && !delivered && needsReview && !error && (
        <Button
          size="sm"
          variant="ghost"
          onClick={replaceEditedMarkers}
          title="Replace your existing markers with the AI result. You can undo this."
        >
          Use AI labels
        </Button>
      )}
      {error && (
        <span role="alert" className="max-w-72 text-xs text-muted-foreground">
          {error}
        </span>
      )}
    </div>
  )
}
