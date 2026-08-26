import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { recentImageRecord } from '../tests/helpers'
import type { RecentImageRecord } from '../types'
import {
  readRecentImages,
  removeRecentImage,
  sortRecentImages,
  upsertRecentImage,
  writeRecentImages,
} from './recent-images'
import { LS_RECENT_IMAGES_KEY } from './storage'

describe('readRecentImages', () => {
  it('round-trips a written list without losing a record or a field', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 15 }), (filenames) => {
        localStorage.clear()
        const records = filenames.map((filename, index) =>
          recentImageRecord({
            filename,
            counted: index,
            cows: index,
            lastEditedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
          }),
        )

        writeRecentImages(records)
        const restored = readRecentImages()

        expect(restored).toHaveLength(records.length)
        expect(new Set(restored.map((item) => item.id))).toEqual(new Set(records.map((item) => item.id)))
        for (const record of records) {
          expect(restored.find((item) => item.id === record.id)).toEqual(record)
        }
      }),
    )
  })

  it('returns nothing rather than throwing when the list is corrupt', () => {
    for (const corrupt of ['{not json', 'null', '"a string"', '{"records":[]}']) {
      localStorage.setItem(LS_RECENT_IMAGES_KEY, corrupt)
      expect(readRecentImages()).toEqual([])
    }
  })

  /**
   * A record written before a class existed simply has no field for it. Reading must fill in a zero
   * rather than dropping the record — otherwise adding a class would empty everyone's Recent Work.
   */
  it('keeps records written before a class existed, counting the missing class as zero', () => {
    localStorage.setItem(
      LS_RECENT_IMAGES_KEY,
      JSON.stringify([
        {
          id: '/uploads/|old.jpg',
          filename: 'old.jpg',
          basePath: '/uploads/',
          displayName: null,
          width: 800,
          height: 600,
          lastEditedAt: '2025-06-01T00:00:00.000Z',
          counted: 7,
          ignored: 1,
          cows: 5,
          bulls: 2,
        },
      ]),
    )

    expect(readRecentImages()).toEqual([
      recentImageRecord({
        id: '/uploads/|old.jpg',
        filename: 'old.jpg',
        basePath: '/uploads/',
        width: 800,
        height: 600,
        lastEditedAt: '2025-06-01T00:00:00.000Z',
        counted: 7,
        ignored: 1,
        cows: 5,
        bulls: 2,
      }),
    ])
  })

  it('reads the older lastOpenedAt timestamp when lastEditedAt is absent', () => {
    localStorage.setItem(
      LS_RECENT_IMAGES_KEY,
      JSON.stringify([
        { filename: 'old.jpg', basePath: '/uploads/', lastOpenedAt: '2025-01-02T03:04:05.000Z', counted: 3 },
      ]),
    )

    expect(readRecentImages()[0]).toMatchObject({
      filename: 'old.jpg',
      lastEditedAt: '2025-01-02T03:04:05.000Z',
      counted: 3,
    })
  })

  it('rebuilds a missing record id from the filename and base path', () => {
    localStorage.setItem(
      LS_RECENT_IMAGES_KEY,
      JSON.stringify([{ filename: 'old.jpg', basePath: '/samples/', lastEditedAt: '2025-01-01T00:00:00.000Z' }]),
    )

    expect(readRecentImages()[0]?.id).toBe('/samples/|old.jpg')
  })

  it('skips only the entries that cannot identify an image, keeping the rest', () => {
    localStorage.setItem(
      LS_RECENT_IMAGES_KEY,
      JSON.stringify([
        null,
        'nope',
        { basePath: '/uploads/' },
        { filename: 'keeper.jpg', basePath: '/uploads/', lastEditedAt: '2025-01-01T00:00:00.000Z' },
      ]),
    )

    expect(readRecentImages().map((item) => item.filename)).toEqual(['keeper.jpg'])
  })
})

describe('upsertRecentImage', () => {
  it('replaces a record in place without disturbing the others', () => {
    writeRecentImages([
      recentImageRecord({ filename: 'a.jpg', counted: 1, lastEditedAt: '2026-01-01T00:00:00.000Z' }),
      recentImageRecord({ filename: 'b.jpg', counted: 2, lastEditedAt: '2026-01-02T00:00:00.000Z' }),
      recentImageRecord({ filename: 'c.jpg', counted: 3, lastEditedAt: '2026-01-03T00:00:00.000Z' }),
    ])

    upsertRecentImage(recentImageRecord({ filename: 'b.jpg', counted: 99, lastEditedAt: '2026-01-04T00:00:00.000Z' }))

    const restored = readRecentImages()
    expect(restored).toHaveLength(3)
    expect(restored.find((item) => item.filename === 'b.jpg')?.counted).toBe(99)
    expect(restored.find((item) => item.filename === 'a.jpg')?.counted).toBe(1)
    expect(restored.find((item) => item.filename === 'c.jpg')?.counted).toBe(3)
  })

  it('treats the same filename under a different source as a separate image', () => {
    upsertRecentImage(recentImageRecord({ filename: 'survey.jpg', basePath: '/uploads/', counted: 4 }))
    upsertRecentImage(recentImageRecord({ filename: 'survey.jpg', basePath: '/samples/', counted: 9 }))

    const restored = readRecentImages()
    expect(restored).toHaveLength(2)
    expect(restored.find((item) => item.basePath === '/uploads/')?.counted).toBe(4)
    expect(restored.find((item) => item.basePath === '/samples/')?.counted).toBe(9)
  })
})

describe('removeRecentImage', () => {
  it('removes exactly one record', () => {
    writeRecentImages([
      recentImageRecord({ filename: 'a.jpg' }),
      recentImageRecord({ filename: 'b.jpg' }),
      recentImageRecord({ filename: 'c.jpg' }),
    ])

    removeRecentImage('/uploads/|b.jpg')

    expect(
      readRecentImages()
        .map((item) => item.filename)
        .sort(),
    ).toEqual(['a.jpg', 'c.jpg'])
  })

  it('leaves the list alone when the id is unknown', () => {
    writeRecentImages([recentImageRecord({ filename: 'a.jpg' })])
    removeRecentImage('/uploads/|missing.jpg')
    expect(readRecentImages()).toHaveLength(1)
  })
})

describe('sortRecentImages', () => {
  const older = recentImageRecord({ filename: 'zebra.jpg', lastEditedAt: '2026-01-01T00:00:00.000Z' })
  const newer = recentImageRecord({ filename: 'antelope.jpg', lastEditedAt: '2026-02-01T00:00:00.000Z' })

  it('puts the most recently edited image first by default', () => {
    expect(sortRecentImages([older, newer]).map((item) => item.filename)).toEqual(['antelope.jpg', 'zebra.jpg'])
  })

  it('sorts by display name when asked, using the renamed title', () => {
    const renamed = recentImageRecord({ filename: 'zebra.jpg', displayName: 'Alpha meadow' })
    expect(sortRecentImages([newer, renamed], 'alphabetical').map((item) => item.filename)).toEqual([
      'zebra.jpg',
      'antelope.jpg',
    ])
  })

  it('orders numbered filenames the way a person would read them', () => {
    const records = ['plot-10.jpg', 'plot-2.jpg', 'plot-1.jpg'].map((filename) => recentImageRecord({ filename }))
    expect(sortRecentImages(records, 'alphabetical').map((item) => item.filename)).toEqual([
      'plot-1.jpg',
      'plot-2.jpg',
      'plot-10.jpg',
    ])
  })

  it('does not mutate the list it sorts', () => {
    const records: RecentImageRecord[] = [older, newer]
    sortRecentImages(records)
    expect(records.map((item) => item.filename)).toEqual(['zebra.jpg', 'antelope.jpg'])
  })

  it('keeps every record whatever the order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 12 }),
        fc.constantFrom('last-edited' as const, 'alphabetical' as const),
        (filenames, mode) => {
          const records = filenames.map((filename) => recentImageRecord({ filename }))
          expect(sortRecentImages(records, mode)).toHaveLength(records.length)
        },
      ),
    )
  })
})
