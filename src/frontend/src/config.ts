import type { AnnotationCategory } from './types'

/** Keyboard shortcuts — consumed by useKeyboard.ts */
export const KEYS = {
  deleteOrReject: ['Backspace', 'Delete'],
  undo: { key: 'z', meta: true },
  redo: { key: 'z', meta: true, shift: true },
  selectAll: { key: 'a', meta: true },
  deselect: ['Escape'],
  cycleMarkerVisibility: ['v'],
  help: ['?'],
  cycleCategory: ['e'],
}

/** Zoom speed bounds */
export const DEFAULT_ZOOM_SPEED = 1
export const MIN_ZOOM_SPEED = 0.25
export const MAX_ZOOM_SPEED = 4

export const ENABLE_AUTOMATION = import.meta.env.VITE_ENABLE_AUTOMATION === 'true'
export const SHOW_DEV_SAMPLES = import.meta.env.DEV && import.meta.env.VITE_SHOW_SAMPLE_IMAGES !== 'false'

export interface LabelCategoryOption {
  id: AnnotationCategory
  label: string
  badge: string
  description: string
}

export const ELK_CATEGORY_OPTIONS: LabelCategoryOption[] = [
  {
    id: null,
    label: 'Cow',
    badge: 'COW',
    description: 'Set new markers to cow and clear special status on the current selection',
  },
  {
    id: 'bull',
    label: 'Bull',
    badge: 'B',
    description: 'Set new markers to bull and update the current selection',
  },
  {
    id: 'spike',
    label: 'Spike',
    badge: 'S',
    description: 'Set new markers to spike and update the current selection',
  },
]
