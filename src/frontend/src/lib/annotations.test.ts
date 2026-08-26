import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORY, ELK_CATEGORY_OPTIONS } from '../config'
import type { Annotation } from '../types'
import {
  emptyCategoryCounts,
  formatCountSummary,
  getDisplayNumbers,
  getVisibleAnnotations,
  isCountedAnnotation,
  isIgnoredAnnotation,
  normalizeAnnotation,
  normalizeAnnotations,
  prepareImportedAnnotations,
  storedAnnotationsMatch,
  summarizeAnnotations,
} from './annotations'

const arbitraryAnnotation: fc.Arbitrary<Annotation> = fc.record({
  id: fc.integer({ min: 1, max: 100_000 }),
  x: fc.integer({ min: 0, max: 20_000 }),
  y: fc.integer({ min: 0, max: 20_000 }),
  bbox: fc.option(
    fc.tuple(
      fc.integer({ min: 0, max: 20_000 }),
      fc.integer({ min: 0, max: 20_000 }),
      fc.integer({ min: 0, max: 20_000 }),
      fc.integer({ min: 0, max: 20_000 }),
    ),
    { nil: null },
  ),
  detection_confidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  classification_confidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  source: fc.constantFrom('manual', 'blob', 'yolo', 'owlv2'),
  label: fc.constantFrom('elk', 'cow', 'bull', 'animal'),
  category: fc.constantFrom(...ELK_CATEGORY_OPTIONS.map((option) => option.id)),
  state: fc.constantFrom('auto-detected', 'confirmed', 'rejected', 'manually-added'),
  reviewStatus: fc.constantFrom('confirmed', 'unconfirmed'),
})

/** What a browser reload actually does to saved work: serialise, store, parse, normalise. */
function roundTripThroughStorage(annotations: Annotation[]): Annotation[] {
  return normalizeAnnotations(JSON.parse(JSON.stringify(annotations)))
}

describe('normalizeAnnotations', () => {
  it('returns a saved run of annotations completely unchanged', () => {
    fc.assert(
      fc.property(fc.array(arbitraryAnnotation, { maxLength: 40 }), (saved) => {
        expect(roundTripThroughStorage(saved)).toEqual(saved)
      }),
    )
  })

  /**
   * The app re-serialises whatever it normalised back into localStorage on the next save, so a
   * normaliser that keeps changing its own output would corrupt a little more of a user's work on
   * every session.
   */
  it('is idempotent, so repeated load/save cycles cannot drift', () => {
    fc.assert(
      fc.property(fc.array(arbitraryAnnotation, { maxLength: 40 }), (saved) => {
        const once = roundTripThroughStorage(saved)
        expect(roundTripThroughStorage(once)).toEqual(once)
      }),
    )
  })

  it('never drops an entry, however damaged the stored payload is', () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 30 }), (garbage) => {
        expect(normalizeAnnotations(garbage)).toHaveLength(garbage.length)
      }),
    )
  })

  it('always produces a usable annotation from junk rather than throwing', () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const result = normalizeAnnotation(junk)
        expect(Number.isFinite(result.id)).toBe(true)
        expect(Number.isFinite(result.x)).toBe(true)
        expect(Number.isFinite(result.y)).toBe(true)
        expect(ELK_CATEGORY_OPTIONS.map((option) => option.id)).toContain(result.category)
      }),
    )
  })

  it('returns an empty list for a payload that is not an array', () => {
    for (const value of [null, undefined, {}, 'nope', 7]) {
      expect(normalizeAnnotations(value)).toEqual([])
    }
  })

  it('gives entries without an id a stable position-based id', () => {
    const result = normalizeAnnotations([{ x: 1, y: 2 }, {}, { id: 99, x: 3, y: 4 }])
    expect(result.map((item) => item.id)).toEqual([1, 2, 99])
  })
})

describe('normalizeAnnotation legacy shapes', () => {
  it('upgrades the pre-class shape, where a null category meant cow', () => {
    const legacy = { id: 1, x: 10, y: 20, category: null, label: 'elk', state: 'confirmed' }
    expect(normalizeAnnotation(legacy).category).toBe(DEFAULT_CATEGORY)
  })

  it('recovers the class from a label when the category field is missing', () => {
    const cases: [string, string][] = [
      ['bull elk', 'bull'],
      ['Spike', 'spike'],
      ['unclassified_antlerless', 'unclassified-antlerless'],
      ['unclassified antlerless', 'unclassified-antlerless'],
      ['unclassified', 'unclassified'],
      ['elk', DEFAULT_CATEGORY],
    ]

    for (const [label, expected] of cases) {
      expect(normalizeAnnotation({ id: 1, x: 0, y: 0, label }).category).toBe(expected)
    }
  })

  it('defaults an unknown class to cow rather than discarding the annotation', () => {
    const result = normalizeAnnotation({ id: 1, x: 5, y: 6, category: 'calf' })
    expect(result).toMatchObject({ id: 1, x: 5, y: 6, category: DEFAULT_CATEGORY })
  })

  it('treats an annotation with no review status as already reviewed', () => {
    expect(normalizeAnnotation({ id: 1, x: 0, y: 0 }).reviewStatus).toBe('confirmed')
    expect(normalizeAnnotation({ id: 1, x: 0, y: 0 }).state).toBe('confirmed')
  })

  it('drops a malformed bbox without losing the point it belongs to', () => {
    for (const bbox of [null, undefined, [], [1, 2, 3], [1, 2, 3, 'x'], 'nope']) {
      const result = normalizeAnnotation({ id: 4, x: 11, y: 22, bbox })
      expect(result.bbox).toBeNull()
      expect(result).toMatchObject({ id: 4, x: 11, y: 22 })
    }
  })

  it('rounds a fractional bbox and point instead of rejecting them', () => {
    const result = normalizeAnnotation({ id: 1, x: 10.4, y: 20.6, bbox: [1.2, 2.7, 3.4, 4.5] })
    expect(result).toMatchObject({ x: 10, y: 21, bbox: [1, 3, 3, 5] })
  })
})

describe('storedAnnotationsMatch', () => {
  it('is false when nothing is stored yet', () => {
    expect(storedAnnotationsMatch(null, '[]')).toBe(false)
  })

  it('is true for a byte-identical payload', () => {
    const serialized = JSON.stringify(normalizeAnnotations([{ id: 1, x: 1, y: 2 }]))
    expect(storedAnnotationsMatch(serialized, serialized)).toBe(true)
  })

  it('treats a payload that only differs by migration as unchanged', () => {
    const legacy = JSON.stringify([{ id: 1, x: 1, y: 2, category: null }])
    const migrated = JSON.stringify(normalizeAnnotations(JSON.parse(legacy)))
    expect(storedAnnotationsMatch(legacy, migrated)).toBe(true)
  })

  it('treats corrupt stored text as different so it is never mistaken for a match', () => {
    expect(storedAnnotationsMatch('{not json', '[]')).toBe(false)
  })

  it('detects a real edit', () => {
    const before = JSON.stringify(normalizeAnnotations([{ id: 1, x: 1, y: 2 }]))
    const after = JSON.stringify(normalizeAnnotations([{ id: 1, x: 1, y: 3 }]))
    expect(storedAnnotationsMatch(before, after)).toBe(false)
  })
})

describe('prepareImportedAnnotations', () => {
  it('marks imported work as needing review but keeps ignored entries ignored', () => {
    const imported = prepareImportedAnnotations([
      { id: 1, x: 1, y: 1, state: 'confirmed', reviewStatus: 'confirmed' },
      { id: 2, x: 2, y: 2, state: 'rejected', reviewStatus: 'confirmed' },
    ])

    expect(imported[0]).toMatchObject({ id: 1, reviewStatus: 'unconfirmed' })
    expect(imported[1]).toMatchObject({ id: 2, state: 'rejected', reviewStatus: 'confirmed' })
  })

  it('preserves the class and position of every imported annotation', () => {
    fc.assert(
      fc.property(fc.array(arbitraryAnnotation, { maxLength: 20 }), (saved) => {
        const imported = prepareImportedAnnotations(JSON.parse(JSON.stringify(saved)))
        expect(imported.map((item) => [item.id, item.x, item.y, item.category])).toEqual(
          saved.map((item) => [item.id, item.x, item.y, item.category]),
        )
      }),
    )
  })
})

describe('summarizeAnnotations', () => {
  it('counts every annotation exactly once', () => {
    fc.assert(
      fc.property(fc.array(arbitraryAnnotation, { maxLength: 50 }), (list) => {
        const summary = summarizeAnnotations(list)
        expect(summary.counted + summary.ignored).toBe(list.length)

        const perClassTotal = ELK_CATEGORY_OPTIONS.reduce((total, option) => total + summary[option.summaryKey], 0)
        expect(perClassTotal).toBe(summary.counted)
      }),
    )
  })

  it('splits counted, ignored and unconfirmed the way the status bar reports them', () => {
    const summary = summarizeAnnotations([
      { ...base(), id: 1, category: 'cow', reviewStatus: 'unconfirmed' },
      { ...base(), id: 2, category: 'bull' },
      { ...base(), id: 3, category: 'spike' },
      { ...base(), id: 4, category: 'unclassified-antlerless' },
      { ...base(), id: 5, category: 'unclassified' },
      { ...base(), id: 6, category: 'cow', state: 'rejected' },
    ])

    expect(summary).toEqual({
      counted: 5,
      ignored: 1,
      unconfirmed: 1,
      cows: 1,
      bulls: 1,
      spikes: 1,
      unclassifiedAntlerless: 1,
      unclassified: 1,
    })
  })

  it('starts every class at zero', () => {
    expect(summarizeAnnotations([])).toEqual({ ...emptyCategoryCounts(), counted: 0, ignored: 0, unconfirmed: 0 })
  })

  it('agrees with the ignored/counted predicates', () => {
    fc.assert(
      fc.property(fc.array(arbitraryAnnotation, { maxLength: 30 }), (list) => {
        expect(summarizeAnnotations(list).ignored).toBe(list.filter(isIgnoredAnnotation).length)
        expect(summarizeAnnotations(list).counted).toBe(list.filter(isCountedAnnotation).length)
      }),
    )
  })
})

describe('formatCountSummary', () => {
  it('shows the total alone when everything is the default class', () => {
    expect(formatCountSummary({ ...emptyCategoryCounts(), counted: 12, cows: 12 })).toBe('12 counted')
  })

  it('appends only the classes that are actually present', () => {
    expect(formatCountSummary({ ...emptyCategoryCounts(), counted: 16, cows: 12, bulls: 3, unclassified: 1 })).toBe(
      '16 counted, 3 bulls, 1 unclassified',
    )
  })
})

describe('getVisibleAnnotations', () => {
  const list: Annotation[] = [
    { ...base(), id: 1, detection_confidence: 0.9 },
    { ...base(), id: 2, detection_confidence: 0.1 },
    { ...base(), id: 3, detection_confidence: null },
    { ...base(), id: 4, state: 'rejected', detection_confidence: 0.9 },
  ]

  it('hides ignored annotations unless they are asked for', () => {
    expect(getVisibleAnnotations(list, { showRejected: false, confidenceThreshold: 0 }).map((a) => a.id)).toEqual([
      1, 2, 3,
    ])
    expect(getVisibleAnnotations(list, { showRejected: true, confidenceThreshold: 0 }).map((a) => a.id)).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('keeps manual annotations, which have no confidence, above every threshold', () => {
    expect(getVisibleAnnotations(list, { showRejected: false, confidenceThreshold: 0.5 }).map((a) => a.id)).toEqual([
      1, 3,
    ])
  })

  it('never mutates the list it filters', () => {
    const before = JSON.stringify(list)
    getVisibleAnnotations(list, { showRejected: true, confidenceThreshold: 0.5 })
    expect(JSON.stringify(list)).toBe(before)
  })
})

describe('getDisplayNumbers', () => {
  it('numbers top-to-bottom, then left-to-right', () => {
    const numbers = getDisplayNumbers([
      { ...base(), id: 10, x: 50, y: 100 },
      { ...base(), id: 11, x: 10, y: 100 },
      { ...base(), id: 12, x: 30, y: 10 },
    ])

    expect([...numbers.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual([12, 11, 10])
  })

  it('gives every annotation a distinct number', () => {
    fc.assert(
      fc.property(fc.array(arbitraryAnnotation, { maxLength: 30 }), (list) => {
        const unique = new Map(list.map((item) => [item.id, item]))
        const numbers = getDisplayNumbers([...unique.values()])
        expect(numbers.size).toBe(unique.size)
        expect(new Set(numbers.values()).size).toBe(unique.size)
      }),
    )
  })
})

function base(): Annotation {
  return {
    id: 1,
    x: 0,
    y: 0,
    bbox: null,
    detection_confidence: null,
    classification_confidence: null,
    source: 'manual',
    label: 'elk',
    category: 'cow',
    state: 'manually-added',
    reviewStatus: 'confirmed',
  }
}
