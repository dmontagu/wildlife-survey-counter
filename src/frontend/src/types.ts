export type AnnotationState = 'auto-detected' | 'confirmed' | 'rejected' | 'manually-added'
export type AnnotationCategory = 'bull' | 'spike' | null

export type InteractionMode = 'select' | 'add'

export interface Annotation {
  id: number
  x: number
  y: number
  bbox: [number, number, number, number] | null
  detection_confidence: number | null
  classification_confidence: number | null
  source: string
  label: string
  category: AnnotationCategory
  state: AnnotationState
}

export interface ImageInfo {
  filename: string
  width: number
  height: number
  element: HTMLImageElement
  /** The image source identifier (for example '/samples/' or a synthetic browser-image:// id). */
  basePath: string
}

export interface AppState {
  image: ImageInfo | null
  annotations: Annotation[]
  selectedIds: Set<number>
  activeCategory: AnnotationCategory
  confidenceThreshold: number
  showBboxes: boolean
  bboxCreationEnabled: boolean
  showNumbers: boolean
  showRejected: boolean
  helpVisible: boolean
  interactionMode: InteractionMode
  zoomSpeed: number
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
}

export interface AnnotationSummary {
  counted: number
  ignored: number
  bulls: number
  spikes: number
}

export interface RecentImageRecord {
  id: string
  filename: string
  basePath: string
  width: number
  height: number
  lastOpenedAt: string
  counted: number
  ignored: number
  bulls: number
  spikes: number
}

export interface ServerImageRecord {
  filename: string
  basePath: string
  source: 'sample' | 'upload'
  url: string
}

export interface UndoEntry {
  description: string
  patches: AnnotationPatch[]
}

export interface AnnotationPatch {
  id: number
  before: Partial<Annotation> | null // null = annotation didn't exist (was added)
  after: Partial<Annotation> | null // null = annotation was removed
}

export type Action =
  | { type: 'LOAD_IMAGE'; image: ImageInfo }
  | { type: 'LOAD_ANNOTATIONS'; annotations: Annotation[] }
  | { type: 'CONFIRM'; ids: number[] }
  | { type: 'REJECT'; ids: number[] }
  | { type: 'ADD_ANNOTATION'; annotation: Annotation }
  | { type: 'DELETE_ANNOTATION'; id: number }
  | { type: 'MOVE_ANNOTATION'; id: number; x: number; y: number }
  | { type: 'RESIZE_BBOX'; id: number; bbox: [number, number, number, number] }
  | { type: 'SET_CATEGORY'; ids: number[]; category: AnnotationCategory }
  | { type: 'DELETE_OR_REJECT'; ids: number[] }
  | { type: 'SELECT'; ids: number[]; append?: boolean }
  | { type: 'DESELECT_ALL' }
  | { type: 'SELECT_ALL_VISIBLE' }
  | { type: 'SET_THRESHOLD'; threshold: number }
  | { type: 'COMMIT_THRESHOLD' }
  | { type: 'TOGGLE_BBOXES' }
  | { type: 'TOGGLE_BBOX_CREATION' }
  | { type: 'TOGGLE_NUMBERS' }
  | { type: 'TOGGLE_REJECTED' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'TOGGLE_HELP' }
  | { type: 'TOGGLE_INTERACTION_MODE' }
  | { type: 'SET_INTERACTION_MODE'; mode: InteractionMode }
  | { type: 'SET_ACTIVE_CATEGORY'; category: AnnotationCategory }
  | { type: 'SET_ZOOM_SPEED'; speed: number }
  | { type: 'RESET_WORKSPACE' }
