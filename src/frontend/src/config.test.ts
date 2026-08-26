import { describe, expect, it } from 'vitest'
import {
  categoryOption,
  DEFAULT_CATEGORY,
  ELK_CATEGORY_OPTIONS,
  isAnnotationCategory,
  nextCategory,
  previousCategory,
  reservedBareKeys,
} from './config'

/**
 * Class ids are persisted verbatim inside every saved annotation, and summary keys are persisted
 * inside every recent-work record. An id that disappears from this table stops being recognised on
 * load and silently falls back to the default class, so removing or renaming one is a data
 * migration, not a refactor. Adding a class is fine and only needs the new id listed here.
 */
const SHIPPED_CATEGORY_IDS = ['cow', 'calf', 'bull', 'brow-tined', 'spike', 'unclassified-antlerless', 'unclassified']
const SHIPPED_SUMMARY_KEYS = [
  'cows',
  'calves',
  'bulls',
  'browTinedBulls',
  'spikes',
  'unclassifiedAntlerless',
  'unclassified',
]

describe('elk classes', () => {
  it('still recognises every class id that shipped builds have written to storage', () => {
    const ids = ELK_CATEGORY_OPTIONS.map((option) => option.id)
    for (const shipped of SHIPPED_CATEGORY_IDS) {
      expect(ids).toContain(shipped)
      expect(isAnnotationCategory(shipped)).toBe(true)
    }
  })

  it('still recognises every summary key that shipped builds have written to recent work', () => {
    const summaryKeys = ELK_CATEGORY_OPTIONS.map((option) => option.summaryKey)
    for (const shipped of SHIPPED_SUMMARY_KEYS) {
      expect(summaryKeys).toContain(shipped)
    }
  })

  it('keeps ids, summary keys, and single-letter shortcuts unique', () => {
    const ids = ELK_CATEGORY_OPTIONS.map((option) => option.id)
    const summaryKeys = ELK_CATEGORY_OPTIONS.map((option) => option.summaryKey)
    const shortcuts = ELK_CATEGORY_OPTIONS.map((option) => option.shortcut)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(summaryKeys).size).toBe(summaryKeys.length)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('defaults to a class that exists', () => {
    expect(isAnnotationCategory(DEFAULT_CATEGORY)).toBe(true)
    expect(categoryOption(DEFAULT_CATEGORY).id).toBe(DEFAULT_CATEGORY)
  })

  it('rejects values that are not class ids', () => {
    for (const value of [null, undefined, '', 'Cow', 'moose', 42, {}]) {
      expect(isAnnotationCategory(value)).toBe(false)
    }
  })

  it('keeps class letters out of the keys KEYS already claims', () => {
    // useKeyboard.ts matches every KEYS binding before the class loop, so a class letter drawn from
    // that set would never fire. Failing here is cheaper than shipping a shortcut that does nothing.
    const reserved = reservedBareKeys()
    for (const option of ELK_CATEGORY_OPTIONS) {
      if (!option.shortcut) continue
      expect(reserved.has(option.shortcut.toLowerCase())).toBe(false)
    }
  })

  it('cycles forward and backward through the whole palette', () => {
    let category = DEFAULT_CATEGORY
    const forward = ELK_CATEGORY_OPTIONS.map(() => {
      category = nextCategory(category)
      return category
    })

    expect(new Set(forward).size).toBe(ELK_CATEGORY_OPTIONS.length)
    expect(category).toBe(DEFAULT_CATEGORY)

    for (const option of ELK_CATEGORY_OPTIONS) {
      expect(previousCategory(nextCategory(option.id))).toBe(option.id)
    }
  })
})
