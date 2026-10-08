import { isAnnotationCategory } from '../config'
import type { Annotation, CountingPreview, ImageInfo } from '../types'
import { normalizeAnnotations } from './annotations'
import { getBrowserImageFromBasePath, isBrowserImageBasePath } from './browser-images'
import { imageStorageId, safeGetItem, safeSetItem } from './storage'

export interface PossibleAnimal {
  id: string
  x: number
  y: number
  reason: string
  decision: 'pending' | 'accept' | 'reject'
}

export interface CountingRun {
  preview?: CountingPreview
  id: string
  image_sha256: string
  image_filename: string
  width: number
  height: number
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled' | 'interrupted'
  started_at: string
  model: string
  annotations: Annotation[]
  uncertain: PossibleAnimal[]
  usage: { input_tokens?: number; cache_read_tokens?: number; output_tokens?: number; requests?: number }
  estimated_cost_usd: number | null
  billing?: string
  runner?: 'codex' | 'api'
  progress: string
  regions_total: number
  regions_recorded: number
  method_summary?: string
  error?: string
}

export const isCounting = (run: CountingRun) => run.status === 'running' || run.status === 'queued'

/** History is newest first. A failed retry must never hide a completed result. */
export function reusableCount(runs: CountingRun[]): CountingRun | undefined {
  return runs.find(isCounting) ?? runs.find((run) => run.status === 'complete')
}

async function countingClient(): Promise<string> {
  const getOrCreate = () => {
    const key = 'wsc:counting-client:v1'
    const existing = safeGetItem(key)
    if (existing) return existing
    const client = crypto.randomUUID()
    if (!safeSetItem(key, client)) throw new Error('Enable browser storage to save your private AI counts.')
    return client
  }
  // First use in two tabs must establish one shared browser identity.
  return navigator.locks ? navigator.locks.request('wsc:counting-client', getOrCreate) : getOrCreate()
}

export async function countingRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const client = await countingClient()
  const headers = new Headers(init?.headers)
  headers.set('X-Counting-Client', client)
  const response = await fetch(`/api/counting/${path}`, { ...init, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail || `Counting request failed (${response.status})`)
  }
  return response.json()
}

export async function countingImage(image: ImageInfo): Promise<{ file: File; hash: string }> {
  let file: File | null
  if (isBrowserImageBasePath(image.basePath)) {
    file = await getBrowserImageFromBasePath(image.basePath)
  } else {
    const response = await fetch(image.element.src)
    if (!response.ok) throw new Error('Could not read the original image')
    const blob = await response.blob()
    file = new File([blob], image.filename, { type: blob.type })
  }
  if (!file) throw new Error('The original image is no longer available. Reopen it before counting.')
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { file, hash }
}

export function assertMatchingRun(run: CountingRun, hash: string, image: ImageInfo): void {
  if (run.image_sha256 !== hash || run.width !== image.width || run.height !== image.height) {
    throw new Error('This result belongs to a different image. Your markers have not been changed.')
  }
  if (run.status !== 'complete') throw new Error('Only completed counts can be applied.')
}

export const countingAppliedKey = (filename: string, basePath: string) =>
  `wsc:ai-count-applied:${encodeURIComponent(imageStorageId(filename, basePath))}`

const requestKey = (image: ImageInfo) =>
  `wsc:ai-count-request:${encodeURIComponent(imageStorageId(image.filename, image.basePath))}`

export function requestedCount(image: ImageInfo): { runId: string; baseline: string } | null {
  const raw = safeGetItem(requestKey(image))
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (data.version === 1 && typeof data.runId === 'string' && typeof data.baseline === 'string') return data
  } catch {
    /* Preserve unreadable request metadata; never touch annotation storage. */
  }
  return null
}

export function rememberCount(image: ImageInfo, runId: string, baseline: string) {
  const key = requestKey(image)
  const old = safeGetItem(key)
  if (old && !requestedCount(image) && !safeSetItem(`${key}:unreadable`, old)) return
  safeSetItem(key, JSON.stringify({ version: 1, runId, baseline }))
}

/** Both definite and possible detections enter the normal canvas review workflow. */
export function countingAnnotations(run: CountingRun): Annotation[] {
  return normalizeAnnotations(
    [
      ...run.annotations.filter((point) => point.state !== 'rejected'),
      ...run.uncertain
        .filter((point) => point.decision === 'pending')
        .map((point) => ({
          x: point.x,
          y: point.y,
          category: 'unclassified',
          label: `Possible elk: ${point.reason}`,
        })),
    ].map((point, index) => ({
      ...point,
      id: index + 1,
      source: `ai-count:${run.id}`,
      category: isAnnotationCategory(point.category) ? point.category : 'unclassified',
      state: 'auto-detected',
      reviewStatus: 'unconfirmed',
    })),
  )
}

export function countingStatus(run: CountingRun): string {
  if (run.status === 'queued') return 'Waiting to count…'
  if (run.status === 'running') {
    if (run.preview?.phase === 'review') return 'Checking for missed or duplicate elk…'
    if (run.progress.includes('neighborhood') || run.progress.includes('finish')) return 'Checking labels…'
    return 'Counting elk…'
  }
  if (run.status === 'complete') return `${countingAnnotations(run).length} AI markers ready`
  if (run.status === 'cancelled') return 'Count cancelled'
  return 'Counting stopped. Try again.'
}
