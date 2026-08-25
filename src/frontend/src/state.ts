import { createContext, type Dispatch, useContext } from 'react'
import { normalizeAnnotations } from './lib/annotations'
import type { Action, Annotation, AnnotationPatch, AppState, UndoEntry } from './types'

export const initialState: AppState = {
  image: null,
  annotations: [],
  selectedIds: new Set(),
  activeCategory: null,
  confidenceThreshold: 0,
  showBboxes: true,
  bboxCreationEnabled: false,
  showNumbers: true,
  showRejected: false,
  markerVisibility: 'visible',
  helpVisible: false,
  zoomSpeed: 1,
  undoStack: [],
  redoStack: [],
}

function applyPatches(
  annotations: Annotation[],
  patches: AnnotationPatch[],
  direction: 'undo' | 'redo',
): Annotation[] {
  let result = [...annotations]
  for (const patch of patches) {
    if (direction === 'undo') {
      if (patch.before === null) {
        // Was added — remove it
        result = result.filter((a) => a.id !== patch.id)
      } else if (patch.after === null) {
        // Was removed — re-add it
        result.push({ ...patch.before } as Annotation)
      } else {
        // Was modified — restore before state
        result = result.map((a) => (a.id === patch.id ? { ...a, ...patch.before } : a))
      }
    } else {
      if (patch.before === null) {
        // Was added — re-add it
        const ann = annotations.find((a) => a.id === patch.id)
        if (!ann) {
          // Need to reconstruct from after
          result.push({ ...patch.after } as Annotation)
        }
      } else if (patch.after === null) {
        // Was removed — remove again
        result = result.filter((a) => a.id !== patch.id)
      } else {
        // Was modified — apply after state
        result = result.map((a) => (a.id === patch.id ? { ...a, ...patch.after } : a))
      }
    }
  }
  return result
}

function cloneAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.map((annotation) => ({ ...annotation }))
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'LOAD_IMAGE':
      return {
        ...state,
        image: action.image,
        annotations: [],
        selectedIds: new Set(),
        undoStack: [],
        redoStack: [],
      }

    case 'LOAD_ANNOTATIONS':
      return {
        ...state,
        annotations: normalizeAnnotations(action.annotations),
        selectedIds: new Set(),
        undoStack: [],
        redoStack: [],
      }

    case 'IMPORT_ANNOTATIONS': {
      const nextAnnotations = normalizeAnnotations(action.annotations)
      const entry: UndoEntry = {
        description: 'Import annotations JSON',
        replaceAll: {
          before: cloneAnnotations(state.annotations),
          after: cloneAnnotations(nextAnnotations),
        },
      }

      return {
        ...state,
        annotations: nextAnnotations,
        selectedIds: new Set(),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'CONFIRM': {
      const ids = new Set(action.ids)
      const patches: AnnotationPatch[] = state.annotations
        .filter((a) => ids.has(a.id) && a.state !== 'rejected' && a.reviewStatus !== 'confirmed')
        .map((a) => ({
          id: a.id,
          before: { reviewStatus: a.reviewStatus },
          after: { reviewStatus: 'confirmed' as const },
        }))
      if (patches.length === 0) return state
      const entry: UndoEntry = {
        description: `Confirm ${patches.length} annotation(s)`,
        patches,
      }
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          ids.has(a.id) && a.state !== 'rejected' ? { ...a, reviewStatus: 'confirmed' } : a,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'UNCONFIRM': {
      const ids = new Set(action.ids)
      const patches: AnnotationPatch[] = state.annotations
        .filter((a) => ids.has(a.id) && a.state !== 'rejected' && a.reviewStatus !== 'unconfirmed')
        .map((a) => ({
          id: a.id,
          before: { reviewStatus: a.reviewStatus },
          after: { reviewStatus: 'unconfirmed' as const },
        }))
      if (patches.length === 0) return state
      const entry: UndoEntry = {
        description: `Mark ${patches.length} annotation(s) as unconfirmed`,
        patches,
      }
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          ids.has(a.id) && a.state !== 'rejected' ? { ...a, reviewStatus: 'unconfirmed' } : a,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'REJECT': {
      const ids = new Set(action.ids)
      const patches: AnnotationPatch[] = state.annotations
        .filter((a) => ids.has(a.id) && a.state !== 'rejected' && a.state !== 'manually-added')
        .map((a) => ({
          id: a.id,
          before: { state: a.state, reviewStatus: a.reviewStatus },
          after: { state: 'rejected' as const, reviewStatus: 'confirmed' as const },
        }))
      if (patches.length === 0) return state
      const entry: UndoEntry = {
        description: `Reject ${patches.length} annotation(s)`,
        patches,
      }
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          ids.has(a.id) && a.state !== 'manually-added' ? { ...a, state: 'rejected', reviewStatus: 'confirmed' } : a,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'ADD_ANNOTATION': {
      const patch: AnnotationPatch = {
        id: action.annotation.id,
        before: null,
        after: { ...action.annotation },
      }
      const entry: UndoEntry = {
        description: 'Add annotation',
        patches: [patch],
      }
      return {
        ...state,
        annotations: [...state.annotations, action.annotation],
        selectedIds: new Set(),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'DELETE_ANNOTATION': {
      const ann = state.annotations.find((a) => a.id === action.id)
      if (!ann) return state
      const patch: AnnotationPatch = {
        id: action.id,
        before: { ...ann },
        after: null,
      }
      const entry: UndoEntry = {
        description: 'Delete annotation',
        patches: [patch],
      }
      const newSelected = new Set(state.selectedIds)
      newSelected.delete(action.id)
      return {
        ...state,
        annotations: state.annotations.filter((a) => a.id !== action.id),
        selectedIds: newSelected,
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'MOVE_ANNOTATION': {
      const ann = state.annotations.find((a) => a.id === action.id)
      if (!ann) return state
      const dx = action.x - ann.x
      const dy = action.y - ann.y
      const before: Partial<Annotation> = { x: ann.x, y: ann.y, reviewStatus: ann.reviewStatus }
      const after: Partial<Annotation> = { x: action.x, y: action.y, reviewStatus: 'confirmed' }
      if (ann.bbox) {
        before.bbox = ann.bbox
        after.bbox = [ann.bbox[0] + dx, ann.bbox[1] + dy, ann.bbox[2] + dx, ann.bbox[3] + dy]
      }
      const patch: AnnotationPatch = { id: action.id, before, after }
      const entry: UndoEntry = {
        description: 'Move annotation',
        patches: [patch],
      }
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          a.id === action.id
            ? {
                ...a,
                x: action.x,
                y: action.y,
                bbox: a.bbox ? [a.bbox[0] + dx, a.bbox[1] + dy, a.bbox[2] + dx, a.bbox[3] + dy] : null,
                reviewStatus: 'confirmed',
              }
            : a,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'RESIZE_BBOX': {
      const ann = state.annotations.find((a) => a.id === action.id)
      if (!ann) return state
      const [x1, y1, x2, y2] = action.bbox
      const newX = Math.round((x1 + x2) / 2)
      const newY = Math.round((y1 + y2) / 2)
      const before: Partial<Annotation> = {
        bbox: ann.bbox,
        x: ann.x,
        y: ann.y,
        reviewStatus: ann.reviewStatus,
      }
      const after: Partial<Annotation> = {
        bbox: action.bbox,
        x: newX,
        y: newY,
        reviewStatus: 'confirmed',
      }
      const patch: AnnotationPatch = { id: action.id, before, after }
      const entry: UndoEntry = { description: 'Resize bbox', patches: [patch] }
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          a.id === action.id ? { ...a, bbox: action.bbox, x: newX, y: newY, reviewStatus: 'confirmed' } : a,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'SET_CATEGORY': {
      const ids = new Set(action.ids)
      const patches: AnnotationPatch[] = state.annotations
        .filter((annotation) => ids.has(annotation.id) && annotation.category !== action.category)
        .map((annotation) => ({
          id: annotation.id,
          before: { category: annotation.category, reviewStatus: annotation.reviewStatus },
          after: { category: action.category, reviewStatus: 'confirmed' as const },
        }))
      if (patches.length === 0) return state

      const entry: UndoEntry = {
        description:
          action.category === null
            ? `Mark ${patches.length} annotation(s) as cow`
            : `Mark ${patches.length} annotation(s) as ${action.category}`,
        patches,
      }

      return {
        ...state,
        annotations: state.annotations.map((annotation) =>
          ids.has(annotation.id)
            ? { ...annotation, category: action.category, reviewStatus: 'confirmed' }
            : annotation,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'SET_ACTIVE_CATEGORY':
      return { ...state, activeCategory: action.category }

    case 'RENAME_IMAGE':
      if (!state.image) return state
      return {
        ...state,
        image: {
          ...state.image,
          displayName: action.displayName,
        },
      }

    case 'DELETE_OR_REJECT': {
      const ids = new Set(action.ids)
      const patches: AnnotationPatch[] = []
      for (const ann of state.annotations) {
        if (!ids.has(ann.id)) continue
        if (ann.state === 'manually-added') {
          // Delete entirely
          patches.push({ id: ann.id, before: { ...ann }, after: null })
        } else {
          // Reject
          if (ann.state !== 'rejected') {
            patches.push({
              id: ann.id,
              before: { state: ann.state, reviewStatus: ann.reviewStatus },
              after: { state: 'rejected', reviewStatus: 'confirmed' },
            })
          }
        }
      }
      if (patches.length === 0) return state
      const entry: UndoEntry = {
        description: `Delete/reject ${patches.length} annotation(s)`,
        patches,
      }
      let newAnnotations = state.annotations
      const toDelete = new Set(patches.filter((p) => p.after === null).map((p) => p.id))
      const toReject = new Set(patches.filter((p) => p.after !== null).map((p) => p.id))
      newAnnotations = newAnnotations.filter((a) => !toDelete.has(a.id))
      newAnnotations = newAnnotations.map((a) =>
        toReject.has(a.id) ? { ...a, state: 'rejected' as const, reviewStatus: 'confirmed' as const } : a,
      )
      return {
        ...state,
        annotations: newAnnotations,
        selectedIds: new Set(),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'SELECT':
      if (action.append) {
        const newIds = new Set(state.selectedIds)
        for (const id of action.ids) newIds.add(id)
        return { ...state, selectedIds: newIds }
      }
      return { ...state, selectedIds: new Set(action.ids) }

    case 'DESELECT_ALL':
      return { ...state, selectedIds: new Set() }

    case 'SELECT_ALL_VISIBLE': {
      const visible = state.annotations.filter((a) => {
        if (a.state === 'rejected' && !state.showRejected) return false
        if (a.detection_confidence !== null && a.detection_confidence < state.confidenceThreshold) return false
        return true
      })
      return { ...state, selectedIds: new Set(visible.map((a) => a.id)) }
    }

    case 'SET_THRESHOLD':
      return { ...state, confidenceThreshold: action.threshold }

    case 'COMMIT_THRESHOLD': {
      const toReject = state.annotations.filter(
        (a) =>
          a.detection_confidence !== null &&
          a.detection_confidence < state.confidenceThreshold &&
          a.state === 'auto-detected',
      )
      if (toReject.length === 0) return state
      const patches: AnnotationPatch[] = toReject.map((a) => ({
        id: a.id,
        before: { state: a.state, reviewStatus: a.reviewStatus },
        after: { state: 'rejected' as const, reviewStatus: 'confirmed' as const },
      }))
      const entry: UndoEntry = {
        description: `Commit threshold: reject ${toReject.length}`,
        patches,
      }
      const rejectIds = new Set(toReject.map((a) => a.id))
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          rejectIds.has(a.id) ? { ...a, state: 'rejected', reviewStatus: 'confirmed' } : a,
        ),
        undoStack: [...state.undoStack, entry],
        redoStack: [],
      }
    }

    case 'TOGGLE_BBOXES':
      return { ...state, showBboxes: !state.showBboxes }

    case 'TOGGLE_BBOX_CREATION':
      return { ...state, bboxCreationEnabled: !state.bboxCreationEnabled }

    case 'TOGGLE_NUMBERS':
      return { ...state, showNumbers: !state.showNumbers }

    case 'TOGGLE_REJECTED':
      return { ...state, showRejected: !state.showRejected }

    case 'CYCLE_MARKER_VISIBILITY': {
      const nextVisibility =
        state.markerVisibility === 'visible' ? 'dimmed' : state.markerVisibility === 'dimmed' ? 'hidden' : 'visible'
      return { ...state, markerVisibility: nextVisibility }
    }

    case 'SET_MARKER_VISIBILITY':
      return { ...state, markerVisibility: action.visibility }

    case 'UNDO': {
      if (state.undoStack.length === 0) return state
      const entry = state.undoStack[state.undoStack.length - 1]!
      return {
        ...state,
        annotations: entry.replaceAll
          ? cloneAnnotations(entry.replaceAll.before)
          : applyPatches(state.annotations, entry.patches ?? [], 'undo'),
        selectedIds: new Set(),
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, entry],
      }
    }

    case 'REDO': {
      if (state.redoStack.length === 0) return state
      const entry = state.redoStack[state.redoStack.length - 1]!
      return {
        ...state,
        annotations: entry.replaceAll
          ? cloneAnnotations(entry.replaceAll.after)
          : applyPatches(state.annotations, entry.patches ?? [], 'redo'),
        selectedIds: new Set(),
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, entry],
      }
    }

    case 'TOGGLE_HELP':
      return { ...state, helpVisible: !state.helpVisible }

    case 'SET_ZOOM_SPEED':
      return { ...state, zoomSpeed: action.speed }

    case 'RESET_WORKSPACE':
      return {
        ...state,
        image: null,
        annotations: [],
        selectedIds: new Set(),
        undoStack: [],
        redoStack: [],
      }

    default:
      return state
  }
}

export const AppStateContext = createContext<AppState>(initialState)
export const DispatchContext = createContext<Dispatch<Action>>(() => {})

export function useAppState() {
  return useContext(AppStateContext)
}

export function useDispatch() {
  return useContext(DispatchContext)
}
