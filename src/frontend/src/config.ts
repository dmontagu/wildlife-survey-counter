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

export const SHOW_DEV_SAMPLES = import.meta.env.DEV && import.meta.env.VITE_SHOW_SAMPLE_IMAGES !== 'false'
export const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSeK1SurenTcjOf0HY-Zs8aWsCVt83YInqJR7G6QMAP5J4K5rQ/viewform?usp=sharing'
export const UPDATES_FORM_ACTION =
  'https://docs.google.com/forms/d/e/1FAIpQLSeUXZkyX_QeI0da8xmAcI2bEiBKFaP3JFIsijEbHDkwC6AFXQ/formResponse'
export const UPDATES_FORM_EMAIL_FIELD = 'entry.1653319143'

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
