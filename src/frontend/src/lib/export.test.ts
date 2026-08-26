import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ELK_CATEGORY_OPTIONS } from '../config'
import { annotation, annotations } from '../tests/helpers'
import type { Annotation } from '../types'
import { normalizeAnnotations, prepareImportedAnnotations, summarizeAnnotations } from './annotations'
import { buildExportPayload } from './export'

/**
 * The JSON export is the only copy of a reviewer's work that lives outside this browser, so it is
 * also the recovery path when browser storage is lost. These tests hold it to the standard that
 * makes it usable as a backup: everything that was counted is in the file, and importing the file
 * puts everything back.
 */

const image = { filename: 'survey-01.jpg', displayName: null, width: 1200, height: 900 }

describe('buildExportPayload', () => {
  it('includes every annotation and the counts that go with them', () => {
    const work = [
      annotation({ id: 1, category: 'cow' }),
      annotation({ id: 2, category: 'bull' }),
      annotation({ id: 3, category: 'cow', state: 'rejected' }),
    ]

    const payload = buildExportPayload(image, work)

    expect(payload.annotations).toEqual(work)
    expect(payload.summary).toMatchObject({ counted: 2, ignored: 1, cows: 1, bulls: 1 })
    expect(payload.image).toEqual({
      filename: 'survey-01.jpg',
      sourceFilename: 'survey-01.jpg',
      width: 1200,
      height: 900,
    })
  })

  it('labels the export with the name the reviewer gave the image', () => {
    const payload = buildExportPayload({ ...image, displayName: 'North meadow' }, [])
    expect(payload.image).toMatchObject({ filename: 'North meadow', sourceFilename: 'survey-01.jpg' })
  })

  it('survives being serialised, so nothing in it is unrepresentable in JSON', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), (count) => {
        const payload = buildExportPayload(image, annotations(count))
        expect(JSON.parse(JSON.stringify(payload)).annotations).toHaveLength(count)
      }),
    )
  })
})

describe('exporting and importing again', () => {
  const arbitraryWork = fc.array(
    fc.record({
      x: fc.integer({ min: 0, max: 5000 }),
      y: fc.integer({ min: 0, max: 5000 }),
      category: fc.constantFrom(...ELK_CATEGORY_OPTIONS.map((option) => option.id)),
      state: fc.constantFrom('auto-detected' as const, 'confirmed' as const, 'manually-added' as const),
    }),
    { maxLength: 30 },
  )

  function exportThenImport(work: Annotation[]): Annotation[] {
    const file = JSON.stringify(buildExportPayload(image, work))
    return prepareImportedAnnotations(JSON.parse(file).annotations)
  }

  it('brings back every marker at the same position and class', () => {
    fc.assert(
      fc.property(arbitraryWork, (rows) => {
        const work = rows.map((row, index) => annotation({ id: index + 1, ...row }))

        expect(exportThenImport(work).map((item) => [item.id, item.x, item.y, item.category])).toEqual(
          work.map((item) => [item.id, item.x, item.y, item.category]),
        )
      }),
    )
  })

  it('brings back the same total count', () => {
    fc.assert(
      fc.property(arbitraryWork, (rows) => {
        const work = rows.map((row, index) => annotation({ id: index + 1, ...row }))

        expect(summarizeAnnotations(exportThenImport(work)).counted).toBe(summarizeAnnotations(work).counted)
      }),
    )
  })

  it('keeps ignored markers ignored rather than silently re-counting them', () => {
    const work = [annotation({ id: 1, state: 'rejected' }), annotation({ id: 2, state: 'confirmed' })]

    const reimported = exportThenImport(work)

    expect(reimported[0]).toMatchObject({ state: 'rejected' })
    expect(summarizeAnnotations(reimported).ignored).toBe(1)
  })

  it('marks everything else as needing review, because it came from outside this session', () => {
    const reimported = exportThenImport([annotation({ id: 1, reviewStatus: 'confirmed' })])
    expect(reimported[0]?.reviewStatus).toBe('unconfirmed')
  })

  it('reads a bare array of annotations, which is what an external tool is likely to produce', () => {
    const work = annotations(3)
    const bare = JSON.parse(JSON.stringify(work))
    expect(normalizeAnnotations(bare)).toHaveLength(3)
  })
})
