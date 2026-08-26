import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAnnotations } from './lib/annotations'
import { readRecentImages } from './lib/recent-images'
import { annotationsStorageKey, LS_IMAGE_KEY, LS_RECENT_IMAGES_KEY, legacyAnnotationsStorageKey } from './lib/storage'
import { queryStatusCount, renderApp, statusCount, stubImageLoading, totalCounted, wait } from './tests/helpers'

/**
 * Upgrade tests. Each snapshot below is the browser storage a *previously shipped* build left
 * behind; the assertion is that today's build opens it and the reviewer's counts are all still
 * there. Adding a new snapshot whenever the stored shape changes is what keeps a future release
 * from quietly breaking work that someone spent hours on.
 *
 * The rule these encode: a build may migrate stored data, but it may never delete what it could
 * not understand.
 */

const FILENAME = 'survey-01.jpg'
const BASE_PATH = '/uploads/'
const ROUTE = '/image/uploads?f=survey-01.jpg'
const CURRENT_KEY = annotationsStorageKey(FILENAME, BASE_PATH)

/** Longer than the 500ms autosave debounce, so any migration write has settled. */
const PAST_THE_AUTOSAVE = 900

function storedAnnotations(key = CURRENT_KEY) {
  return normalizeAnnotations(JSON.parse(localStorage.getItem(key) ?? '[]'))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('storage written before annotations were keyed by image source', () => {
  /** The oldest shape: one global list, valid only for whatever `wsc:image` named. */
  function seedGlobalLegacy() {
    localStorage.setItem(LS_IMAGE_KEY, FILENAME)
    localStorage.setItem(
      'wsc:annotations',
      JSON.stringify([
        { id: 1, x: 10, y: 20, label: 'elk', state: 'confirmed' },
        { id: 2, x: 30, y: 40, label: 'bull elk', state: 'confirmed' },
        { id: 3, x: 50, y: 60, label: 'elk', state: 'rejected' },
      ]),
    )
  }

  it('reopens the image with every annotation intact', async () => {
    stubImageLoading()
    seedGlobalLegacy()

    renderApp(ROUTE)

    await waitFor(() => expect(totalCounted()).toBe('2'))
    expect(statusCount('Bull')).toBe('1')
  })

  it('moves the list to the per-image key without changing what it contains', async () => {
    stubImageLoading()
    seedGlobalLegacy()

    renderApp(ROUTE)
    await waitFor(() => expect(totalCounted()).toBe('2'))
    await wait(PAST_THE_AUTOSAVE)

    expect(storedAnnotations()).toHaveLength(3)
    expect(storedAnnotations().map((item) => item.category)).toEqual(['cow', 'bull', 'cow'])
    expect(localStorage.getItem('wsc:annotations')).toBeNull()
  })

  it('keeps the old copy when the migrating write cannot be made', async () => {
    stubImageLoading()
    seedGlobalLegacy()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    renderApp(ROUTE)
    await waitFor(() => expect(totalCounted()).toBe('2'))
    await wait(PAST_THE_AUTOSAVE)

    // The migration failed, so the source of truth must still be the old key.
    expect(JSON.parse(localStorage.getItem('wsc:annotations') ?? 'null')).toHaveLength(3)
  })

  it('does not hand one image the annotations another image saved globally', async () => {
    stubImageLoading()
    localStorage.setItem(LS_IMAGE_KEY, 'a-different-image.jpg')
    localStorage.setItem('wsc:annotations', JSON.stringify([{ id: 1, x: 1, y: 1 }]))

    renderApp(ROUTE)

    await waitFor(() => expect(totalCounted()).toBe('0'))
    expect(localStorage.getItem('wsc:annotations')).not.toBeNull()
  })
})

describe('storage written before annotation keys included the image source', () => {
  function seedPerFilenameLegacy() {
    localStorage.setItem(
      legacyAnnotationsStorageKey(FILENAME),
      JSON.stringify([
        { id: 1, x: 10, y: 20, category: null, label: 'elk', state: 'confirmed' },
        { id: 2, x: 30, y: 40, category: null, label: 'elk', state: 'manually-added' },
        { id: 3, x: 50, y: 60, category: null, label: 'elk', state: 'auto-detected' },
        { id: 4, x: 70, y: 80, category: null, label: 'elk', state: 'confirmed' },
      ]),
    )
  }

  it('reopens the image with every annotation intact', async () => {
    stubImageLoading()
    seedPerFilenameLegacy()

    renderApp(ROUTE)

    await waitFor(() => expect(totalCounted()).toBe('4'))
  })

  it('rewrites the key and keeps the positions and classes', async () => {
    stubImageLoading()
    seedPerFilenameLegacy()

    renderApp(ROUTE)
    await waitFor(() => expect(totalCounted()).toBe('4'))
    await wait(PAST_THE_AUTOSAVE)

    expect(storedAnnotations().map((item) => [item.x, item.y, item.category])).toEqual([
      [10, 20, 'cow'],
      [30, 40, 'cow'],
      [50, 60, 'cow'],
      [70, 80, 'cow'],
    ])
    expect(localStorage.getItem(legacyAnnotationsStorageKey(FILENAME))).toBeNull()
  })

  it('keeps the old copy when the migrating write cannot be made', async () => {
    stubImageLoading()
    seedPerFilenameLegacy()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    renderApp(ROUTE)
    await waitFor(() => expect(totalCounted()).toBe('4'))
    await wait(PAST_THE_AUTOSAVE)

    expect(JSON.parse(localStorage.getItem(legacyAnnotationsStorageKey(FILENAME)) ?? 'null')).toHaveLength(4)
  })

  it('prefers the current key when both are present, and does not merge them', async () => {
    stubImageLoading()
    seedPerFilenameLegacy()
    localStorage.setItem(CURRENT_KEY, JSON.stringify([{ id: 9, x: 1, y: 1, category: 'bull' }]))

    renderApp(ROUTE)

    await waitFor(() => expect(totalCounted()).toBe('1'))
    expect(storedAnnotations()).toHaveLength(1)
  })
})

describe('annotations written before the current set of classes existed', () => {
  it('restores every class that a shipped build could have written', async () => {
    stubImageLoading()
    localStorage.setItem(
      CURRENT_KEY,
      JSON.stringify([
        { id: 1, x: 10, y: 10, category: 'cow', label: 'elk', state: 'confirmed' },
        { id: 2, x: 20, y: 20, category: 'bull', label: 'elk', state: 'confirmed' },
        { id: 3, x: 30, y: 30, category: 'spike', label: 'elk', state: 'confirmed' },
        { id: 4, x: 40, y: 40, category: 'unclassified-antlerless', label: 'elk', state: 'confirmed' },
        { id: 5, x: 50, y: 50, category: 'unclassified', label: 'elk', state: 'confirmed' },
      ]),
    )

    renderApp(ROUTE)

    await waitFor(() => expect(totalCounted()).toBe('5'))
    for (const label of ['Cow', 'Bull', 'Spike', 'Antlerless', 'Unclassified']) {
      expect(statusCount(label)).toBe('1')
    }
  })

  it('keeps an annotation whose class this build does not recognise', async () => {
    stubImageLoading()
    localStorage.setItem(
      CURRENT_KEY,
      JSON.stringify([
        { id: 1, x: 10, y: 10, category: 'calf', label: 'calf elk', state: 'confirmed' },
        { id: 2, x: 20, y: 20, category: 'cow', label: 'elk', state: 'confirmed' },
      ]),
    )

    renderApp(ROUTE)

    // The class is lost, but the count and the marker position are not. Reclassifying is a minute's
    // work; re-counting a photo is an afternoon's.
    await waitFor(() => expect(totalCounted()).toBe('2'))
    await wait(PAST_THE_AUTOSAVE)
    expect(storedAnnotations().map((item) => [item.x, item.y])).toEqual([
      [10, 10],
      [20, 20],
    ])
  })

  it('restores work that predates review status and per-annotation confidence', async () => {
    stubImageLoading()
    localStorage.setItem(
      CURRENT_KEY,
      JSON.stringify([
        { id: 1, x: 10, y: 20 },
        { id: 2, x: 30, y: 40 },
      ]),
    )

    renderApp(ROUTE)

    await waitFor(() => expect(totalCounted()).toBe('2'))
    expect(queryStatusCount('Unconfirmed')).toBeNull()
  })
})

describe('recent work written by an earlier build', () => {
  it('lists images whose records predate the current classes', async () => {
    localStorage.setItem(
      LS_RECENT_IMAGES_KEY,
      JSON.stringify([
        {
          id: '/uploads/|old-survey.jpg',
          filename: 'old-survey.jpg',
          basePath: '/uploads/',
          width: 800,
          height: 600,
          lastOpenedAt: '2025-03-01T00:00:00.000Z',
          counted: 9,
          ignored: 2,
          cows: 7,
          bulls: 2,
        },
      ]),
    )

    renderApp('/')

    expect(await screen.findByText('old-survey.jpg')).toBeInTheDocument()
    expect(screen.getByText(/2 bulls/)).toBeInTheDocument()
    expect(readRecentImages()[0]).toMatchObject({
      filename: 'old-survey.jpg',
      lastEditedAt: '2025-03-01T00:00:00.000Z',
      spikes: 0,
      unclassified: 0,
      unclassifiedAntlerless: 0,
    })
  })

  it('does not discard saved annotations when the recent-work list is unreadable', async () => {
    stubImageLoading()
    localStorage.setItem(CURRENT_KEY, JSON.stringify([{ id: 1, x: 1, y: 2 }]))
    localStorage.setItem(LS_RECENT_IMAGES_KEY, '<<< not json >>>')

    renderApp(ROUTE)
    await waitFor(() => expect(totalCounted()).toBe('1'))
    await wait(PAST_THE_AUTOSAVE)

    expect(storedAnnotations()).toHaveLength(1)
  })
})
