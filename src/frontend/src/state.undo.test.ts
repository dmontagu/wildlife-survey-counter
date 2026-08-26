import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ELK_CATEGORY_OPTIONS } from './config'
import { initialState, reducer } from './state'
import { annotation } from './tests/helpers'
import type { Action, Annotation, AnnotationCategory, AppState } from './types'

/**
 * Undo is the reviewer's only safety net for a mis-click on a page of several hundred markers, so
 * these tests treat it as a data-integrity mechanism rather than a convenience. The invariant under
 * test: whatever sequence of edits happened, undoing all of it must return exactly the annotations
 * the reviewer started with, and redoing all of it must return exactly the ones they ended with.
 */

/** Undo re-inserts a removed annotation at the end, so a run is compared by identity, not order. */
function byId(annotations: Annotation[]): Record<number, Annotation> {
  return Object.fromEntries(annotations.map((item) => [item.id, item]))
}

type Command =
  | { kind: 'confirm' | 'unconfirm' | 'reject' | 'deleteOrReject' | 'delete'; pick: number }
  | { kind: 'move'; pick: number; x: number; y: number }
  | { kind: 'resize'; pick: number; bbox: [number, number, number, number] }
  | { kind: 'setCategory'; pick: number; category: AnnotationCategory }
  | { kind: 'add'; x: number; y: number; category: AnnotationCategory }
  | { kind: 'commitThreshold'; threshold: number }
  | { kind: 'import'; count: number }

const pick = fc.double({ min: 0, max: 0.999, noNaN: true })
const coordinate = fc.integer({ min: 0, max: 1000 })
const category = fc.constantFrom(...ELK_CATEGORY_OPTIONS.map((option) => option.id))

const arbitraryCommand: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constantFrom('confirm' as const, 'unconfirm' as const, 'reject' as const), pick }),
  fc.record({ kind: fc.constant('deleteOrReject' as const), pick }),
  fc.record({ kind: fc.constant('delete' as const), pick }),
  fc.record({ kind: fc.constant('move' as const), pick, x: coordinate, y: coordinate }),
  fc.record({
    kind: fc.constant('resize' as const),
    pick,
    bbox: fc.tuple(coordinate, coordinate, coordinate, coordinate),
  }),
  fc.record({ kind: fc.constant('setCategory' as const), pick, category }),
  fc.record({ kind: fc.constant('add' as const), x: coordinate, y: coordinate, category }),
  fc.record({ kind: fc.constant('commitThreshold' as const), threshold: fc.double({ min: 0, max: 1, noNaN: true }) }),
  fc.record({ kind: fc.constant('import' as const), count: fc.integer({ min: 0, max: 4 }) }),
)

const arbitraryStartingWork = fc.array(
  fc.record({
    x: coordinate,
    y: coordinate,
    category,
    state: fc.constantFrom('auto-detected' as const, 'confirmed' as const, 'manually-added' as const),
    reviewStatus: fc.constantFrom('confirmed' as const, 'unconfirmed' as const),
    detection_confidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
    hasBbox: fc.boolean(),
  }),
  { maxLength: 12 },
)

function startingState(work: typeof arbitraryStartingWork extends fc.Arbitrary<infer T> ? T : never): AppState {
  return {
    ...initialState,
    annotations: work.map((item, index) =>
      annotation({
        id: index + 1,
        x: item.x,
        y: item.y,
        category: item.category,
        state: item.state,
        reviewStatus: item.reviewStatus,
        detection_confidence: item.detection_confidence,
        bbox: item.hasBbox ? [item.x - 5, item.y - 5, item.x + 5, item.y + 5] : null,
      }),
    ),
  }
}

let nextGeneratedId = 10_000

/** Turn a command into a real action against the current state; commands that cannot apply are skipped. */
function toAction(state: AppState, command: Command): Action | null {
  if (command.kind === 'add') {
    return {
      type: 'ADD_ANNOTATION',
      annotation: annotation({ id: nextGeneratedId++, x: command.x, y: command.y, category: command.category }),
    }
  }

  if (command.kind === 'commitThreshold') {
    return { type: 'COMMIT_THRESHOLD' }
  }

  if (command.kind === 'import') {
    return {
      type: 'IMPORT_ANNOTATIONS',
      annotations: Array.from({ length: command.count }, () =>
        annotation({ id: nextGeneratedId++, x: 1, y: 1, state: 'auto-detected' }),
      ),
    }
  }

  const target = state.annotations[Math.floor(command.pick * state.annotations.length)]
  if (!target) return null

  switch (command.kind) {
    case 'confirm':
      return { type: 'CONFIRM', ids: [target.id] }
    case 'unconfirm':
      return { type: 'UNCONFIRM', ids: [target.id] }
    case 'reject':
      return { type: 'REJECT', ids: [target.id] }
    case 'deleteOrReject':
      return { type: 'DELETE_OR_REJECT', ids: [target.id] }
    case 'delete':
      return { type: 'DELETE_ANNOTATION', id: target.id }
    case 'move':
      return { type: 'MOVE_ANNOTATION', id: target.id, x: command.x, y: command.y }
    case 'resize':
      return { type: 'RESIZE_BBOX', id: target.id, bbox: command.bbox }
    case 'setCategory':
      return { type: 'SET_CATEGORY', ids: [target.id], category: command.category }
  }
}

function applyCommands(state: AppState, commands: Command[]): AppState {
  return commands.reduce((current, command) => {
    if (command.kind === 'commitThreshold') {
      current = reducer(current, { type: 'SET_THRESHOLD', threshold: command.threshold })
    }
    const action = toAction(current, command)
    return action ? reducer(current, action) : current
  }, state)
}

function undoEverything(state: AppState): AppState {
  let current = state
  for (let step = 0; step < 200 && current.undoStack.length > 0; step++) {
    current = reducer(current, { type: 'UNDO' })
  }
  expect(current.undoStack).toEqual([])
  return current
}

function redoEverything(state: AppState): AppState {
  let current = state
  for (let step = 0; step < 200 && current.redoStack.length > 0; step++) {
    current = reducer(current, { type: 'REDO' })
  }
  expect(current.redoStack).toEqual([])
  return current
}

describe('undo and redo integrity', () => {
  it('restores the exact starting work after any sequence of edits is undone', () => {
    fc.assert(
      fc.property(arbitraryStartingWork, fc.array(arbitraryCommand, { maxLength: 25 }), (work, commands) => {
        const start = startingState(work)
        const edited = applyCommands(start, commands)

        expect(byId(undoEverything(edited).annotations)).toEqual(byId(start.annotations))
      }),
      { numRuns: 300 },
    )
  })

  it('returns to the edited work after undoing and redoing everything', () => {
    fc.assert(
      fc.property(arbitraryStartingWork, fc.array(arbitraryCommand, { maxLength: 25 }), (work, commands) => {
        const edited = applyCommands(startingState(work), commands)

        expect(byId(redoEverything(undoEverything(edited)).annotations)).toEqual(byId(edited.annotations))
      }),
      { numRuns: 300 },
    )
  })

  it('never loses an annotation across a partial undo followed by a redo', () => {
    fc.assert(
      fc.property(
        arbitraryStartingWork,
        fc.array(arbitraryCommand, { maxLength: 20 }),
        fc.integer({ min: 1, max: 10 }),
        (work, commands, steps) => {
          const edited = applyCommands(startingState(work), commands)

          let current = edited
          const undone = Math.min(steps, edited.undoStack.length)
          for (let step = 0; step < undone; step++) current = reducer(current, { type: 'UNDO' })
          for (let step = 0; step < undone; step++) current = reducer(current, { type: 'REDO' })

          expect(byId(current.annotations)).toEqual(byId(edited.annotations))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('keeps the undo and redo stacks balanced, so no edit becomes unreachable', () => {
    fc.assert(
      fc.property(arbitraryStartingWork, fc.array(arbitraryCommand, { maxLength: 20 }), (work, commands) => {
        const edited = applyCommands(startingState(work), commands)
        const total = edited.undoStack.length

        let current = edited
        for (let step = 0; step < total; step++) {
          current = reducer(current, { type: 'UNDO' })
          expect(current.undoStack.length + current.redoStack.length).toBe(total)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('never mutates the state it was handed', () => {
    fc.assert(
      fc.property(arbitraryStartingWork, fc.array(arbitraryCommand, { maxLength: 20 }), (work, commands) => {
        const start = startingState(work)
        const snapshot = JSON.stringify(start.annotations)

        const edited = applyCommands(start, commands)
        undoEverything(edited)

        expect(JSON.stringify(start.annotations)).toBe(snapshot)
      }),
      { numRuns: 200 },
    )
  })
})
