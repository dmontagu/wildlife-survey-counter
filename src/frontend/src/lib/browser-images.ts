const DB_NAME = 'wsc-browser-images'
const STORE_NAME = 'images'
const DB_VERSION = 1
const BROWSER_IMAGE_BASE_PREFIX = 'browser-image://'

interface StoredBrowserImage {
  id: string
  file: Blob
  filename: string
  savedAt: string
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open browser image database'))
  })
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function createBrowserImageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function browserImageBasePath(id: string): string {
  return `${BROWSER_IMAGE_BASE_PREFIX}${id}`
}

export function isBrowserImageBasePath(basePath: string): boolean {
  return basePath.startsWith(BROWSER_IMAGE_BASE_PREFIX)
}

export function browserImageIdFromBasePath(basePath: string): string | null {
  if (!isBrowserImageBasePath(basePath)) return null
  const id = basePath.slice(BROWSER_IMAGE_BASE_PREFIX.length)
  return id || null
}

export async function saveBrowserImage(file: File): Promise<{ id: string; basePath: string }> {
  const db = await openDatabase()
  const id = createBrowserImageId()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  store.put({
    id,
    file,
    filename: file.name,
    savedAt: new Date().toISOString(),
  } satisfies StoredBrowserImage)
  await transactionDone(transaction)
  db.close()
  return {
    id,
    basePath: browserImageBasePath(id),
  }
}

export async function getBrowserImage(id: string): Promise<File | null> {
  const db = await openDatabase()
  const transaction = db.transaction(STORE_NAME, 'readonly')
  const store = transaction.objectStore(STORE_NAME)
  const record = await readRequest(store.get(id) as IDBRequest<StoredBrowserImage | undefined>)
  db.close()

  if (!record) return null
  if (record.file instanceof File) return record.file

  return new File([record.file], record.filename, {
    type: record.file.type || 'image/jpeg',
    lastModified: Date.parse(record.savedAt) || Date.now(),
  })
}

export async function getBrowserImageFromBasePath(basePath: string): Promise<File | null> {
  const id = browserImageIdFromBasePath(basePath)
  if (!id) return null
  return getBrowserImage(id)
}
