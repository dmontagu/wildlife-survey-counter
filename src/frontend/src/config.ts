import type { AnnotationCategory, CategorySummaryKey } from './types'

/** Keyboard shortcuts — consumed by useKeyboard.ts */
export const KEYS = {
  confirmSelection: ['c'],
  unconfirmSelection: ['u'],
  deleteOrReject: ['Backspace', 'Delete'],
  undo: { key: 'z', meta: true },
  redo: { key: 'z', meta: true, shift: true },
  selectAll: { key: 'a', meta: true },
  deselect: ['Escape'],
  cycleMarkerVisibility: ['v'],
  help: ['?'],
  cycleCategory: ['e'],
  // Direct per-class shortcuts live on ELK_CATEGORY_OPTIONS[].shortcut below.
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

export type CategoryIndicator = 'none' | 'ring' | 'dashed-ring' | 'diamond'

export interface LabelCategoryOption {
  id: AnnotationCategory
  /** Display name used in the palette, status bar, help overlay, and export panel. */
  label: string
  /** One-letter shorthand shown in the class palette; the selected class is spelled out next to it. */
  shortLabel: string
  /** Lowercase plural-ish noun used after a count ("3 bulls", "2 unclassified antlerless"). */
  countLabel: string
  /** Short text drawn in the marker badge; null means no badge (plain marker). */
  badge: string | null
  /** Shape drawn around the marker. The diamond indicator also gets a diamond badge. */
  indicator: CategoryIndicator
  /** Single-letter keyboard shortcut (no modifier); null means only reachable via the palette / E cycle. */
  shortcut: string | null
  description: string
  /** Marker, badge, and status chip colour. */
  color: string
  /** Field on AnnotationSummary / RecentImageRecord that counts this class. */
  summaryKey: CategorySummaryKey
}

export const DEFAULT_CATEGORY: AnnotationCategory = 'cow'

/**
 * Single source of truth for elk classes. An entry here drives rendering, keyboard shortcuts, counts,
 * the status bar, the help overlay, and exports; adding a class also means widening `AnnotationCategory`
 * and `CategorySummaryKey` in types.ts — both are compile errors if missed.
 */
export const ELK_CATEGORY_OPTIONS: readonly LabelCategoryOption[] = [
  {
    id: 'cow',
    label: 'Cow',
    shortLabel: 'C',
    countLabel: 'cows',
    badge: null,
    indicator: 'none',
    shortcut: null,
    description: 'Set new markers to cow and clear special status on the current selection',
    color: '#17B8FF',
    summaryKey: 'cows',
  },
  {
    id: 'bull',
    label: 'Bull',
    shortLabel: 'B',
    countLabel: 'bulls',
    badge: 'B',
    indicator: 'ring',
    shortcut: 'b',
    description: 'Set new markers to bull and update the current selection',
    color: '#FF5D95',
    summaryKey: 'bulls',
  },
  {
    id: 'spike',
    label: 'Spike',
    shortLabel: 'S',
    countLabel: 'spikes',
    badge: 'S',
    indicator: 'diamond',
    shortcut: 's',
    description: 'Set new markers to spike and update the current selection',
    color: '#73E46F',
    summaryKey: 'spikes',
  },
  {
    id: 'unclassified-antlerless',
    label: 'Unclassified antlerless',
    shortLabel: 'A',
    countLabel: 'unclassified antlerless',
    badge: 'A',
    indicator: 'dashed-ring',
    shortcut: 'a',
    description: 'Set new markers to unclassified antlerless (cow or calf) and update the current selection',
    color: '#C084FC',
    summaryKey: 'unclassifiedAntlerless',
  },
  {
    id: 'unclassified',
    label: 'Unclassified',
    shortLabel: 'U',
    countLabel: 'unclassified',
    badge: 'U',
    indicator: 'dashed-ring',
    shortcut: 'x',
    description: 'Set new markers to unclassified (elk of unknown type) and update the current selection',
    color: '#D4D4D8',
    summaryKey: 'unclassified',
  },
]

const CATEGORY_OPTIONS_BY_ID = new Map(ELK_CATEGORY_OPTIONS.map((option) => [option.id, option]))

export function isAnnotationCategory(value: unknown): value is AnnotationCategory {
  return typeof value === 'string' && CATEGORY_OPTIONS_BY_ID.has(value as AnnotationCategory)
}

export function categoryOption(category: AnnotationCategory): LabelCategoryOption {
  return CATEGORY_OPTIONS_BY_ID.get(category) ?? ELK_CATEGORY_OPTIONS[0]!
}

/** The class after `category` in palette order, wrapping around (used by the E shortcut). */
export function nextCategory(category: AnnotationCategory): AnnotationCategory {
  const index = ELK_CATEGORY_OPTIONS.findIndex((option) => option.id === category)
  return ELK_CATEGORY_OPTIONS[(index + 1) % ELK_CATEGORY_OPTIONS.length]!.id
}
