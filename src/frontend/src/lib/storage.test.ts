import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  annotationsStorageKey,
  imageStorageId,
  LS_ACTIVE_CATEGORY_KEY,
  LS_BBOX_CREATION_KEY,
  LS_IMAGE_BASE_KEY,
  LS_IMAGE_DISPLAY_NAME_KEY,
  LS_IMAGE_KEY,
  LS_MARKER_VISIBILITY_KEY,
  LS_RECENT_IMAGES_KEY,
  LS_RECENT_IMAGES_SORT_KEY,
  LS_ZOOM_SPEED_KEY,
  legacyAnnotationsStorageKey,
} from './storage'

/**
 * Every base path the app can produce. `browser-image://` ids come from `crypto.randomUUID`, so a
 * literal sample stands in for the shape.
 */
const REAL_BASE_PATHS = ['/samples/', '/uploads/', 'browser-image://0b3e0d3a-6c4f-4f0d-9b3a-6f2a7d1c5e88']

describe('storage keys', () => {
  /**
   * These strings are the only thing connecting a released build to the work a user already has on
   * disk. Changing one silently orphans every saved annotation, so they are pinned as literals: the
   * test failing is the prompt to write a migration rather than ship the rename.
   */
  it('pins the localStorage key names that shipped builds already wrote', () => {
    expect({
      LS_IMAGE_KEY,
      LS_IMAGE_BASE_KEY,
      LS_IMAGE_DISPLAY_NAME_KEY,
      LS_ACTIVE_CATEGORY_KEY,
      LS_BBOX_CREATION_KEY,
      LS_MARKER_VISIBILITY_KEY,
      LS_ZOOM_SPEED_KEY,
      LS_RECENT_IMAGES_KEY,
      LS_RECENT_IMAGES_SORT_KEY,
    }).toEqual({
      LS_IMAGE_KEY: 'wsc:image',
      LS_IMAGE_BASE_KEY: 'wsc:image-base',
      LS_IMAGE_DISPLAY_NAME_KEY: 'wsc:image-display-name',
      LS_ACTIVE_CATEGORY_KEY: 'wsc:active-category',
      LS_BBOX_CREATION_KEY: 'wsc:bbox-creation-enabled',
      LS_MARKER_VISIBILITY_KEY: 'wsc:marker-visibility',
      LS_ZOOM_SPEED_KEY: 'wsc:zoom-speed',
      LS_RECENT_IMAGES_KEY: 'wsc:recent-images',
      LS_RECENT_IMAGES_SORT_KEY: 'wsc:recent-images-sort',
    })
  })

  it('pins the annotation key format for each image source', () => {
    expect(annotationsStorageKey('survey-01.jpg', '/samples/')).toBe('wsc:annotations:%2Fsamples%2F%7Csurvey-01.jpg')
    expect(annotationsStorageKey('survey-01.jpg', '/uploads/')).toBe('wsc:annotations:%2Fuploads%2F%7Csurvey-01.jpg')
    expect(annotationsStorageKey('survey-01.jpg', 'browser-image://abc-123')).toBe(
      'wsc:annotations:browser-image%3A%2F%2Fabc-123%7Csurvey-01.jpg',
    )
  })

  it('pins the pre-basePath annotation key format still read during migration', () => {
    expect(legacyAnnotationsStorageKey('survey-01.jpg')).toBe('wsc:annotations:survey-01.jpg')
  })

  it('keeps every key under the wsc: namespace', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...REAL_BASE_PATHS), (filename, basePath) => {
        expect(annotationsStorageKey(filename, basePath).startsWith('wsc:annotations:')).toBe(true)
      }),
    )
  })

  /**
   * Two different images sharing a key means one silently overwrites the other's annotations —
   * the worst failure this module can produce. Filenames come from whatever the user drops in, so
   * they are fuzzed; base paths are constrained to the three the app actually creates.
   */
  it('never gives two different images the same annotation key', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.constantFrom(...REAL_BASE_PATHS),
        fc.constantFrom(...REAL_BASE_PATHS),
        (filenameA, filenameB, basePathA, basePathB) => {
          fc.pre(filenameA !== filenameB || basePathA !== basePathB)
          expect(annotationsStorageKey(filenameA, basePathA)).not.toBe(annotationsStorageKey(filenameB, basePathB))
        },
      ),
    )
  })

  it('survives filenames with characters that are significant in a key or a URL', () => {
    const awkward = ['a|b.jpg', 'a%7Cb.jpg', 'wsc:annotations:x.jpg', '../../etc/passwd', 'πλ 🦌.jpeg', '']
    const keys = awkward.map((filename) => annotationsStorageKey(filename, '/uploads/'))
    expect(new Set(keys).size).toBe(awkward.length)
  })

  it('builds the recent-work record id the same way the annotation key does', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...REAL_BASE_PATHS), (filename, basePath) => {
        expect(annotationsStorageKey(filename, basePath)).toBe(
          `wsc:annotations:${encodeURIComponent(imageStorageId(filename, basePath))}`,
        )
      }),
    )
  })
})
