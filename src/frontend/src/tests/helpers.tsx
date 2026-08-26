import { type RenderResult, render, screen, within } from '@testing-library/react'
import App from '../App'
import { emptyCategoryCounts } from '../lib/annotations'
import type { Annotation, AnnotationCategory, AnnotationState, RecentImageRecord } from '../types'

/**
 * jsdom never fetches an image, so `img.onload` would never fire and no App-level test could get
 * past "opening an image". Patching the `src` setter to resolve with fixed dimensions is the
 * smallest stand-in that keeps the real component code path intact.
 *
 * The load event is queued as a microtask rather than a timer so it stays independent of any test
 * that controls timers.
 */
export function stubImageLoading({ width = 1200, height = 900 }: { width?: number; height?: number } = {}) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get(this: HTMLImageElement) {
      return this.getAttribute('src') ?? ''
    },
    set(this: HTMLImageElement, value: string) {
      this.setAttribute('src', value)
      Object.defineProperty(this, 'width', { value: width, configurable: true })
      Object.defineProperty(this, 'height', { value: height, configurable: true })
      Object.defineProperty(this, 'naturalWidth', { value: width, configurable: true })
      Object.defineProperty(this, 'naturalHeight', { value: height, configurable: true })
      queueMicrotask(() => this.dispatchEvent(new Event('load')))
    },
  })
}

export function renderApp(path = '/'): RenderResult {
  window.history.replaceState({}, '', path)
  return render(<App />)
}

/**
 * Read one count off the status bar. Class names such as "Cow" also appear in the class palette, so
 * the lookup is scoped to the row of chips the status bar renders.
 */
export function statusCount(label: string): string {
  const chips = screen.getByText('Total Counted').parentElement?.parentElement
  if (!chips) throw new Error('The status bar is not on screen.')
  return within(chips).getByText(label).nextElementSibling?.textContent ?? ''
}

export function queryStatusCount(label: string): string | null {
  const chips = screen.getByText('Total Counted').parentElement?.parentElement
  if (!chips) throw new Error('The status bar is not on screen.')
  return within(chips).queryByText(label)?.nextElementSibling?.textContent ?? null
}

export function totalCounted(): string {
  return statusCount('Total Counted')
}

let nextAnnotationId = 1

export function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: nextAnnotationId++,
    x: 100,
    y: 200,
    bbox: null,
    detection_confidence: null,
    classification_confidence: null,
    source: 'manual',
    label: 'elk',
    category: 'cow' as AnnotationCategory,
    state: 'manually-added' as AnnotationState,
    reviewStatus: 'confirmed',
    ...overrides,
  }
}

/** A run of annotations with distinct ids and positions — the usual shape of a real day's work. */
export function annotations(count: number, overrides: Partial<Annotation> = {}): Annotation[] {
  return Array.from({ length: count }, (_, index) =>
    annotation({ id: index + 1, x: 10 * (index + 1), y: 20 * (index + 1), ...overrides }),
  )
}

export function recentImageRecord(overrides: Partial<RecentImageRecord> = {}): RecentImageRecord {
  const filename = overrides.filename ?? 'survey-01.jpg'
  const basePath = overrides.basePath ?? '/uploads/'
  return {
    id: `${basePath}|${filename}`,
    filename,
    displayName: null,
    basePath,
    width: 1200,
    height: 900,
    lastEditedAt: '2026-01-01T00:00:00.000Z',
    counted: 0,
    ignored: 0,
    // Per-class counts come from the category table, so a new class needs no edit here.
    ...emptyCategoryCounts(),
    ...overrides,
  }
}

/** Snapshot of every `wsc:` key, so a test can prove a whole storage area survived an operation. */
export function readWscStorage(): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith('wsc:')) snapshot[key] = localStorage.getItem(key) ?? ''
  }
  return snapshot
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
