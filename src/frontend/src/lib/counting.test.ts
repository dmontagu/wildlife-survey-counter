import { afterEach, describe, expect, it, vi } from 'vitest'
import { countingRequest } from './counting'

const clientKey = 'wsc:counting-client:v1'
afterEach(() => vi.unstubAllGlobals())

describe('private counting requests', () => {
  it('keeps one identity across requests and reloads, and separates browser profiles', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetcher)
    await Promise.all([countingRequest('runs?sha256=same'), countingRequest('capabilities')])
    const token = localStorage.getItem(clientKey)
    expect(token).toBeTruthy()
    for (const [, options] of fetcher.mock.calls) expect(options.headers.get('X-Counting-Client')).toBe(token)
    vi.resetModules()
    const reloaded = await import('./counting')
    await reloaded.countingRequest('runs?sha256=same')
    expect(fetcher.mock.lastCall?.[1].headers.get('X-Counting-Client')).toBe(token)
    localStorage.clear() // A separate browser profile has independent storage.
    await reloaded.countingRequest('runs?sha256=same')
    expect(fetcher.mock.lastCall?.[1].headers.get('X-Counting-Client')).not.toBe(token)
  })

  it('fails before sending work if the private identity cannot be saved', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full')
    })
    await expect(countingRequest('runs', { method: 'POST' })).rejects.toThrow('Enable browser storage')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
