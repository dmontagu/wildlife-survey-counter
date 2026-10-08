import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveBrowserImage } from '../lib/browser-images'
import {
  assertMatchingRun,
  type CountingRun,
  countingAnnotations,
  countingAppliedKey,
  countingImage,
  countingRequest,
  rememberCount,
} from '../lib/counting'
import { readRecentImages } from '../lib/recent-images'
import { annotationsStorageKey, imageStorageId } from '../lib/storage'
import { AppStateContext, DispatchContext, initialState, reducer } from '../state'
import { annotation, renderApp, stubImageLoading, totalCounted } from '../tests/helpers'
import type { CountingPreview, ImageInfo } from '../types'
import CountingControl from './CountingControl'

vi.mock('../lib/counting', async (original) => ({
  ...(await original<typeof import('../lib/counting')>()),
  countingImage: vi.fn(),
  countingRequest: vi.fn(),
}))
const image: ImageInfo = {
  filename: 'elk.jpg',
  basePath: '/samples/',
  displayName: null,
  width: 100,
  height: 100,
  element: document.createElement('img'),
}
const route = '/image/sample?f=elk.jpg'
function fixture(): CountingRun {
  return {
    id: 'run1',
    image_sha256: 'hash',
    image_filename: 'elk.jpg',
    width: 100,
    height: 100,
    status: 'complete',
    started_at: '2026-09-09T12:00:00Z',
    model: 'gpt-6-astra',
    annotations: [annotation({ id: 1, category: 'cow' }), annotation({ id: 2, category: 'bull' })],
    uncertain: [],
    usage: {},
    estimated_cost_usd: null,
    progress: 'Ready',
    regions_total: 1,
    regions_recorded: 1,
  }
}
function preview(): CountingPreview {
  return {
    regions: [{ id: 'r0c0', bounds: [0, 0, 100, 100], status: 'checked' }],
    points: [{ id: 'r0c0:points:0', x: 40, y: 50, possible: false }],
    focus: [0, 0, 100, 100],
    phase: 'review',
    neighborhoods_checked: 0,
  }
}
function backend(run: CountingRun, history = true) {
  vi.mocked(countingRequest).mockImplementation(async (path) => {
    if (path === 'capabilities') return { enabled: true }
    if (path.startsWith('runs?')) return history ? [run] : []
    return run
  })
}
beforeEach(() => {
  vi.stubEnv('VITE_AI_COUNTING', 'true')
  stubImageLoading({ width: 100, height: 100 })
  vi.mocked(countingImage).mockResolvedValue({ file: new File(['image'], 'elk.jpg'), hash: 'hash' })
  vi.mocked(countingRequest).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('background AI counting', () => {
  it('keeps a newly uploaded image in recent work while counting, then delivers on return', async () => {
    const saved = await saveBrowserImage(new File(['image'], 'elk.jpg', { type: 'image/jpeg' }))
    const localRoute = `/image/local/${saved.id}`
    let run = { ...fixture(), status: 'running' as CountingRun['status'] }
    let requested = false
    vi.mocked(countingRequest).mockImplementation(async (path) => {
      if (path === 'capabilities') return { enabled: true }
      if (path.startsWith('runs?')) return requested ? [run] : []
      requested = true
      return run
    })
    const user = userEvent.setup()
    const app = renderApp(localRoute)
    await user.click(await screen.findByRole('button', { name: 'Count elk' }))
    await screen.findByText('Counting elk…')
    await user.click(screen.getByRole('button', { name: /^Home$/ }))
    expect(readRecentImages().find((record) => record.basePath === saved.basePath)).toMatchObject({
      counted: 0,
      filename: 'elk.jpg',
    })
    run = fixture()
    app.unmount()
    renderApp(localRoute)
    await waitFor(() => expect(totalCounted()).toBe('2'))
  })
  it('automatically displays ordinary unconfirmed markers, preserving classes and including possibilities', async () => {
    const run = fixture()
    run.uncertain = [{ id: 'U1', x: 30, y: 40, reason: 'Overlap', decision: 'pending' }]
    backend(run)
    renderApp(route)
    await waitFor(() => expect(totalCounted()).toBe('3'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use/ })).not.toBeInTheDocument()
    const key = annotationsStorageKey(image.filename, image.basePath)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key) ?? '[]')).toHaveLength(3))
    const points = JSON.parse(localStorage.getItem(key) ?? '[]')
    expect(points.map((p: { reviewStatus: string }) => p.reviewStatus)).toEqual([
      'unconfirmed',
      'unconfirmed',
      'unconfirmed',
    ])
    expect(points.map((p: { category: string }) => p.category)).toEqual(['cow', 'bull', 'unclassified'])
    expect(localStorage.getItem(countingAppliedKey(image.filename, image.basePath))).toBe(run.id)
  })

  it('reuses a saved count despite a newer failed request, with no rerun button', async () => {
    const run = { ...fixture(), runner: 'codex' as const, estimated_cost_usd: 6.360954 }
    rememberCount(image, 'failed', '[]')
    vi.mocked(countingRequest).mockResolvedValue([
      { ...run, id: 'failed', status: 'error', estimated_cost_usd: 99 },
      run,
    ])
    const user = userEvent.setup()
    renderApp(route)
    await waitFor(() => expect(totalCounted()).toBe('2'))
    const saved = screen.getByRole('button', { name: 'Count saved' })
    expect(saved).toBeDisabled()
    expect(screen.getByLabelText('AI run cost')).toHaveTextContent('$6.36 API equivalent (est.)')
    expect(screen.getByLabelText('AI run cost')).toHaveAttribute('title', expect.stringContaining('not an API charge'))
    await user.click(saved)
    expect(countingRequest).not.toHaveBeenCalledWith('runs', expect.anything())
  })

  it('checks for cached work on demand even if initial discovery missed it', async () => {
    let available = false
    vi.mocked(countingRequest).mockImplementation(async (path) => {
      if (path.startsWith('runs?')) return available ? [fixture()] : []
      throw new Error('No new model call expected')
    })
    const user = userEvent.setup()
    renderApp(route)
    await screen.findByRole('button', { name: 'Count elk' })
    await waitFor(() => expect(countingRequest).toHaveBeenCalledWith('runs?sha256=hash'))
    await act(async () => {})
    available = true
    await user.click(screen.getByRole('button', { name: 'Count elk' }))
    await waitFor(() => expect(totalCounted()).toBe('2'))
    expect(countingRequest).not.toHaveBeenCalledWith('runs', expect.anything())
  })

  it('reconnects to active work instead of using an older result or starting another run', async () => {
    const active = { ...fixture(), id: 'active', status: 'running' as const }
    vi.mocked(countingRequest).mockImplementation(async (path) => {
      if (path.startsWith('runs?')) return [fixture(), active]
      return active
    })
    renderApp(route)
    await screen.findByText('Counting elk…')
    expect(totalCounted()).toBe('0')
    expect(screen.queryByRole('button', { name: 'Count elk' })).not.toBeInTheDocument()
    expect(countingRequest).not.toHaveBeenCalledWith('runs', expect.anything())
  })

  it.each([
    'complete',
    'cancelled',
    'error',
  ] as const)('shows ephemeral progress then removes it on %s', async (status) => {
    let run: CountingRun = { ...fixture(), status: 'running', preview: preview() }
    vi.mocked(countingRequest).mockImplementation(async (path) => (path.startsWith('runs?') ? [run] : run))
    const app = renderApp(route)
    await screen.findByRole('img', { name: 'Live AI counting preview' })
    expect(screen.getAllByTestId('preview-detection')).toHaveLength(1)
    expect(screen.getByLabelText('AI counting progress')).toHaveTextContent('1 detections so far')
    expect(totalCounted()).toBe('0')
    expect(screen.getByRole('button', { name: /Undo/ })).toBeDisabled()
    // Replace, rather than append, an intermediate snapshot when the agent removes a detection.
    run = { ...run, preview: { ...preview(), points: [] } }
    await waitFor(() => expect(screen.queryByTestId('preview-detection')).not.toBeInTheDocument(), { timeout: 4000 })
    expect(localStorage.getItem(countingAppliedKey(image.filename, image.basePath))).toBeNull()
    expect(JSON.parse(localStorage.getItem(annotationsStorageKey(image.filename, image.basePath)) ?? '[]')).toEqual([])
    run = { ...run, status }
    await waitFor(() => expect(screen.queryByTestId('counting-preview')).not.toBeInTheDocument(), { timeout: 4000 })
    expect(totalCounted()).toBe(status === 'complete' ? '2' : '0')
    app.unmount()
  }, 10000)

  it('starts on demand and adds completed results without another click', async () => {
    let run = { ...fixture(), status: 'running' as CountingRun['status'] }
    vi.mocked(countingRequest).mockImplementation(async (path) => {
      if (path === 'capabilities') return { enabled: true }
      if (path.startsWith('runs?')) return []
      return run
    })
    const user = userEvent.setup()
    renderApp(route)
    await user.click(await screen.findByRole('button', { name: 'Count elk' }))
    await screen.findByText('Counting elk…')
    expect(totalCounted()).toBe('0')
    run = fixture()
    await waitFor(() => expect(totalCounted()).toBe('2'), { timeout: 4000 })
    expect(countingRequest).toHaveBeenCalledWith('runs', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps an undone result undone after saving and reopening (v1 delivery receipt snapshot)', async () => {
    const run = fixture()
    backend(run)
    const user = userEvent.setup()
    const app = renderApp(route)
    await waitFor(() => expect(totalCounted()).toBe('2'))
    await user.click(screen.getByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(totalCounted()).toBe('0'))
    await waitFor(() => expect(localStorage.getItem(countingAppliedKey(image.filename, image.basePath))).toBe(run.id))
    app.unmount()
    renderApp(route)
    await screen.findByRole('button', { name: 'Count saved' })
    await screen.findByText('AI labels added · review on image')
    expect(totalCounted()).toBe('0')
  })

  it('retrieves a completed background run when returning, without putting its markers on another photo', async () => {
    const run = fixture()
    rememberCount(image, run.id, '[]')
    vi.mocked(countingImage).mockImplementation(async (photo) => ({
      file: new File(['image'], photo.filename),
      hash: photo.filename === 'elk.jpg' ? 'hash' : 'other',
    }))
    vi.mocked(countingRequest).mockImplementation(async (path) => (path === 'runs?sha256=hash' ? [run] : []))
    const other = renderApp('/image/sample?f=other.jpg')
    await screen.findByRole('button', { name: 'Count elk' })
    await act(async () => {})
    expect(totalCounted()).toBe('0')
    other.unmount()
    renderApp(route)
    await waitFor(() => expect(totalCounted()).toBe('2'))
  })

  it.each([
    true,
    false,
  ])('preserves existing review or concurrent edits (reviewed=%s), with undoable inline replacement', async (reviewed) => {
    const previous = [
      annotation({
        id: 99,
        state: reviewed ? 'manually-added' : 'auto-detected',
        reviewStatus: reviewed ? 'confirmed' : 'unconfirmed',
      }),
    ]
    rememberCount(image, 'run1', reviewed ? JSON.stringify(previous) : '[]')
    backend(fixture())
    function Harness() {
      const [state, dispatch] = useReducer(reducer, { ...initialState, image, annotations: [annotation({ id: 99 })] })
      return (
        <AppStateContext.Provider value={state}>
          <DispatchContext.Provider value={dispatch}>
            <CountingControl />
            <output data-testid="count">{state.annotations.length}</output>
            <button type="button" onClick={() => dispatch({ type: 'UNDO' })}>
              Undo test
            </button>
          </DispatchContext.Provider>
        </AppStateContext.Provider>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('button', { name: 'Use AI labels' })
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    await user.click(screen.getByRole('button', { name: 'Use AI labels' }))
    expect(screen.getByTestId('count')).toHaveTextContent('2')
    await user.click(screen.getByRole('button', { name: 'Undo test' }))
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    expect(screen.queryByRole('button', { name: 'Use AI labels' })).not.toBeInTheDocument()
  })

  it('refuses mismatched or unfinished results and guards queued reducer actions against image switches', () => {
    const run = fixture()
    expect(() => assertMatchingRun({ ...run, image_sha256: 'other' }, 'hash', image)).toThrow('different image')
    expect(() => assertMatchingRun({ ...run, status: 'error' }, 'hash', image)).toThrow('completed')
    const withPreview = reducer(
      { ...initialState, image },
      {
        type: 'SET_COUNTING_PREVIEW',
        imageId: imageStorageId(image.filename, image.basePath),
        preview: preview(),
      },
    )
    expect(withPreview.annotations).toBe(initialState.annotations)
    expect(withPreview.undoStack).toBe(initialState.undoStack)
    expect(
      reducer(withPreview, { type: 'LOAD_IMAGE', image: { ...image, filename: 'other.jpg' } }).countingPreview,
    ).toBeNull()
    expect(reducer(withPreview, { type: 'SET_COUNTING_PREVIEW', imageId: 'wrong', preview: null })).toBe(withPreview)
    const current = { ...initialState, image: { ...image, filename: 'other.jpg' } }
    expect(
      reducer(current, {
        type: 'APPLY_AI_COUNT',
        imageId: imageStorageId(image.filename, image.basePath),
        runId: run.id,
        baseline: '[]',
        annotations: countingAnnotations(run),
      }),
    ).toBe(current)
  })
})
