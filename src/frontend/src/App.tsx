import { Redo2Icon, Trash2Icon, Undo2Icon } from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './components/Canvas'
import DetectionPanel from './components/DetectionPanel'
import HelpOverlay from './components/HelpOverlay'
import ImageToolOverlays from './components/ImageToolOverlays'
import MarkerVisibilityControl from './components/MarkerVisibilityControl'
import Minimap from './components/Minimap'
import ShortcutKey, { ShortcutSequence } from './components/ShortcutKey'
import StatusBar from './components/StatusBar'
import Toolbar from './components/Toolbar'
import { Button } from './components/ui/button'
import WelcomeScreen from './components/WelcomeScreen'
import WorkflowPanel from './components/WorkflowPanel'
import { ENABLE_AUTOMATION, SHOW_DEV_SAMPLES } from './config'
import { useDetection } from './hooks/useDetection'
import { useViewport } from './hooks/useViewport'
import { normalizeAnnotations, summarizeAnnotations } from './lib/annotations'
import { getBrowserImageFromBasePath, isBrowserImageBasePath, saveBrowserImage } from './lib/browser-images'
import {
  exportAnnotatedImage,
  exportJsonOnly,
  exportOriginalImage,
  exportResults,
  exportResultsFromBlob,
  exportResultsFromUrl,
} from './lib/export'
import { displayNameFor, normalizeDisplayName } from './lib/image-names'
import { stripImageMetadata } from './lib/images'
import { readRecentImages, upsertRecentImage } from './lib/recent-images'
import {
  annotationsStorageKey,
  LS_ACTIVE_CATEGORY_KEY,
  LS_BBOX_CREATION_KEY,
  LS_IMAGE_BASE_KEY,
  LS_IMAGE_DISPLAY_NAME_KEY,
  LS_IMAGE_KEY,
  LS_MARKER_VISIBILITY_KEY,
  LS_ZOOM_SPEED_KEY,
  legacyAnnotationsStorageKey,
} from './lib/storage'
import { platformModifier } from './platform'
import { AppStateContext, DispatchContext, initialState, reducer } from './state'
import type { Annotation, RecentImageRecord, ServerImageRecord } from './types'

interface PendingSave {
  filename: string
  displayName: string | null
  basePath: string
  width: number
  height: number
  annotations: Annotation[]
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const vp = useViewport()
  const [zoomLevel, setZoomLevel] = useState(1)
  const [canvasSize, setCanvasSize] = useState<[number, number]>([800, 600])
  const restoredRef = useRef(false)
  const [showDetectionPanel, setShowDetectionPanel] = useState(false)
  const [recentImages, setRecentImages] = useState<RecentImageRecord[]>([])
  const [sampleImages, setSampleImages] = useState<ServerImageRecord[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const detection = useDetection()

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
    (url: string, filename: string, basePath: string, displayName?: string | null) => {
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
      }
      image.onerror = () => {
        setNotice(`Could not open ${filename}.`)
      }
      image.src = url
    },
    [restoreAnnotations],
  )

  const loadImageFromBlob = useCallback(
    (blob: Blob, filename: string, basePath: string, displayName?: string | null, message?: string) => {
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
        URL.revokeObjectURL(url)
      }
      image.onerror = () => {
        setNotice(`Could not open ${filename}.`)
        URL.revokeObjectURL(url)
      }
      image.src = url
    },
    [restoreAnnotations],
  )

  const loadLocalImageFile = useCallback((file: File, displayName?: string | null, message?: string) => {
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
      URL.revokeObjectURL(url)
    }
    image.onerror = () => {
      setNotice(`Could not open ${file.name}.`)
      URL.revokeObjectURL(url)
    }
    image.src = url
  }, [])

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

    localStorage.setItem(LS_IMAGE_KEY, pending.filename)
    localStorage.setItem(LS_IMAGE_BASE_KEY, pending.basePath)
    if (pending.displayName) {
      localStorage.setItem(LS_IMAGE_DISPLAY_NAME_KEY, pending.displayName)
    } else {
      localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
    }
    localStorage.setItem(
      annotationsStorageKey(pending.filename, pending.basePath),
      JSON.stringify(pending.annotations),
    )

    const summary = summarizeAnnotations(pending.annotations)
    setRecentImages(
      upsertRecentImage({
        id: `${pending.basePath}|${pending.filename}`,
        filename: pending.filename,
        displayName: pending.displayName,
        basePath: pending.basePath,
        width: pending.width,
        height: pending.height,
        lastOpenedAt: new Date().toISOString(),
        counted: summary.counted,
        ignored: summary.ignored,
        bulls: summary.bulls,
        spikes: summary.spikes,
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
    localStorage.setItem(LS_ACTIVE_CATEGORY_KEY, state.activeCategory ?? 'cow')
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
    if (restoredRef.current) return
    restoredRef.current = true

    setRecentImages(readRecentImages())

    if (SHOW_DEV_SAMPLES) {
      fetch('/api/images')
        .then((response) => response.json())
        .then((images: ServerImageRecord[]) => {
          setSampleImages(images.filter((image) => image.source === 'sample'))
        })
        .catch(() => {})
    }

    const savedCategory = localStorage.getItem(LS_ACTIVE_CATEGORY_KEY)
    if (savedCategory === 'bull' || savedCategory === 'spike') {
      dispatch({ type: 'SET_ACTIVE_CATEGORY', category: savedCategory })
    } else if (savedCategory === 'cow') {
      dispatch({ type: 'SET_ACTIVE_CATEGORY', category: null })
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

    const savedFilename = localStorage.getItem(LS_IMAGE_KEY)
    const savedBasePath = localStorage.getItem(LS_IMAGE_BASE_KEY) || '/samples/'
    const savedDisplayName = localStorage.getItem(LS_IMAGE_DISPLAY_NAME_KEY)
    if (!savedFilename) return

    if (isBrowserImageBasePath(savedBasePath)) {
      void getBrowserImageFromBasePath(savedBasePath)
        .then((file) => {
          if (!file) {
            localStorage.removeItem(LS_IMAGE_KEY)
            localStorage.removeItem(LS_IMAGE_BASE_KEY)
            localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
            return
          }
          loadImageFromBlob(file, savedFilename, savedBasePath, savedDisplayName)
        })
        .catch(() => {
          localStorage.removeItem(LS_IMAGE_KEY)
          localStorage.removeItem(LS_IMAGE_BASE_KEY)
          localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
        })
      return
    }

    loadImageFromUrl(`${savedBasePath}${savedFilename}`, savedFilename, savedBasePath, savedDisplayName)
  }, [loadImageFromBlob, loadImageFromUrl, vp])

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
        loadImageFromBlob(sanitizedFile, sanitizedFile.name, basePath)
      } catch {
        loadLocalImageFile(
          sanitizedFile,
          null,
          'Browser storage is unavailable, so this image is open only in the current browser tab.',
        )
      }
    },
    [flushAnnotationSave, loadImageFromBlob, loadLocalImageFile],
  )

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

      if (file.name.endsWith('.json')) {
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result))
            dispatch({
              type: 'LOAD_ANNOTATIONS',
              annotations: normalizeAnnotations(parsed.annotations || parsed),
            })
          } catch {
            setNotice('Could not import that annotation JSON file.')
          }
        }
        reader.readAsText(file)
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openImageFile])

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
          loadImageFromBlob(file, record.filename, record.basePath, record.displayName)
        } catch {
          setNotice(`Could not reopen ${displayNameFor(record)}.`)
        }
        return
      }

      loadImageFromUrl(`${record.basePath}${record.filename}`, record.filename, record.basePath, record.displayName)
    },
    [flushAnnotationSave, loadImageFromBlob, loadImageFromUrl],
  )

  const handleOpenSample = useCallback(
    (record: ServerImageRecord) => {
      flushAnnotationSave()
      loadImageFromUrl(record.url, record.filename, record.basePath)
    },
    [flushAnnotationSave, loadImageFromUrl],
  )

  const handleGoHome = useCallback(() => {
    flushAnnotationSave()
    localStorage.removeItem(LS_IMAGE_KEY)
    localStorage.removeItem(LS_IMAGE_BASE_KEY)
    localStorage.removeItem(LS_IMAGE_DISPLAY_NAME_KEY)
    detection.reset()
    setShowDetectionPanel(false)
    setNotice(null)
    dispatch({ type: 'RESET_WORKSPACE' })
  }, [detection, flushAnnotationSave])

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

  const handleAgentDetect = useCallback(() => {
    if (!ENABLE_AUTOMATION || !state.image?.filename) return
    setShowDetectionPanel(true)
    detection.detect(state.image.filename)
  }, [detection, state.image])

  const isDetecting = ENABLE_AUTOMATION && detection.state.status === 'running'

  useEffect(() => {
    if (!ENABLE_AUTOMATION) return
    if (detection.state.status === 'complete' && detection.state.annotations.length > 0) {
      dispatch({ type: 'LOAD_ANNOTATIONS', annotations: detection.state.annotations })
    }
  }, [detection.state.annotations, detection.state.status])

  return (
    <AppStateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <div className="h-full w-full bg-background text-foreground">
          <div className="flex h-full flex-col">
            <Toolbar
              automationEnabled={ENABLE_AUTOMATION}
              currentDisplayName={state.image ? displayNameFor(state.image) : undefined}
              currentFilename={state.image?.filename}
              detecting={isDetecting}
              recentImages={recentImages}
              sampleImages={sampleImages}
              onDetect={handleAgentDetect}
              onExportAnnotatedImage={handleExportAnnotatedImage}
              onExportJsonOnly={handleExportJsonOnly}
              onExportOriginalImage={handleExportOriginalImage}
              onExportResults={handleExportResults}
              onFitToWindow={handleFitToWindow}
              onGoHome={handleGoHome}
              onOpenImageFile={openImageFile}
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
                <>
                  <div className="relative flex-1">
                    <WorkflowPanel />
                    <ImageToolOverlays />
                    <MarkerVisibilityControl />
                    <Canvas vp={vp} onCanvasSize={handleCanvasSize} />
                    <Minimap vp={vp} canvasWidth={canvasSize[0]} canvasHeight={canvasSize[1]} zoomLevel={zoomLevel} />
                  </div>
                  {ENABLE_AUTOMATION && showDetectionPanel && (
                    <DetectionPanel
                      state={detection.state}
                      onClose={() => {
                        setShowDetectionPanel(false)
                        detection.reset()
                      }}
                    />
                  )}
                </>
              ) : (
                <WelcomeScreen
                  notice={notice}
                  recentImages={recentImages}
                  sampleImages={sampleImages}
                  onExportRecent={handleExportRecent}
                  onOpenImageFile={openImageFile}
                  onOpenRecentImage={handleOpenRecent}
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
      </DispatchContext.Provider>
    </AppStateContext.Provider>
  )
}

function NoticeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="border-b border-amber-900/40 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <span>{message}</span>
        <button type="button" onClick={onDismiss} className="text-xs uppercase tracking-[0.16em] text-amber-200/80">
          Dismiss
        </button>
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
    <div className="border-b border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <span>Drag a new image into the window at any time.</span>

        <div className="flex flex-wrap items-center gap-2">
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
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className="h-8 gap-2 rounded-lg border border-border/70 bg-background/35 px-2.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
    >
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
