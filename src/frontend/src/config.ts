import type { AnnotationCategory, CategorySummaryKey } from './types'

/** Keyboard shortcuts — consumed by useKeyboard.ts */
export const KEYS = {
  confirmSelection: { key: 'Enter' },
  unconfirmSelection: { key: 'Enter', shift: true },
  deleteOrReject: ['Backspace', 'Delete'],
  undo: { key: 'z', meta: true },
  redo: { key: 'z', meta: true, shift: true },
  selectAll: { key: 'a', meta: true },
  deselect: ['Escape'],
  cycleMarkerVisibility: ['v'],
  help: ['?'],
  cycleCategory: ['e'],
  // Per-class shortcuts (C/B/S/A/U) live on ELK_CATEGORY_OPTIONS[].shortcut below.
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
  /** Keyboard shortcut (no modifier) — the same letter as shortLabel. */
  shortcut: string
  /** Optional clarification shown after the name in the palette tooltip. */
  hint?: string
  /** Lowercase plural-ish noun used after a count ("3 bulls", "2 unclassified antlerless"). */
  countLabel: string
  /** Short text drawn in the marker badge; null means no badge (plain marker). */
  badge: string | null
  /** Shape drawn around the marker. The diamond indicator also gets a diamond badge. */
  indicator: CategoryIndicator
  /** Marker, badge, and status chip colour. */
  color: string
  /** Field on AnnotationSummary / RecentImageRecord that counts this class. */
  summaryKey: CategorySummaryKey
}

export const DEFAULT_CATEGORY: AnnotationCategory = 'cow'

/**
 * Single source of truth for elk classes. An entry here drives rendering, keyboard shortcuts, the E-cycle
 * order, counts, the status bar, the help overlay, and exports; adding a class also means widening `AnnotationCategory`
 * and `CategorySummaryKey` in types.ts — both are compile errors if missed.
 */
export const ELK_CATEGORY_OPTIONS: readonly LabelCategoryOption[] = [
  {
    id: 'cow',
    label: 'Cow',
    shortLabel: 'C',
    shortcut: 'c',
    countLabel: 'cows',
    badge: null,
    indicator: 'none',
    color: '#17B8FF',
    summaryKey: 'cows',
  },
  {
    id: 'bull',
    label: 'Bull',
    shortLabel: 'B',
    shortcut: 'b',
    countLabel: 'bulls',
    badge: 'B',
    indicator: 'ring',
    color: '#FF5D95',
    summaryKey: 'bulls',
  },
  {
    id: 'spike',
    label: 'Spike',
    shortLabel: 'S',
    shortcut: 's',
    countLabel: 'spikes',
    badge: 'S',
    indicator: 'diamond',
    color: '#73E46F',
    summaryKey: 'spikes',
  },
  {
    id: 'unclassified-antlerless',
    label: 'Unclassified antlerless',
    shortLabel: 'A',
    shortcut: 'a',
    hint: 'cow or calf — definitely not a bull or spike',
    countLabel: 'unclassified antlerless',
    badge: 'A',
    indicator: 'dashed-ring',
    color: '#C084FC',
    summaryKey: 'unclassifiedAntlerless',
  },
  {
    id: 'unclassified',
    label: 'Unclassified',
    shortLabel: 'U',
    shortcut: 'u',
    hint: 'an elk whose type could not be determined',
    countLabel: 'unclassified',
    badge: 'U',
    indicator: 'dashed-ring',
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

export function previousCategory(category: AnnotationCategory): AnnotationCategory {
  const index = ELK_CATEGORY_OPTIONS.findIndex((option) => option.id === category)
  return ELK_CATEGORY_OPTIONS[(index - 1 + ELK_CATEGORY_OPTIONS.length) % ELK_CATEGORY_OPTIONS.length]!.id
}
