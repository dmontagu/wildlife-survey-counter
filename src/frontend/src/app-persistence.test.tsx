import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAnnotations } from './lib/annotations'
import { readRecentImages, writeRecentImages } from './lib/recent-images'
import {
  annotationsStorageKey,
  LS_ACTIVE_CATEGORY_KEY,
  LS_IMAGE_BASE_KEY,
  LS_IMAGE_KEY,
  LS_MARKER_VISIBILITY_KEY,
  LS_RECENT_IMAGES_KEY,
  LS_ZOOM_SPEED_KEY,
  unreadableAnnotationsKey,
} from './lib/storage'
import {
  annotations,
  readWscStorage,
  recentImageRecord,
  renderApp,
  stubImageLoading,
  totalCounted,
  wait,
} from './tests/helpers'
import type { Annotation } from './types'

/**
 * These tests exercise the whole persistence loop through the real component tree: open an image,
 * change something, wait out the 500ms autosave debounce, and inspect what actually landed in
 * browser storage. They are deliberately about bytes rather than pixels — the failure mode they
 * exist to catch is a release that loses a reviewer's counts, not one that draws them wrongly.
 */

const IMAGE = { filename: 'survey-01.jpg', basePath: '/uploads/', route: '/image/uploads?f=survey-01.jpg' }
const ANNOTATION_KEY = annotationsStorageKey(IMAGE.filename, IMAGE.basePath)

/** Longer than the autosave debounce, so a save that is going to happen has happened. */
const PAST_THE_AUTOSAVE = 900

function seedSavedWork(count: number, overrides: Partial<Annotation> = {}): Annotation[] {
  const saved = annotations(count, overrides)
  localStorage.setItem(ANNOTATION_KEY, JSON.stringify(saved))
  return saved
}

function jsonFile(contents: unknown, name = 'import.json'): File {
  return new File([JSON.stringify(contents)], name, { type: 'application/json' })
}

/** The app listens for a window-level drop, which is the least synthetic way to import a file. */
function dropFile(file: File) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
  window.dispatchEvent(event)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('restoring saved work', () => {
  it('restores every saved annotation when the image is reopened', async () => {
    stubImageLoading()
    seedSavedWork(7)

    renderApp(IMAGE.route)

    await waitFor(() => expect(totalCounted()).toBe('7'))
  })

  it('leaves the stored payload byte-identical when nothing was edited', async () => {
    stubImageLoading()
    const saved = seedSavedWork(4)
    const before = JSON.stringify(saved)

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('4'))
    await wait(PAST_THE_AUTOSAVE)

    expect(localStorage.getItem(ANNOTATION_KEY)).toBe(before)
  })

  it('does not bump "last edited" just because an old save was migrated on load', async () => {
    stubImageLoading()
    // A save from before classes existed: `category: null` meant cow.
    localStorage.setItem(
      ANNOTATION_KEY,
      JSON.stringify([
        { id: 1, x: 10, y: 20, category: null, label: 'elk', state: 'confirmed' },
        { id: 2, x: 30, y: 40, category: null, label: 'elk', state: 'confirmed' },
      ]),
    )
    writeRecentImages([recentImageRecord({ ...IMAGE, counted: 2, cows: 2, lastEditedAt: '2025-01-01T00:00:00.000Z' })])

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('2'))
    await wait(PAST_THE_AUTOSAVE)

    expect(readRecentImages()[0]?.lastEditedAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('restores the reviewer preferences that were saved alongside the work', async () => {
    stubImageLoading()
    localStorage.setItem(LS_ACTIVE_CATEGORY_KEY, 'spike')
    localStorage.setItem(LS_MARKER_VISIBILITY_KEY, 'dimmed')
    localStorage.setItem(LS_ZOOM_SPEED_KEY, '2.5')
    seedSavedWork(2)

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('2'))

    expect(localStorage.getItem(LS_ACTIVE_CATEGORY_KEY)).toBe('spike')
    expect(localStorage.getItem(LS_MARKER_VISIBILITY_KEY)).toBe('dimmed')
    expect(localStorage.getItem(LS_ZOOM_SPEED_KEY)).toBe('2.5')
  })
})

describe('saved work that this build cannot read', () => {
  const CORRUPT = '[{"id":1,"x":10,"y":20},{"id":2,'

  it('never overwrites an unreadable payload with an empty list', async () => {
    stubImageLoading()
    localStorage.setItem(ANNOTATION_KEY, CORRUPT)

    renderApp(IMAGE.route)
    await wait(PAST_THE_AUTOSAVE)

    // Whatever else happens, the reviewer's bytes are still somewhere in this browser.
    expect(Object.values(readWscStorage())).toContain(CORRUPT)
  })

  it('sets the unreadable payload aside under a recoverable key', async () => {
    stubImageLoading()
    localStorage.setItem(ANNOTATION_KEY, CORRUPT)

    renderApp(IMAGE.route)
    await wait(PAST_THE_AUTOSAVE)

    expect(localStorage.getItem(unreadableAnnotationsKey(IMAGE.filename, IMAGE.basePath))).toBe(CORRUPT)
  })

  it('tells the reviewer that nothing was deleted', async () => {
    stubImageLoading()
    localStorage.setItem(ANNOTATION_KEY, CORRUPT)

    renderApp(IMAGE.route)

    expect(await screen.findByText(/could not be read/i)).toHaveTextContent(/nothing was deleted/i)
  })

  it('keeps the first copy when the image is opened again', async () => {
    stubImageLoading()
    localStorage.setItem(ANNOTATION_KEY, CORRUPT)

    const first = renderApp(IMAGE.route)
    await wait(PAST_THE_AUTOSAVE)
    first.unmount()

    renderApp(IMAGE.route)
    await wait(PAST_THE_AUTOSAVE)

    expect(localStorage.getItem(unreadableAnnotationsKey(IMAGE.filename, IMAGE.basePath))).toBe(CORRUPT)
  })
})

describe('saving edits', () => {
  it('writes imported annotations under this image and nothing else', async () => {
    stubImageLoading()
    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('0'))

    dropFile(jsonFile({ annotations: [{ id: 1, x: 5, y: 6, category: 'bull' }] }))
    await waitFor(() => expect(totalCounted()).toBe('1'))
    await waitFor(() =>
      expect(normalizeAnnotations(JSON.parse(localStorage.getItem(ANNOTATION_KEY) ?? '[]'))).toHaveLength(1),
    )

    const stored = normalizeAnnotations(JSON.parse(localStorage.getItem(ANNOTATION_KEY) ?? '[]'))
    expect(stored[0]).toMatchObject({ x: 5, y: 6, category: 'bull' })
  })

  it('asks before replacing work that is already on the image, and can be undone', async () => {
    const user = userEvent.setup()
    stubImageLoading()
    seedSavedWork(3)

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('3'))

    dropFile(jsonFile({ annotations: [{ id: 99, x: 1, y: 1 }] }))

    expect(await screen.findByText('Replace current annotations?')).toBeInTheDocument()
    expect(totalCounted()).toBe('3')

    await user.click(screen.getByRole('button', { name: 'Replace Annotations' }))
    await waitFor(() => expect(totalCounted()).toBe('1'))

    await user.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(totalCounted()).toBe('3'))
    await waitFor(() =>
      expect(normalizeAnnotations(JSON.parse(localStorage.getItem(ANNOTATION_KEY) ?? '[]'))).toHaveLength(3),
    )
  })

  it('records the counts for the recent-work list', async () => {
    stubImageLoading()
    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('0'))

    dropFile(
      jsonFile({
        annotations: [
          { id: 1, x: 1, y: 1, category: 'cow' },
          { id: 2, x: 2, y: 2, category: 'bull' },
          { id: 3, x: 3, y: 3, category: 'cow', state: 'rejected' },
        ],
      }),
    )

    await waitFor(() => {
      const record = readRecentImages().find((item) => item.filename === IMAGE.filename)
      expect(record).toMatchObject({ counted: 2, ignored: 1, cows: 1, bulls: 1 })
    })
  })

  it('keeps every image under its own key when the reviewer moves between them', async () => {
    stubImageLoading()
    const otherKey = annotationsStorageKey('survey-02.jpg', '/uploads/')
    localStorage.setItem(otherKey, JSON.stringify(annotations(5)))

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('0'))

    dropFile(jsonFile({ annotations: [{ id: 1, x: 5, y: 6 }] }))
    await waitFor(() => expect(totalCounted()).toBe('1'))
    await wait(PAST_THE_AUTOSAVE)

    expect(normalizeAnnotations(JSON.parse(localStorage.getItem(otherKey) ?? '[]'))).toHaveLength(5)
  })
})

describe('when the browser has no storage left', () => {
  function fillStorage() {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
  }

  it('still opens, so the reviewer can export what is on screen', async () => {
    stubImageLoading()
    seedSavedWork(4)
    fillStorage()

    renderApp(IMAGE.route)

    await waitFor(() => expect(totalCounted()).toBe('4'))
    await wait(PAST_THE_AUTOSAVE)
    expect(screen.getByRole('button', { name: 'Export Results' })).toBeInTheDocument()
  })

  it('warns that the latest changes were not saved', async () => {
    stubImageLoading()
    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('0'))

    fillStorage()
    dropFile(jsonFile({ annotations: [{ id: 1, x: 1, y: 1 }] }))
    await waitFor(() => expect(totalCounted()).toBe('1'))

    expect(await screen.findByText(/no room left/i)).toBeInTheDocument()
  })

  it('leaves the previously saved work exactly as it was', async () => {
    const user = userEvent.setup()
    stubImageLoading()
    const before = JSON.stringify(seedSavedWork(2))

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('2'))

    fillStorage()
    dropFile(jsonFile({ annotations: [] }))
    await user.click(await screen.findByRole('button', { name: 'Replace Annotations' }))
    await waitFor(() => expect(totalCounted()).toBe('0'))
    await wait(PAST_THE_AUTOSAVE)

    // The failed write must not have taken the last good save down with it.
    expect(localStorage.getItem(ANNOTATION_KEY)).toBe(before)
  })
})

describe('deleting an image from recent work', () => {
  function seedTwoImages() {
    const keeperKey = annotationsStorageKey('keeper.jpg', '/uploads/')
    localStorage.setItem(ANNOTATION_KEY, JSON.stringify(annotations(3)))
    localStorage.setItem(keeperKey, JSON.stringify(annotations(5)))
    writeRecentImages([
      recentImageRecord({ ...IMAGE, counted: 3, cows: 3 }),
      recentImageRecord({ filename: 'keeper.jpg', basePath: '/uploads/', counted: 5, cows: 5 }),
    ])
    return keeperKey
  }

  /** Delete lives behind the row's overflow menu, and then behind a confirmation. */
  async function startDeleting(user: UserEvent, name: string) {
    await user.click(await screen.findByRole('button', { name: `More actions for ${name}` }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete from this browser' }))
  }

  it('asks for confirmation before removing an image that has counts on it', async () => {
    const user = userEvent.setup()
    const keeperKey = seedTwoImages()

    renderApp('/')
    await startDeleting(user, 'survey-01.jpg')

    expect(await screen.findByText('Delete this image from recent work?')).toBeInTheDocument()
    expect(localStorage.getItem(ANNOTATION_KEY)).not.toBeNull()
    expect(localStorage.getItem(keeperKey)).not.toBeNull()
  })

  it('keeps everything when the reviewer cancels', async () => {
    const user = userEvent.setup()
    seedTwoImages()
    renderApp('/')

    await startDeleting(user, 'survey-01.jpg')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByText('Delete this image from recent work?')).not.toBeInTheDocument())
    expect(normalizeAnnotations(JSON.parse(localStorage.getItem(ANNOTATION_KEY) ?? '[]'))).toHaveLength(3)
    expect(readRecentImages()).toHaveLength(2)
  })

  it('removes only the annotations of the image that was deleted', async () => {
    const user = userEvent.setup()
    const keeperKey = seedTwoImages()
    renderApp('/')

    await startDeleting(user, 'survey-01.jpg')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(localStorage.getItem(ANNOTATION_KEY)).toBeNull())
    expect(normalizeAnnotations(JSON.parse(localStorage.getItem(keeperKey) ?? '[]'))).toHaveLength(5)
    expect(readRecentImages().map((item) => item.filename)).toEqual(['keeper.jpg'])
  })
})

describe('surviving damaged browser storage', () => {
  it('starts up with junk in every preference key, and still restores the work', async () => {
    stubImageLoading()
    seedSavedWork(6)
    for (const key of [LS_ACTIVE_CATEGORY_KEY, LS_MARKER_VISIBILITY_KEY, LS_ZOOM_SPEED_KEY, LS_IMAGE_BASE_KEY]) {
      localStorage.setItem(key, '{"nope":')
    }
    localStorage.setItem(LS_IMAGE_KEY, '')

    renderApp(IMAGE.route)

    await waitFor(() => expect(totalCounted()).toBe('6'))
  })

  it('does not let a corrupt recent-work list take the saved annotations with it', async () => {
    stubImageLoading()
    seedSavedWork(6)
    localStorage.setItem(LS_RECENT_IMAGES_KEY, 'not json at all')

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('6'))
    await wait(PAST_THE_AUTOSAVE)

    expect(normalizeAnnotations(JSON.parse(localStorage.getItem(ANNOTATION_KEY) ?? '[]'))).toHaveLength(6)
  })

  it('rebuilds the recent-work entry for an image whose record was lost', async () => {
    stubImageLoading()
    seedSavedWork(6)
    localStorage.removeItem(LS_RECENT_IMAGES_KEY)

    renderApp(IMAGE.route)
    await waitFor(() => expect(totalCounted()).toBe('6'))

    await waitFor(() =>
      expect(readRecentImages()[0]).toMatchObject({ filename: IMAGE.filename, basePath: IMAGE.basePath, counted: 6 }),
    )
  })
})
