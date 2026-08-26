import { Redo2Icon, Trash2Icon, Undo2Icon } from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import Canvas from './components/Canvas'
import HelpOverlay from './components/HelpOverlay'
import ImageToolOverlays from './components/ImageToolOverlays'
import MarkerVisibilityControl from './components/MarkerVisibilityControl'
import Minimap from './components/Minimap'
import ShortcutKey, { ShortcutSequence } from './components/ShortcutKey'
import StatusBar from './components/StatusBar'
import Toolbar from './components/Toolbar'
import { Button } from './components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import WelcomeScreen from './components/WelcomeScreen'
import { ELK_CATEGORY_OPTIONS, isAnnotationCategory, SHOW_DEV_SAMPLES } from './config'
import { useViewport } from './hooks/useViewport'
import {
  normalizeAnnotations,
  prepareImportedAnnotations,
  storedAnnotationsMatch,
  summarizeAnnotations,
} from './lib/annotations'
import {
  browserImageBasePath,
  browserImageIdFromBasePath,
  deleteBrowserImageFromBasePath,
  getBrowserImageFromBasePath,
  isBrowserImageBasePath,
  saveBrowserImage,
} from './lib/browser-images'
import {
  exportAnnotatedImage,
  exportCombinedJsonOnly,
  exportJsonOnly,
  exportOriginalImage,
  exportResults,
  exportResultsFromBlob,
  exportResultsFromUrl,
} from './lib/export'
import { displayNameFor, normalizeDisplayName } from './lib/image-names'
import { stripImageMetadata } from './lib/images'
import { readRecentImages, removeRecentImage, sortRecentImages, upsertRecentImage } from './lib/recent-images'
import {
  annotationsStorageKey,
  LS_ACTIVE_CATEGORY_KEY,
  LS_BBOX_CREATION_KEY,
  LS_IMAGE_BASE_KEY,
  LS_IMAGE_DISPLAY_NAME_KEY,
  LS_IMAGE_KEY,
  LS_MARKER_VISIBILITY_KEY,
  LS_RECENT_IMAGES_SORT_KEY,
  LS_ZOOM_SPEED_KEY,
  legacyAnnotationsStorageKey,
} from './lib/storage'
import { isMac, platformModifier } from './platform'
import { AppStateContext, DispatchContext, initialState, reducer } from './state'
import type {
  Annotation,
  CategorySummaryKey,
  RecentImageRecord,
  RecentImagesSortMode,
  ServerImageRecord,
} from './types'

interface PendingSave {
  filename: string
  displayName: string | null
  basePath: string
  width: number
  height: number
  annotations: Annotation[]
}

interface PendingAnnotationImport {
  file: File
}

function isJsonFile(file: File): boolean {
  return file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')
}

function buildImagePath(basePath: string, filename: string): string {
  if (isBrowserImageBasePath(basePath)) {
    const imageId = browserImageIdFromBasePath(basePath)
    if (imageId) {
      return `/image/local/${encodeURIComponent(imageId)}`
    }
  }

  if (basePath === '/samples/') {
    return `/image/sample?f=${encodeURIComponent(filename)}`
  }

  if (basePath === '/uploads/') {
    return `/image/uploads?f=${encodeURIComponent(filename)}`
  }

  return `/image/source?b=${encodeURIComponent(basePath)}&f=${encodeURIComponent(filename)}`
}

function parseImagePath(
  pathname: string,
  search = '',
):
  | { kind: 'home' }
  | { kind: 'local-image'; basePath: string }
  | { kind: 'image'; basePath: string; filename: string }
  | null {
  if (pathname === '/' || pathname === '') {
    return { kind: 'home' }
  }

  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'image') {
    return null
  }

  try {
    const searchParams = new URLSearchParams(search)

    if (parts[1] === 'local' && parts.length >= 3) {
      return {
        kind: 'local-image',
        basePath: browserImageBasePath(decodeURIComponent(parts[2]!)),
      }
    }

    if (parts[1] === 'sample') {
      const filename = searchParams.get('f')
      if (filename) {
        return {
          kind: 'image',
          basePath: '/samples/',
          filename,
        }
      }
    }

    if (parts[1] === 'uploads') {
      const filename = searchParams.get('f')
      if (filename) {
        return {
          kind: 'image',
          basePath: '/uploads/',
          filename,
        }
      }
    }

    if (parts[1] === 'source') {
      const basePath = searchParams.get('b')
      const filename = searchParams.get('f')
      if (basePath && filename) {
        return {
          kind: 'image',
          basePath,
          filename,
        }
      }
    }

    if (parts[1] === 'sample' && parts.length >= 3) {
      return {
        kind: 'image',
        basePath: '/samples/',
        filename: decodeURIComponent(parts[2]!),
      }
    }

    if (parts[1] === 'uploads' && parts.length >= 3) {
      return {
        kind: 'image',
        basePath: '/uploads/',
        filename: decodeURIComponent(parts[2]!),
      }
    }

    if (parts[1] === 'source' && parts.length >= 4) {
      return {
        kind: 'image',
        basePath: decodeURIComponent(parts[2]!),
        filename: decodeURIComponent(parts[3]!),
      }
    }

    if (parts.length < 3) {
      return null
    }

    return {
      kind: 'image',
      basePath: decodeURIComponent(parts[1]!),
      filename: decodeURIComponent(parts[2]!),
    }
  } catch {
    return null
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const vp = useViewport()
  const [zoomLevel, setZoomLevel] = useState(1)
  const [canvasSize, setCanvasSize] = useState<[number, number]>([800, 600])
  const restoredRef = useRef(false)
  const [recentImages, setRecentImages] = useState<RecentImageRecord[]>([])
  const [recentImagesSort, setRecentImagesSort] = useState<RecentImagesSortMode>('last-edited')
  const [sampleImages, setSampleImages] = useState<ServerImageRecord[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingAnnotationImport, setPendingAnnotationImport] = useState<PendingAnnotationImport | null>(null)
  const sortedRecentImages = useMemo(
    () => sortRecentImages(recentImages, recentImagesSort),
    [recentImages, recentImagesSort],
  )

  const navigateHome = useCallback((replace = false) => {
    if (window.location.pathname === '/' && !window.location.search && !window.location.hash) return
    window.history[replace ? 'replaceState' : 'pushState']({}, '', '/')
  }, [])

  const navigateToImage = useCallback((basePath: string, filename: string, replace = false) => {
    if (!basePath) return
    const nextPath = buildImagePath(basePath, filename)
    if (`${window.location.pathname}${window.location.search}` === nextPath && !window.location.hash) return
    window.history[replace ? 'replaceState' : 'pushState']({}, '', nextPath)
  }, [])

  const canonicalizeImageRoute = useCallback((basePath: string, filename: string) => {
    const canonicalPath = buildImagePath(basePath, filename)
    if (`${window.location.pathname}${window.location.search}` !== canonicalPath) {
      window.history.replaceState({}, '', canonicalPath)
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      setZoomLevel(vp.getZoomLevel())
    }, 200)
    return () => clearInterval(interval)
  }, [vp])

  const restoreAnnotations = useCallback((filename: string, basePath: string) => {
    let saved = localStorage.getItem(annotationsStorageKey(filename, basePath))

    if (!saved) {
      const legacy = localStorage.getItem(legacyAnnotationsStorageKey(filename))
      if (legacy) {
        saved = legacy
        localStorage.setItem(annotationsStorageKey(filename, basePath), legacy)
        localStorage.removeItem(legacyAnnotationsStorageKey(filename))
      }
    }

    if (!saved) {
      const globalLegacy = localStorage.getItem('wsc:annotations')
      const legacyFilename = localStorage.getItem(LS_IMAGE_KEY)
      if (globalLegacy && legacyFilename === filename) {
        saved = globalLegacy
        localStorage.setItem(annotationsStorageKey(filename, basePath), globalLegacy)
        localStorage.removeItem('wsc:annotations')
      }
    }

    if (!saved) return

    try {
      dispatch({ type: 'LOAD_ANNOTATIONS', annotations: normalizeAnnotations(JSON.parse(saved)) })
    } catch {
      setNotice('Saved annotations could not be restored for this image.')
    }
  }, [])

  const loadImageFromUrl = useCallback(
    (
      url: string,
      filename: string,
      basePath: string,
      displayName?: string | null,
      historyMode: 'none' | 'push' | 'replace' = 'none',
    ) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        dispatch({
          type: 'LOAD_IMAGE',
          image: {
            filename,
            displayName: normalizeDisplayName(displayName, filename),
            width: image.width,
            height: image.height,
            element: image,
            basePath,
          },
        })
        restoreAnnotations(filename, basePath)
        setNotice(null)
        if (historyMode !== 'none') {
          navigateToImage(basePath, filename, historyMode === 'replace')
        }
      }
      image.onerror = () => {
        setNotice(`Could not open ${filename}.`)
      }
      image.src = url
    },
    [navigateToImage, restoreAnnotations],
  )

  const loadImageFromBlob = useCallback(
    (
      blob: Blob,
      filename: string,
      basePath: string,
      displayName?: string | null,
      message?: string,
      historyMode: 'none' | 'push' | 'replace' = 'none',
    ) => {
      const image = new Image()
      const url = URL.createObjectURL(blob)
      image.onload = () => {
        dispatch({
          type: 'LOAD_IMAGE',
          image: {
            filename,
            displayName: normalizeDisplayName(displayName, filename),
            width: image.width,
            height: image.height,
            element: image,
            basePath,
          },
        })
        if (basePath) {
          restoreAnnotations(filename, basePath)
        }
        setNotice(message ?? null)
        if (historyMode !== 'none' && basePath) {
          navigateToImage(basePath, filename, historyMode === 'replace')
        }
        URL.revokeObjectURL(url)
      }
      image.onerror = () => {
        setNotice(`Could not open ${filename}.`)
        URL.revokeObjectURL(url)
      }
      image.src = url
    },
    [navigateToImage, restoreAnnotations],
  )

  const loadLocalImageFile = useCallback(
    (file: File, displayName?: string | null, message?: string, historyMode: 'none' | 'push' | 'replace' = 'none') => {
      const image = new Image()
      const url = URL.createObjectURL(file)
      image.onload = () => {
        dispatch({
          type: 'LOAD_IMAGE',
          image: {
            filename: file.name,
            displayName: normalizeDisplayName(displayName, file.name),
            width: image.width,
            height: image.height,
            element: image,
            basePath: '',
          },
        })
        setNotice(message ?? null)
        if (historyMode !== 'none') {
          navigateHome(historyMode === 'replace')
        }
        URL.revokeObjectURL(url)
      }
      image.onerror = () => {
        setNotice(`Could not open ${file.name}.`)
        URL.revokeObjectURL(url)
      }
      image.src = url
    },
    [navigateHome],
  )

  const pendingSaveRef = useRef<PendingSave | null>(null)

  const flushAnnotationSave = useCallback(() => {
    const pending = pendingSaveRef.current
    if (!pending) return

    if (!pending.basePath) {
      localStorage.removeItem(LS_IMAGE_KEY)
      localStorage.removeItem(LS_IMAGE_BASE_KEY)
      localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
      return
    }

    const storageKey = annotationsStorageKey(pending.filename, pending.basePath)
    const serializedAnnotations = JSON.stringify(pending.annotations)
    const existingSavedAnnotations = localStorage.getItem(storageKey)
    const existingRecord = readRecentImages().find(
      (record) => record.filename === pending.filename && record.basePath === pending.basePath,
    )
    const isUntouchedBrowserUpload =
      isBrowserImageBasePath(pending.basePath) &&
      existingRecord === undefined &&
      existingSavedAnnotations === null &&
      pending.annotations.length === 0 &&
      normalizeDisplayName(pending.displayName, pending.filename) === null

    if (isUntouchedBrowserUpload) {
      return
    }

    localStorage.setItem(LS_IMAGE_KEY, pending.filename)
    localStorage.setItem(LS_IMAGE_BASE_KEY, pending.basePath)
    if (pending.displayName) {
      localStorage.setItem(LS_IMAGE_DISPLAY_NAME_KEY, pending.displayName)
    } else {
      localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
    }

    const metadataChanged =
      existingRecord?.displayName !== pending.displayName ||
      existingRecord?.width !== pending.width ||
      existingRecord?.height !== pending.height
    const annotationsChanged = !storedAnnotationsMatch(existingSavedAnnotations, serializedAnnotations)
    const lastEditedAt =
      !existingRecord || annotationsChanged || metadataChanged ? new Date().toISOString() : existingRecord.lastEditedAt

    localStorage.setItem(storageKey, serializedAnnotations)

    const summary = summarizeAnnotations(pending.annotations)
    // Per-class counts come from the category table, so a new class needs no edit here.
    const categoryCounts = {} as Record<CategorySummaryKey, number>
    for (const option of ELK_CATEGORY_OPTIONS) categoryCounts[option.summaryKey] = summary[option.summaryKey]

    setRecentImages(
      upsertRecentImage({
        ...categoryCounts,
        id: `${pending.basePath}|${pending.filename}`,
        filename: pending.filename,
        displayName: pending.displayName,
        basePath: pending.basePath,
        width: pending.width,
        height: pending.height,
        lastEditedAt,
        counted: summary.counted,
        ignored: summary.ignored,
      }),
    )
  }, [])

  useEffect(() => {
    if (!state.image) return
    pendingSaveRef.current = {
      filename: state.image.filename,
      displayName: state.image.displayName,
      basePath: state.image.basePath,
      width: state.image.width,
      height: state.image.height,
      annotations: state.annotations,
    }
    const timer = setTimeout(flushAnnotationSave, 500)
    return () => clearTimeout(timer)
  }, [state.image, state.annotations, flushAnnotationSave])

  useEffect(() => {
    if (state.image === null) {
      pendingSaveRef.current = null
    }
  }, [state.image])

  useEffect(() => {
    localStorage.setItem(LS_ACTIVE_CATEGORY_KEY, state.activeCategory)
  }, [state.activeCategory])

  useEffect(() => {
    localStorage.setItem(LS_BBOX_CREATION_KEY, state.bboxCreationEnabled ? 'true' : 'false')
  }, [state.bboxCreationEnabled])

  useEffect(() => {
    localStorage.setItem(LS_MARKER_VISIBILITY_KEY, state.markerVisibility)
  }, [state.markerVisibility])

  useEffect(() => {
    localStorage.setItem(LS_ZOOM_SPEED_KEY, String(state.zoomSpeed))
    vp.zoomSpeed.current = state.zoomSpeed
  }, [state.zoomSpeed, vp])

  useEffect(() => {
    localStorage.setItem(LS_RECENT_IMAGES_SORT_KEY, recentImagesSort)
  }, [recentImagesSort])

  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true

    setRecentImages(readRecentImages())

    const savedRecentSort = localStorage.getItem(LS_RECENT_IMAGES_SORT_KEY)
    if (savedRecentSort === 'last-edited' || savedRecentSort === 'alphabetical') {
      setRecentImagesSort(savedRecentSort)
    }

    if (SHOW_DEV_SAMPLES) {
      fetch('/api/images')
        .then((response) => response.json())
        .then((images: ServerImageRecord[]) => {
          setSampleImages(images.filter((image) => image.source === 'sample'))
        })
        .catch(() => {})
    }

    const savedCategory = localStorage.getItem(LS_ACTIVE_CATEGORY_KEY)
    if (isAnnotationCategory(savedCategory)) {
      dispatch({ type: 'SET_ACTIVE_CATEGORY', category: savedCategory })
    }

    const savedBboxCreation = localStorage.getItem(LS_BBOX_CREATION_KEY)
    if (savedBboxCreation === 'true') {
      dispatch({ type: 'TOGGLE_BBOX_CREATION' })
    }

    const savedMarkerVisibility = localStorage.getItem(LS_MARKER_VISIBILITY_KEY)
    if (
      savedMarkerVisibility === 'visible' ||
      savedMarkerVisibility === 'dimmed' ||
      savedMarkerVisibility === 'hidden'
    ) {
      dispatch({ type: 'SET_MARKER_VISIBILITY', visibility: savedMarkerVisibility })
    }

    const savedZoomSpeed = localStorage.getItem(LS_ZOOM_SPEED_KEY)
    if (savedZoomSpeed) {
      const speed = Number.parseFloat(savedZoomSpeed)
      if (Number.isFinite(speed) && speed >= 0.25 && speed <= 4) {
        dispatch({ type: 'SET_ZOOM_SPEED', speed })
        vp.zoomSpeed.current = speed
      }
    }

    const redirectedPath = new URLSearchParams(window.location.search).get('p')
    if (redirectedPath) {
      try {
        const redirectUrl = new URL(redirectedPath, window.location.origin)
        window.history.replaceState({}, '', `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`)
      } catch {}
    }

    const route = parseImagePath(window.location.pathname, window.location.search)
    if (!route || route.kind === 'home') {
      if (!route) {
        navigateHome(true)
        setNotice('Image not found. Choose an image from Recent Work or open a new one.')
      }
      return
    }

    if (route.kind === 'local-image') {
      const matchingRecent = readRecentImages().find((record) => record.basePath === route.basePath)
      void getBrowserImageFromBasePath(route.basePath)
        .then((file) => {
          if (!file) {
            navigateHome(true)
            setNotice('That saved image is no longer available in this browser.')
            return
          }
          loadImageFromBlob(file, file.name, route.basePath, matchingRecent?.displayName)
        })
        .catch(() => {
          navigateHome(true)
          setNotice('That saved image is no longer available in this browser.')
        })
      return
    }

    const matchingRecent = readRecentImages().find(
      (record) => record.filename === route.filename && record.basePath === route.basePath,
    )

    canonicalizeImageRoute(route.basePath, route.filename)
    loadImageFromUrl(`${route.basePath}${route.filename}`, route.filename, route.basePath, matchingRecent?.displayName)
  }, [canonicalizeImageRoute, loadImageFromBlob, loadImageFromUrl, navigateHome, vp])

  const openImageFile = useCallback(
    async (file: File) => {
      flushAnnotationSave()

      let sanitizedFile = file
      try {
        sanitizedFile = await stripImageMetadata(file)
      } catch {
        sanitizedFile = file
      }

      try {
        const { basePath } = await saveBrowserImage(sanitizedFile)
        loadImageFromBlob(sanitizedFile, sanitizedFile.name, basePath, null, undefined, 'push')
      } catch {
        loadLocalImageFile(
          sanitizedFile,
          null,
          'Browser storage is unavailable, so this image is open only in the current browser tab.',
          'push',
        )
      }
    },
    [flushAnnotationSave, loadImageFromBlob, loadLocalImageFile],
  )

  const loadAnnotationsFile = useCallback(
    async (file: File, options?: { skipConfirm?: boolean }) => {
      if (!state.image) {
        setNotice('Open an image before importing annotations JSON.')
        return
      }

      if (!options?.skipConfirm && summarizeAnnotations(state.annotations).counted > 0) {
        setPendingAnnotationImport({ file })
        return
      }

      try {
        const parsed = JSON.parse(await file.text())
        dispatch({
          type: 'IMPORT_ANNOTATIONS',
          annotations: prepareImportedAnnotations(parsed.annotations ?? parsed),
        })
        setPendingAnnotationImport(null)
        setNotice(null)
      } catch {
        setNotice('Could not import that annotation JSON file.')
      }
    },
    [state.annotations, state.image],
  )

  useEffect(() => {
    function onPopState() {
      flushAnnotationSave()
      const route = parseImagePath(window.location.pathname, window.location.search)

      if (!route || route.kind === 'home') {
        dispatch({ type: 'RESET_WORKSPACE' })
        if (!route) {
          navigateHome(true)
          setNotice('Image not found. Choose an image from Recent Work or open a new one.')
        } else {
          setNotice(null)
        }
        return
      }

      if (route.kind === 'local-image') {
        const matchingRecent = readRecentImages().find((record) => record.basePath === route.basePath)
        void getBrowserImageFromBasePath(route.basePath)
          .then((file) => {
            if (!file) {
              navigateHome(true)
              setNotice('That saved image is no longer available in this browser.')
              dispatch({ type: 'RESET_WORKSPACE' })
              return
            }
            loadImageFromBlob(file, file.name, route.basePath, matchingRecent?.displayName)
          })
          .catch(() => {
            navigateHome(true)
            setNotice('That saved image is no longer available in this browser.')
            dispatch({ type: 'RESET_WORKSPACE' })
          })
        return
      }

      const matchingRecent = readRecentImages().find(
        (record) => record.filename === route.filename && record.basePath === route.basePath,
      )

      canonicalizeImageRoute(route.basePath, route.filename)
      loadImageFromUrl(
        `${route.basePath}${route.filename}`,
        route.filename,
        route.basePath,
        matchingRecent?.displayName,
      )
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [canonicalizeImageRoute, flushAnnotationSave, loadImageFromBlob, loadImageFromUrl, navigateHome])

  useEffect(() => {
    function onDragOver(event: DragEvent) {
      event.preventDefault()
    }

    function onDrop(event: DragEvent) {
      event.preventDefault()
      const file = event.dataTransfer?.files[0]
      if (!file) return

      if (file.type.startsWith('image/')) {
        void openImageFile(file)
        return
      }

      if (isJsonFile(file)) {
        void loadAnnotationsFile(file)
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [loadAnnotationsFile, openImageFile])

  const handleFitToWindow = useCallback(() => {
    if (state.image) {
      vp.fitToWindow(state.image.width, state.image.height, canvasSize[0], canvasSize[1])
    }
  }, [canvasSize, state.image, vp])

  const handleCanvasSize = useCallback((width: number, height: number) => {
    setCanvasSize([width, height])
  }, [])

  const handleOpenRecent = useCallback(
    async (record: RecentImageRecord) => {
      flushAnnotationSave()

      if (isBrowserImageBasePath(record.basePath)) {
        try {
          const file = await getBrowserImageFromBasePath(record.basePath)
          if (!file) {
            setNotice(`Could not reopen ${displayNameFor(record)}. It is no longer available in browser storage.`)
            return
          }
          loadImageFromBlob(file, record.filename, record.basePath, record.displayName, undefined, 'push')
        } catch {
          setNotice(`Could not reopen ${displayNameFor(record)}.`)
        }
        return
      }

      loadImageFromUrl(
        `${record.basePath}${record.filename}`,
        record.filename,
        record.basePath,
        record.displayName,
        'push',
      )
    },
    [flushAnnotationSave, loadImageFromBlob, loadImageFromUrl],
  )

  const handleOpenSample = useCallback(
    (record: ServerImageRecord) => {
      flushAnnotationSave()
      loadImageFromUrl(record.url, record.filename, record.basePath, null, 'push')
    },
    [flushAnnotationSave, loadImageFromUrl],
  )

  const handleGoHome = useCallback(() => {
    flushAnnotationSave()
    localStorage.removeItem(LS_IMAGE_KEY)
    localStorage.removeItem(LS_IMAGE_BASE_KEY)
    localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
    setNotice(null)
    dispatch({ type: 'RESET_WORKSPACE' })
    navigateHome()
  }, [flushAnnotationSave, navigateHome])

  const handleExportResults = useCallback(async () => {
    if (!state.image) return
    try {
      await exportResults(state.image, state.annotations)
    } catch {
      setNotice('Could not export the review files.')
    }
  }, [state.annotations, state.image])

  const handleExportAnnotatedImage = useCallback(async () => {
    if (!state.image) return
    try {
      await exportAnnotatedImage(state.image, state.annotations)
    } catch {
      setNotice('Could not export the annotated image.')
    }
  }, [state.annotations, state.image])

  const handleExportOriginalImage = useCallback(async () => {
    if (!state.image) return
    try {
      await exportOriginalImage(state.image)
    } catch {
      setNotice('Could not export the original image.')
    }
  }, [state.image])

  const handleExportJsonOnly = useCallback(() => {
    if (!state.image) return
    try {
      exportJsonOnly(state.image, state.annotations)
    } catch {
      setNotice('Could not export the JSON file.')
    }
  }, [state.annotations, state.image])

  const handleExportAllJson = useCallback(() => {
    try {
      const images = sortedRecentImages.flatMap((record) => {
        const saved = localStorage.getItem(annotationsStorageKey(record.filename, record.basePath))
        if (!saved) return []

        return [
          {
            filename: record.filename,
            displayName: record.displayName,
            width: record.width,
            height: record.height,
            annotations: normalizeAnnotations(JSON.parse(saved)),
          },
        ]
      })

      if (images.length === 0) {
        setNotice('No saved annotations were found to export.')
        return
      }

      exportCombinedJsonOnly(images)
    } catch {
      setNotice('Could not export the saved JSON files.')
    }
  }, [sortedRecentImages])

  const handleExportRecent = useCallback(async (record: RecentImageRecord) => {
    try {
      const saved = localStorage.getItem(annotationsStorageKey(record.filename, record.basePath))
      if (!saved) {
        setNotice(`No saved annotations were found for ${displayNameFor(record)}.`)
        return
      }

      const annotations = normalizeAnnotations(JSON.parse(saved))
      if (isBrowserImageBasePath(record.basePath)) {
        const file = await getBrowserImageFromBasePath(record.basePath)
        if (!file) {
          setNotice(`Could not export ${displayNameFor(record)}. The saved image is no longer available.`)
          return
        }

        await exportResultsFromBlob(
          file,
          record.filename,
          record.displayName,
          record.width,
          record.height,
          annotations,
        )
        return
      }

      await exportResultsFromUrl(
        `${record.basePath}${record.filename}`,
        record.filename,
        record.displayName,
        record.width,
        record.height,
        annotations,
      )
    } catch {
      setNotice(`Could not export ${displayNameFor(record)}.`)
    }
  }, [])

  const handleDeleteRecent = useCallback(async (record: RecentImageRecord) => {
    localStorage.removeItem(annotationsStorageKey(record.filename, record.basePath))

    const savedFilename = localStorage.getItem(LS_IMAGE_KEY)
    const savedBasePath = localStorage.getItem(LS_IMAGE_BASE_KEY)
    if (savedFilename === record.filename && savedBasePath === record.basePath) {
      localStorage.removeItem(LS_IMAGE_KEY)
      localStorage.removeItem(LS_IMAGE_BASE_KEY)
      localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
    }

    if (isBrowserImageBasePath(record.basePath)) {
      try {
        await deleteBrowserImageFromBasePath(record.basePath)
      } catch {
        setNotice(`Removed ${displayNameFor(record)} from the list, but could not clear its saved browser image.`)
      }
    }

    setRecentImages(removeRecentImage(record.id))
  }, [])

  const handleRenameRecent = useCallback(
    (record: RecentImageRecord, nextName: string | null) => {
      const displayName = normalizeDisplayName(nextName, record.filename)
      setRecentImages(
        upsertRecentImage({
          ...record,
          displayName,
          lastEditedAt: new Date().toISOString(),
        }),
      )

      if (state.image?.filename === record.filename && state.image.basePath === record.basePath) {
        dispatch({ type: 'RENAME_IMAGE', displayName })
        if (displayName) {
          localStorage.setItem(LS_IMAGE_DISPLAY_NAME_KEY, displayName)
        } else {
          localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
        }
      }
    },
    [state.image],
  )

  const handleRenameImage = useCallback(
    (nextName: string | null) => {
      if (!state.image) return
      dispatch({
        type: 'RENAME_IMAGE',
        displayName: normalizeDisplayName(nextName, state.image.filename),
      })
    },
    [state.image],
  )

  return (
    <AppStateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <div className="h-full w-full bg-background text-foreground">
          <div className="flex h-full flex-col">
            <Toolbar
              currentDisplayName={state.image ? displayNameFor(state.image) : undefined}
              currentFilename={state.image?.filename}
              recentImages={sortedRecentImages}
              sampleImages={sampleImages}
              onExportAllJson={handleExportAllJson}
              onExportAnnotatedImage={handleExportAnnotatedImage}
              onExportJsonOnly={handleExportJsonOnly}
              onExportOriginalImage={handleExportOriginalImage}
              onExportResults={handleExportResults}
              onFitToWindow={handleFitToWindow}
              onGoHome={handleGoHome}
              onOpenImageFile={openImageFile}
              onOpenAnnotationsFile={(file) => loadAnnotationsFile(file)}
              onOpenRecentImage={handleOpenRecent}
              onRenameImage={handleRenameImage}
              onOpenSampleImage={handleOpenSample}
            />

            {notice && <NoticeBanner message={notice} onDismiss={() => setNotice(null)} />}
            {state.image && (
              <WorkspaceHint
                canRemove={state.selectedIds.size > 0}
                canUndo={state.undoStack.length > 0}
                canRedo={state.redoStack.length > 0}
                onRemove={() => dispatch({ type: 'DELETE_OR_REJECT', ids: [...state.selectedIds] })}
                onUndo={() => dispatch({ type: 'UNDO' })}
                onRedo={() => dispatch({ type: 'REDO' })}
              />
            )}

            <div className="relative flex min-h-0 flex-1">
              {state.image ? (
                <div className="relative flex-1">
                  <ImageToolOverlays />
                  <MarkerVisibilityControl />
                  <Canvas vp={vp} onCanvasSize={handleCanvasSize} />
                  <Minimap vp={vp} canvasWidth={canvasSize[0]} canvasHeight={canvasSize[1]} zoomLevel={zoomLevel} />
                </div>
              ) : (
                <WelcomeScreen
                  notice={notice}
                  recentImages={sortedRecentImages}
                  recentImagesSort={recentImagesSort}
                  sampleImages={sampleImages}
                  onChangeRecentImagesSort={setRecentImagesSort}
                  onExportAllJson={handleExportAllJson}
                  onExportRecent={handleExportRecent}
                  onDeleteRecentImage={handleDeleteRecent}
                  onOpenImageFile={openImageFile}
                  onOpenRecentImage={handleOpenRecent}
                  onRenameRecentImage={handleRenameRecent}
                  onOpenSampleImage={handleOpenSample}
                />
              )}
            </div>

            <StatusBar
              onExportAnnotatedImage={handleExportAnnotatedImage}
              onExportJsonOnly={handleExportJsonOnly}
              onExportOriginalImage={handleExportOriginalImage}
              onExportResults={handleExportResults}
            />
            <HelpOverlay />
          </div>
        </div>

        <Dialog
          open={pendingAnnotationImport !== null}
          onOpenChange={(open) => {
            if (!open) setPendingAnnotationImport(null)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Replace current annotations?</DialogTitle>
              <DialogDescription>
                {pendingAnnotationImport
                  ? `Importing ${pendingAnnotationImport.file.name} will replace the current annotations for this image. You can undo this after importing.`
                  : ''}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingAnnotationImport(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!pendingAnnotationImport) return
                  void loadAnnotationsFile(pendingAnnotationImport.file, { skipConfirm: true })
                }}
              >
                Replace Annotations
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DispatchContext.Provider>
    </AppStateContext.Provider>
  )
}

function NoticeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="border-b border-border bg-card px-3 py-2 text-sm text-foreground">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <span>{message}</span>
        <Button variant="ghost" size="xs" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

function WorkspaceHint({
  canRemove,
  canUndo,
  canRedo,
  onRemove,
  onUndo,
  onRedo,
}: {
  canRemove: boolean
  canUndo: boolean
  canRedo: boolean
  onRemove: () => void
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div className="border-b border-border bg-card/60 px-3 py-1.5 text-sm text-muted-foreground sm:py-2">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <span className="hidden flex-wrap items-center gap-x-1.5 gap-y-1 text-xs sm:flex">
          <span>Drag empty space to pan</span>
          <span aria-hidden="true">·</span>
          <ShortcutSequence shortcut={isMac ? `${platformModifier}+Scroll` : 'Scroll'} compact />
          <span>to zoom</span>
          <span aria-hidden="true">·</span>
          <ShortcutKey shortcut="?" compact />
          <span>for help</span>
        </span>

        <div className="flex w-full items-center gap-1.5 sm:w-auto sm:gap-2">
          <WorkspaceEditButton
            disabled={!canRemove}
            icon={Trash2Icon}
            label="Remove"
            shortcut="Delete"
            onClick={onRemove}
          />
          <WorkspaceEditButton
            disabled={!canUndo}
            icon={Undo2Icon}
            label="Undo"
            shortcut={`${platformModifier}+Z`}
            onClick={onUndo}
          />
          <WorkspaceEditButton
            disabled={!canRedo}
            icon={Redo2Icon}
            label="Redo"
            shortcut={`${platformModifier}+Shift+Z`}
            onClick={onRedo}
          />
        </div>
      </div>
    </div>
  )
}

function WorkspaceEditButton({
  disabled,
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  disabled: boolean
  icon: ComponentType<{ className?: string }>
  label: string
  shortcut: string
  onClick: () => void
}) {
  return (
    <Button variant="outline" size="sm" disabled={disabled} onClick={onClick} className="flex-1 gap-2 sm:flex-none">
      <Icon className="size-3.5" />
      <span>{label}</span>
      {shortcut.includes('+') ? (
        <ShortcutSequence shortcut={shortcut} compact />
      ) : (
        <ShortcutKey shortcut={shortcut} compact />
      )}
    </Button>
  )
}
