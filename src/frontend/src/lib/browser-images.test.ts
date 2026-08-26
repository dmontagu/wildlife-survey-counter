import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  browserImageBasePath,
  browserImageIdFromBasePath,
  deleteBrowserImage,
  deleteBrowserImageFromBasePath,
  getBrowserImage,
  getBrowserImageFromBasePath,
  isBrowserImageBasePath,
  saveBrowserImage,
} from './browser-images'

/**
 * The names of the database and its object store are the only handle the app has on images a user
 * opened in an earlier session. Reading them directly — rather than through the module — is what
 * makes a rename fail this test instead of silently orphaning everyone's photos.
 */
const DB_NAME = 'wsc-browser-images'
const STORE_NAME = 'images'

function imageFile(name = 'survey-01.jpg', contents = 'fake-jpeg-bytes'): File {
  return new File([contents], name, { type: 'image/jpeg' })
}

function openRaw(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
  })
}

function readAllRaw(db: IDBDatabase): Promise<{ id: string; filename: string; savedAt: string; file: Blob }[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe('browser image base paths', () => {
  it('round-trips an id through the synthetic base path', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        const basePath = browserImageBasePath(id)
        expect(isBrowserImageBasePath(basePath)).toBe(true)
        expect(browserImageIdFromBasePath(basePath)).toBe(id)
      }),
    )
  })

  it('pins the prefix that saved routes and storage keys already contain', () => {
    expect(browserImageBasePath('abc')).toBe('browser-image://abc')
  })

  it('does not mistake a server path for a browser image', () => {
    for (const basePath of ['/samples/', '/uploads/', '', 'https://example.com/']) {
      expect(isBrowserImageBasePath(basePath)).toBe(false)
      expect(browserImageIdFromBasePath(basePath)).toBeNull()
    }
  })

  it('treats a prefix with no id as no image', () => {
    expect(browserImageIdFromBasePath('browser-image://')).toBeNull()
  })
})

describe('saveBrowserImage', () => {
  it('gives back the bytes and the filename that were stored', async () => {
    const { basePath } = await saveBrowserImage(imageFile('meadow.jpg', 'pixels-here'))

    const restored = await getBrowserImageFromBasePath(basePath)
    expect(restored).not.toBeNull()
    expect(restored?.name).toBe('meadow.jpg')
    expect(restored?.type).toBe('image/jpeg')
    expect(await restored?.text()).toBe('pixels-here')
  })

  it('stores each image under its own id', async () => {
    const first = await saveBrowserImage(imageFile('a.jpg', 'aaa'))
    const second = await saveBrowserImage(imageFile('b.jpg', 'bbb'))

    expect(first.id).not.toBe(second.id)
    expect(await (await getBrowserImage(first.id))?.text()).toBe('aaa')
    expect(await (await getBrowserImage(second.id))?.text()).toBe('bbb')
  })

  it('writes into the database and store name that earlier sessions used', async () => {
    const { id } = await saveBrowserImage(imageFile('meadow.jpg'))

    const db = await openRaw()
    const records = await readAllRaw(db)
    db.close()

    expect(records.map((record) => record.id)).toEqual([id])
    expect(records[0]?.filename).toBe('meadow.jpg')
    expect(Date.parse(records[0]?.savedAt ?? '')).not.toBeNaN()
  })

  /**
   * Opening the database a second time must not re-create the object store. If it ever did, every
   * image a user had opened would disappear the next time the app started.
   */
  it('keeps existing images when the database is opened again', async () => {
    const { id } = await saveBrowserImage(imageFile('keep-me.jpg', 'still-here'))

    await saveBrowserImage(imageFile('another.jpg'))
    const restored = await getBrowserImage(id)

    expect(await restored?.text()).toBe('still-here')
  })
})

describe('getBrowserImage', () => {
  it('returns null for an id that is not stored, rather than throwing', async () => {
    await expect(getBrowserImage('not-a-real-id')).resolves.toBeNull()
    await expect(getBrowserImageFromBasePath('browser-image://not-a-real-id')).resolves.toBeNull()
    await expect(getBrowserImageFromBasePath('/uploads/')).resolves.toBeNull()
  })

  it('rebuilds a File from a record whose blob lost its File wrapper in storage', async () => {
    const db = await openRaw()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put({
        id: 'plain-blob',
        file: new Blob(['blob-bytes'], { type: '' }),
        filename: 'legacy.jpg',
        savedAt: '2025-05-01T00:00:00.000Z',
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()

    const restored = await getBrowserImage('plain-blob')
    expect(restored?.name).toBe('legacy.jpg')
    expect(restored?.type).toBe('image/jpeg')
    expect(await restored?.text()).toBe('blob-bytes')
  })
})

describe('deleteBrowserImage', () => {
  it('removes only the image it was asked to remove', async () => {
    const doomed = await saveBrowserImage(imageFile('doomed.jpg', 'gone'))
    const keeper = await saveBrowserImage(imageFile('keeper.jpg', 'kept'))

    await deleteBrowserImage(doomed.id)

    expect(await getBrowserImage(doomed.id)).toBeNull()
    expect(await (await getBrowserImage(keeper.id))?.text()).toBe('kept')
  })

  it('deletes through a base path too', async () => {
    const { basePath } = await saveBrowserImage(imageFile('doomed.jpg'))
    await deleteBrowserImageFromBasePath(basePath)
    expect(await getBrowserImageFromBasePath(basePath)).toBeNull()
  })

  it('ignores a base path that is not a browser image', async () => {
    const { id } = await saveBrowserImage(imageFile('keeper.jpg', 'kept'))
    await deleteBrowserImageFromBasePath('/uploads/')
    expect(await (await getBrowserImage(id))?.text()).toBe('kept')
  })

  it('is a no-op for an id that is already gone', async () => {
    await expect(deleteBrowserImage('never-existed')).resolves.toBeUndefined()
  })
})
