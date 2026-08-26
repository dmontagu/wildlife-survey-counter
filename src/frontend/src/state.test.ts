import { describe, expect, it } from 'vitest'
import { initialState, reducer } from './state'
import { annotation, annotations } from './tests/helpers'
import type { Annotation, AppState, ImageInfo } from './types'

function stateWith(overrides: Partial<AppState> = {}): AppState {
  return { ...initialState, ...overrides }
}

const image: ImageInfo = {
  filename: 'survey-01.jpg',
  displayName: null,
  width: 1200,
  height: 900,
  element: {} as HTMLImageElement,
  basePath: '/uploads/',
}

describe('LOAD_IMAGE', () => {
  it('starts a clean workspace but keeps the reviewer preferences', () => {
    const before = stateWith({
      annotations: annotations(3),
      undoStack: [{ description: 'x' }],
      redoStack: [{ description: 'y' }],
      activeCategory: 'bull',
      markerVisibility: 'dimmed',
      zoomSpeed: 2,
      showRejected: true,
    })

    const after = reducer(before, { type: 'LOAD_IMAGE', image })

    expect(after.annotations).toEqual([])
    expect(after.undoStack).toEqual([])
    expect(after.redoStack).toEqual([])
    expect(after).toMatchObject({
      activeCategory: 'bull',
      markerVisibility: 'dimmed',
      zoomSpeed: 2,
      showRejected: true,
    })
  })
})

describe('LOAD_ANNOTATIONS', () => {
  it('restores saved work without putting it on the undo stack', () => {
    const saved = annotations(3)
    const after = reducer(stateWith({ image }), { type: 'LOAD_ANNOTATIONS', annotations: saved })

    expect(after.annotations).toEqual(saved)
    expect(after.undoStack).toEqual([])
    expect(after.redoStack).toEqual([])
  })

  it('normalises what it restores, so a legacy save is usable immediately', () => {
    const after = reducer(stateWith({ image }), {
      type: 'LOAD_ANNOTATIONS',
      annotations: [{ id: 1, x: 5, y: 6, category: null } as unknown as Annotation],
    })

    expect(after.annotations[0]).toMatchObject({ id: 1, x: 5, y: 6, category: 'cow' })
  })
})

describe('IMPORT_ANNOTATIONS', () => {
  it('replaces the current work but keeps it recoverable with one undo', () => {
    const existing = annotations(4)
    const imported = [annotation({ id: 100, x: 7, y: 8 })]
    const before = stateWith({ image, annotations: existing })

    const after = reducer(before, { type: 'IMPORT_ANNOTATIONS', annotations: imported })
    expect(after.annotations.map((item) => item.id)).toEqual([100])

    const undone = reducer(after, { type: 'UNDO' })
    expect(undone.annotations).toEqual(existing)

    const redone = reducer(undone, { type: 'REDO' })
    expect(redone.annotations.map((item) => item.id)).toEqual([100])
  })

  it('snapshots the replaced work by value, so later edits cannot corrupt the undo entry', () => {
    const existing = annotations(2)
    const after = reducer(stateWith({ image, annotations: existing }), {
      type: 'IMPORT_ANNOTATIONS',
      annotations: [annotation({ id: 100 })],
    })

    existing[0]!.x = 9999

    expect(reducer(after, { type: 'UNDO' }).annotations[0]?.x).toBe(10)
  })
})

describe('review actions', () => {
  it('confirms only the selected annotations that are not already confirmed', () => {
    const before = stateWith({
      annotations: [
        annotation({ id: 1, reviewStatus: 'unconfirmed' }),
        annotation({ id: 2, reviewStatus: 'unconfirmed' }),
        annotation({ id: 3, reviewStatus: 'confirmed' }),
      ],
    })

    const after = reducer(before, { type: 'CONFIRM', ids: [1, 3] })

    expect(after.annotations.map((item) => item.reviewStatus)).toEqual(['confirmed', 'unconfirmed', 'confirmed'])
    expect(after.undoStack).toHaveLength(1)
    expect(after.undoStack[0]?.patches).toHaveLength(1)
  })

  it('does not push an undo entry when nothing actually changes', () => {
    const before = stateWith({ annotations: [annotation({ id: 1, reviewStatus: 'confirmed' })] })
    expect(reducer(before, { type: 'CONFIRM', ids: [1] })).toBe(before)
    expect(reducer(before, { type: 'CONFIRM', ids: [99] })).toBe(before)
  })

  it('never confirms an ignored annotation back into the count', () => {
    const before = stateWith({ annotations: [annotation({ id: 1, state: 'rejected' })] })
    expect(reducer(before, { type: 'CONFIRM', ids: [1] })).toBe(before)
    expect(reducer(before, { type: 'UNCONFIRM', ids: [1] })).toBe(before)
  })

  it('ignores an imported annotation but refuses to reject one the reviewer placed', () => {
    const before = stateWith({
      annotations: [annotation({ id: 1, state: 'auto-detected' }), annotation({ id: 2, state: 'manually-added' })],
    })

    const after = reducer(before, { type: 'REJECT', ids: [1, 2] })

    expect(after.annotations[0]).toMatchObject({ state: 'rejected', reviewStatus: 'confirmed' })
    expect(after.annotations[1]).toMatchObject({ state: 'manually-added' })
  })
})

describe('DELETE_OR_REJECT', () => {
  it('deletes what the reviewer added and only ignores what was imported', () => {
    const before = stateWith({
      annotations: [
        annotation({ id: 1, state: 'manually-added' }),
        annotation({ id: 2, state: 'auto-detected' }),
        annotation({ id: 3, state: 'confirmed' }),
      ],
    })

    const after = reducer(before, { type: 'DELETE_OR_REJECT', ids: [1, 2, 3] })

    expect(after.annotations.map((item) => item.id)).toEqual([2, 3])
    expect(after.annotations.every((item) => item.state === 'rejected')).toBe(true)
  })

  it('brings a deleted annotation back intact on undo', () => {
    const original = annotation({ id: 1, x: 42, y: 43, category: 'bull', state: 'manually-added' })
    const after = reducer(stateWith({ annotations: [original] }), { type: 'DELETE_OR_REJECT', ids: [1] })

    expect(after.annotations).toEqual([])
    expect(reducer(after, { type: 'UNDO' }).annotations).toEqual([original])
  })
})

describe('editing a single annotation', () => {
  it('adds an annotation and removes it again on undo', () => {
    const added = annotation({ id: 7, x: 1, y: 2 })
    const after = reducer(stateWith({}), { type: 'ADD_ANNOTATION', annotation: added })

    expect(after.annotations).toEqual([added])
    expect(reducer(after, { type: 'UNDO' }).annotations).toEqual([])
    expect(reducer(reducer(after, { type: 'UNDO' }), { type: 'REDO' }).annotations).toEqual([added])
  })

  it('moves the bbox with the point, and puts both back on undo', () => {
    const before = stateWith({
      annotations: [annotation({ id: 1, x: 100, y: 100, bbox: [90, 90, 110, 110], reviewStatus: 'unconfirmed' })],
    })

    const after = reducer(before, { type: 'MOVE_ANNOTATION', id: 1, x: 150, y: 120 })

    expect(after.annotations[0]).toMatchObject({
      x: 150,
      y: 120,
      bbox: [140, 110, 160, 130],
      reviewStatus: 'confirmed',
    })
    expect(reducer(after, { type: 'UNDO' }).annotations).toEqual(before.annotations)
  })

  it('recentres the point when a bbox is resized', () => {
    const before = stateWith({ annotations: [annotation({ id: 1, x: 100, y: 100, bbox: [90, 90, 110, 110] })] })
    const after = reducer(before, { type: 'RESIZE_BBOX', id: 1, bbox: [80, 60, 120, 140] })

    expect(after.annotations[0]).toMatchObject({ x: 100, y: 100, bbox: [80, 60, 120, 140] })
    expect(reducer(after, { type: 'UNDO' }).annotations).toEqual(before.annotations)
  })

  it('ignores edits aimed at an annotation that is not there', () => {
    const before = stateWith({ annotations: [annotation({ id: 1 })] })
    expect(reducer(before, { type: 'MOVE_ANNOTATION', id: 99, x: 1, y: 1 })).toBe(before)
    expect(reducer(before, { type: 'RESIZE_BBOX', id: 99, bbox: [0, 0, 1, 1] })).toBe(before)
    expect(reducer(before, { type: 'DELETE_ANNOTATION', id: 99 })).toBe(before)
  })

  it('reclassifies a selection and marks it reviewed', () => {
    const before = stateWith({
      annotations: [
        annotation({ id: 1, category: 'cow', reviewStatus: 'unconfirmed' }),
        annotation({ id: 2, category: 'bull' }),
      ],
    })

    const after = reducer(before, { type: 'SET_CATEGORY', ids: [1, 2], category: 'bull' })

    expect(after.annotations.map((item) => item.category)).toEqual(['bull', 'bull'])
    expect(after.undoStack[0]?.patches).toHaveLength(1)
    expect(reducer(after, { type: 'UNDO' }).annotations[0]).toMatchObject({
      category: 'cow',
      reviewStatus: 'unconfirmed',
    })
  })
})

describe('COMMIT_THRESHOLD', () => {
  it('ignores only the auto-detected annotations below the slider', () => {
    const before = stateWith({
      confidenceThreshold: 0.5,
      annotations: [
        annotation({ id: 1, state: 'auto-detected', detection_confidence: 0.2 }),
        annotation({ id: 2, state: 'auto-detected', detection_confidence: 0.8 }),
        annotation({ id: 3, state: 'manually-added', detection_confidence: 0.1 }),
        annotation({ id: 4, state: 'confirmed', detection_confidence: 0.1 }),
      ],
    })

    const after = reducer(before, { type: 'COMMIT_THRESHOLD' })

    expect(after.annotations.map((item) => item.state)).toEqual([
      'rejected',
      'auto-detected',
      'manually-added',
      'confirmed',
    ])
    expect(reducer(after, { type: 'UNDO' }).annotations).toEqual(before.annotations)
  })

  it('does nothing when the slider excludes nothing', () => {
    const before = stateWith({ confidenceThreshold: 0, annotations: annotations(3) })
    expect(reducer(before, { type: 'COMMIT_THRESHOLD' })).toBe(before)
  })
})

describe('selection', () => {
  it('replaces or extends the selection as asked', () => {
    const before = stateWith({ selectedIds: new Set([1]) })
    expect([...reducer(before, { type: 'SELECT', ids: [2, 3] }).selectedIds]).toEqual([2, 3])
    expect([...reducer(before, { type: 'SELECT', ids: [2], append: true }).selectedIds]).toEqual([1, 2])
    expect([...reducer(before, { type: 'DESELECT_ALL' }).selectedIds]).toEqual([])
  })

  it('selects what is actually on screen, not what is filtered out', () => {
    const before = stateWith({
      confidenceThreshold: 0.5,
      showRejected: false,
      annotations: [
        annotation({ id: 1, detection_confidence: 0.9 }),
        annotation({ id: 2, detection_confidence: 0.1 }),
        annotation({ id: 3, state: 'rejected' }),
        annotation({ id: 4 }),
      ],
    })

    expect([...reducer(before, { type: 'SELECT_ALL_VISIBLE' }).selectedIds]).toEqual([1, 4])
  })
})

describe('undo and redo', () => {
  it('does nothing when there is no history', () => {
    const before = stateWith({ annotations: annotations(2) })
    expect(reducer(before, { type: 'UNDO' })).toBe(before)
    expect(reducer(before, { type: 'REDO' })).toBe(before)
  })

  it('drops the redo history once a new edit is made', () => {
    let state = reducer(stateWith({}), { type: 'ADD_ANNOTATION', annotation: annotation({ id: 1 }) })
    state = reducer(state, { type: 'UNDO' })
    expect(state.redoStack).toHaveLength(1)

    state = reducer(state, { type: 'ADD_ANNOTATION', annotation: annotation({ id: 2 }) })
    expect(state.redoStack).toEqual([])
  })
})

describe('RESET_WORKSPACE', () => {
  it('closes the image and clears history but keeps the reviewer preferences', () => {
    const before = stateWith({
      image,
      annotations: annotations(3),
      undoStack: [{ description: 'x' }],
      activeCategory: 'spike',
      zoomSpeed: 3,
      markerVisibility: 'hidden',
      showRejected: true,
      bboxCreationEnabled: true,
    })

    const after = reducer(before, { type: 'RESET_WORKSPACE' })

    expect(after).toMatchObject({
      image: null,
      annotations: [],
      undoStack: [],
      redoStack: [],
      activeCategory: 'spike',
      zoomSpeed: 3,
      markerVisibility: 'hidden',
      showRejected: true,
      bboxCreationEnabled: true,
    })
  })
})

describe('RENAME_IMAGE', () => {
  it('renames the open image and leaves the annotations alone', () => {
    const before = stateWith({ image, annotations: annotations(2) })
    const after = reducer(before, { type: 'RENAME_IMAGE', displayName: 'North meadow' })

    expect(after.image?.displayName).toBe('North meadow')
    expect(after.annotations).toEqual(before.annotations)
  })

  it('is a no-op with no image open', () => {
    const before = stateWith({})
    expect(reducer(before, { type: 'RENAME_IMAGE', displayName: 'x' })).toBe(before)
  })
})
