import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'

import { cleanup, configure } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach } from 'vitest'

// jsdom's Blob and File are not structured-cloneable, so fake-indexeddb stores an empty object
// where a photo should be and every IndexedDB round-trip loses its bytes. Node's implementations
// clone the way a browser does, which is the behaviour the image store is written against.
globalThis.Blob = NodeBlob as unknown as typeof Blob
globalThis.File = NodeFile as unknown as typeof File

// jsdom implements neither of these, and the canvas renderer, the minimap, the viewport and
// every export path touch them on mount. Stubbing them here keeps the shims in one place
// instead of scattered across test files.

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub

// A 2D context whose methods all no-op. Enough for the renderer to run end to end without
// asserting on pixels — the tests that matter here are about data, not drawing.
const CONTEXT_2D_NUMBERS: Record<string, unknown> = {
  canvas: null,
  measureText: () => ({ width: 0 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  createLinearGradient: () => ({ addColorStop: () => {} }),
  createRadialGradient: () => ({ addColorStop: () => {} }),
}

function createContext2dStub(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return new Proxy({ ...CONTEXT_2D_NUMBERS, canvas } as Record<string, unknown>, {
    get(target, property) {
      if (property in target) return target[property as string]
      return () => undefined
    },
    set(target, property, value) {
      target[property as string] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, contextId: string) {
  return contextId === '2d' ? createContext2dStub(this) : null
} as HTMLCanvasElement['getContext']

HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback, type?: string) {
  callback(new Blob(['stub'], { type: type ?? 'image/png' }))
}

// The annotation save is debounced by 500ms, so a `waitFor` that observes it needs a budget
// comfortably above Testing Library's 1s default.
configure({ asyncUtilTimeout: 3000 })

// Radix's menus and dialogs call these during a pointer interaction; jsdom implements none of
// them, and without stubs `userEvent.click` on a dropdown trigger throws instead of opening it.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

let objectUrlCounter = 0
URL.createObjectURL = () => `blob:wsc-test/${++objectUrlCounter}`
URL.revokeObjectURL = () => {}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // fake-indexeddb keeps one process-wide database registry; a fresh factory per test is the
  // documented way to reset it, and stops a leftover image blob from leaking into the next test.
  globalThis.indexedDB = new IDBFactory()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
})
