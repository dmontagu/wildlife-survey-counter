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
  // Per-class shortcuts live on ELK_CATEGORY_OPTIONS[].shortcut below. They are matched after every
  // binding here, so a class letter that collides with one would be silently shadowed — config.test.ts
  // fails the build if that ever happens.
}

/** Zoom speed bounds */
export const DEFAULT_ZOOM_SPEED = 1
export const MIN_ZOOM_SPEED = 0.25
export const MAX_ZOOM_SPEED = 4

export const SHOW_DEV_SAMPLES = import.meta.env.DEV && import.meta.env.VITE_SHOW_SAMPLE_IMAGES !== 'false'
export const CONTACT_EMAIL = 'davwmont@gmail.com'
export const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSeK1SurenTcjOf0HY-Zs8aWsCVt83YInqJR7G6QMAP5J4K5rQ/viewform?usp=sharing'
export const UPDATES_FORM_ACTION =
  'https://docs.google.com/forms/d/e/1FAIpQLSeUXZkyX_QeI0da8xmAcI2bEiBKFaP3JFIsijEbHDkwC6AFXQ/formResponse'
export const UPDATES_FORM_EMAIL_FIELD = 'entry.1653319143'

export type CategoryIndicator = 'none' | 'ring' | 'dashed-ring' | 'diamond' | 'triangle'

/** Which half of the herd a class belongs to. Drives the palette grouping and the E-cycle order. */
export type CategoryGroup = 'antlerless' | 'bull' | 'any'

export interface LabelCategoryOption {
  id: AnnotationCategory
  /** Display name used in the palette, status bar, help overlay, and export panel. */
  label: string
  /** One-letter shorthand shown in the class palette; the selected class is spelled out next to it. */
  shortLabel: string
  /** Word label for the status-bar chip; defaults to `label`. Lets the bar stay compact (e.g. "Antlerless"). */
  statusLabel?: string
  /**
   * Keyboard shortcut (no modifier) — the same letter as shortLabel. Optional: bare letters are a scarce
   * global namespace shared with the non-class bindings in KEYS, so a class may ship without one and be
   * reached through the palette and the E cycle instead.
   */
  shortcut?: string
  /** Optional clarification shown after the name in the palette tooltip. */
  hint?: string
  /** Lowercase plural-ish noun used after a count ("3 bulls", "2 unclassified antlerless"). */
  countLabel: string
  /** Short text drawn in the marker badge; null means no badge (plain marker). */
  badge: string | null
  /** Shape drawn around the marker. Solid means a specific call, dashed means "unclassified". */
  indicator: CategoryIndicator
  /** Marker, badge, and status chip colour. */
  color: string
  /** Antlerless, bull, or neither — classes are laid out in group order. */
  group: CategoryGroup
  /** Field on AnnotationSummary / RecentImageRecord that counts this class. */
  summaryKey: CategorySummaryKey
}

export const DEFAULT_CATEGORY: AnnotationCategory = 'cow'

/**
 * Single source of truth for elk classes. An entry here drives rendering, keyboard shortcuts, the E-cycle
 * order, counts, the status bar, the help overlay, and exports; adding a class also means widening `AnnotationCategory`
 * and `CategorySummaryKey` in types.ts — both are compile errors if missed.
 *
 * The seven classes match the classification a survey crew records in the field. Marker shape carries certainty
 * rather than identity: a plain dot or a solid outline is a specific call, a dashed ring means "unclassified" at
 * that level.
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
    group: 'antlerless',
    summaryKey: 'cows',
  },
  {
    id: 'calf',
    label: 'Calf',
    shortLabel: 'F',
    shortcut: 'f',
    hint: 'C is taken by cow, so calf is F',
    countLabel: 'calves',
    badge: 'F',
    indicator: 'ring',
    color: '#6E9BFF',
    group: 'antlerless',
    summaryKey: 'calves',
  },
  {
    id: 'unclassified-antlerless',
    label: 'Unclassified antlerless',
    shortLabel: 'A',
    statusLabel: 'Antlerless?',
    shortcut: 'a',
    hint: 'cow or calf — definitely not a bull or spike',
    countLabel: 'unclassified antlerless',
    badge: 'A',
    indicator: 'dashed-ring',
    color: '#C084FC',
    group: 'antlerless',
    summaryKey: 'unclassifiedAntlerless',
  },
  {
    id: 'spike',
    label: 'Spike bull',
    shortLabel: 'S',
    statusLabel: 'Spike',
    shortcut: 's',
    countLabel: 'spike bulls',
    badge: 'S',
    indicator: 'diamond',
    color: '#73E46F',
    group: 'bull',
    summaryKey: 'spikes',
  },
  {
    id: 'brow-tined',
    label: 'Brow-tined bull',
    shortLabel: 'T',
    statusLabel: 'Brow-tined',
    shortcut: 't',
    hint: 'a mature bull with brow tines — brow-Tined is T',
    countLabel: 'brow-tined bulls',
    badge: 'T',
    indicator: 'triangle',
    color: '#F252C8',
    group: 'bull',
    summaryKey: 'browTinedBulls',
  },
  {
    id: 'bull',
    label: 'Unclassified bull',
    shortLabel: 'B',
    statusLabel: 'Bull?',
    shortcut: 'b',
    hint: 'a bull whose class could not be determined',
    countLabel: 'unclassified bulls',
    badge: 'B',
    indicator: 'dashed-ring',
    // Keeps the id and summary key ('bulls') that shipped when this class was simply "Bull": an older mark
    // asserted "a bull, kind unrecorded", which is exactly this class, so no stored data has to change.
    color: '#FF5D95',
    group: 'bull',
    summaryKey: 'bulls',
  },
  {
    id: 'unclassified',
    label: 'Unclassified elk',
    shortLabel: 'U',
    statusLabel: 'Unclassified',
    shortcut: 'u',
    hint: 'an elk whose type could not be determined',
    countLabel: 'unclassified',
    badge: 'U',
    indicator: 'dashed-ring',
    color: '#D4D4D8',
    group: 'any',
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

/**
 * Every bare (unmodified) key that KEYS claims for a non-class binding. useKeyboard.ts matches those first,
 * so a class shortcut drawn from this set would never fire; config.test.ts asserts the two never overlap.
 */
export function reservedBareKeys(): Set<string> {
  const keys = new Set<string>()
  for (const binding of Object.values(KEYS)) {
    if (Array.isArray(binding)) {
      for (const key of binding) keys.add(key.toLowerCase())
    } else if (typeof binding === 'object' && !('meta' in binding && binding.meta)) {
      keys.add(binding.key.toLowerCase())
    }
  }
  return keys
}
