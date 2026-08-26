import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  displayNameFor,
  extensionForFilename,
  hasCustomDisplayName,
  normalizeDisplayName,
  stemForFilename,
} from './image-names'

describe('normalizeDisplayName', () => {
  it('treats a blank or absent name as "no custom name"', () => {
    for (const value of [null, undefined, '', '   ', '\n\t']) {
      expect(normalizeDisplayName(value, 'survey.jpg')).toBeNull()
    }
  })

  it('does not store a name that just repeats the filename', () => {
    expect(normalizeDisplayName('survey.jpg', 'survey.jpg')).toBeNull()
  })

  it('trims a real name but keeps its inner spacing', () => {
    expect(normalizeDisplayName('  North meadow  ', 'survey.jpg')).toBe('North meadow')
  })

  it('is idempotent, so renaming twice cannot degrade the name', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (name, filename) => {
        const once = normalizeDisplayName(name, filename)
        expect(normalizeDisplayName(once, filename)).toBe(once)
      }),
    )
  })
})

describe('displayNameFor', () => {
  it('falls back to the filename when there is no custom name', () => {
    expect(displayNameFor({ filename: 'survey.jpg' })).toBe('survey.jpg')
    expect(displayNameFor({ filename: 'survey.jpg', displayName: null })).toBe('survey.jpg')
    expect(displayNameFor({ filename: 'survey.jpg', displayName: '   ' })).toBe('survey.jpg')
  })

  it('always returns something showable', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.option(fc.string(), { nil: null }), (filename, displayName) => {
        expect(displayNameFor({ filename, displayName })).not.toBe('')
      }),
    )
  })

  it('reports whether the image has been renamed', () => {
    expect(hasCustomDisplayName({ filename: 'survey.jpg', displayName: 'North meadow' })).toBe(true)
    expect(hasCustomDisplayName({ filename: 'survey.jpg', displayName: 'survey.jpg' })).toBe(false)
    expect(hasCustomDisplayName({ filename: 'survey.jpg' })).toBe(false)
  })
})

describe('filename parts', () => {
  it('splits the stem from the extension', () => {
    expect(stemForFilename('survey-01.jpg')).toBe('survey-01')
    expect(extensionForFilename('survey-01.JPG')).toBe('jpg')
    expect(stemForFilename('a.b.c.png')).toBe('a.b.c')
    expect(extensionForFilename('a.b.c.png')).toBe('png')
  })

  it('assumes jpeg when there is no extension to read', () => {
    expect(stemForFilename('survey')).toBe('survey')
    expect(extensionForFilename('survey')).toBe('jpg')
  })
})
