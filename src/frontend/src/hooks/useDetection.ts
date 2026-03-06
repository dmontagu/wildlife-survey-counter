import { useCallback, useRef, useState } from 'react'
import type { Annotation } from '../types'

export interface DetectionStep {
  type: 'text' | 'tool_call' | 'tool_result' | 'annotations' | 'error'
  title: string
  detail?: string
  status: 'running' | 'done' | 'error'
}

export interface DetectionState {
  status: 'idle' | 'running' | 'complete' | 'error'
  steps: DetectionStep[]
  annotations: Annotation[]
  error: string | null
  runId: string | null
}

const INITIAL_STATE: DetectionState = {
  status: 'idle',
  steps: [],
  annotations: [],
  error: null,
  runId: null,
}

export function useDetection() {
  const [state, setState] = useState<DetectionState>(INITIAL_STATE)
  const abortRef = useRef<AbortController | null>(null)

  const detect = useCallback(async (filename: string) => {
    // Abort any in-progress detection
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState({
      status: 'running',
      steps: [{ type: 'text', title: 'Starting detection...', status: 'running' }],
      annotations: [],
      error: null,
      runId: null,
    })

    try {
      const response = await fetch(`/api/agent-detect/${encodeURIComponent(filename)}`, {
        method: 'POST',
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            try {
              const data = JSON.parse(dataStr)
              processEvent(currentEvent, data, setState)
            } catch {
              // Ignore malformed JSON
            }
            currentEvent = ''
          }
          // Blank lines are event separators — handled implicitly
        }
      }

      // If we finished without a 'complete' or 'error' event, mark complete
      setState((prev) => {
        if (prev.status === 'running') {
          return { ...prev, status: 'complete' }
        }
        return prev
      })
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : 'Detection failed'
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: message,
        steps: [...prev.steps, { type: 'error', title: message, status: 'error' }],
      }))
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState(INITIAL_STATE)
  }, [])

  return { state, detect, reset }
}

function processEvent(
  event: string,
  data: Record<string, unknown>,
  setState: React.Dispatch<React.SetStateAction<DetectionState>>,
) {
  switch (event) {
    case 'start':
      setState((prev) => ({
        ...prev,
        runId: data.run_id as string,
        steps: [{ type: 'text', title: 'Analyzing image...', status: 'running' }],
      }))
      break

    case 'text':
      setState((prev) => {
        // Mark previous running steps as done
        const steps = prev.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
        return {
          ...prev,
          steps: [...steps, { type: 'text', title: data.text as string, status: 'done' }],
        }
      })
      break

    case 'tool_call':
      setState((prev) => {
        const steps = prev.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
        return {
          ...prev,
          steps: [
            ...steps,
            {
              type: 'tool_call',
              title: data.description as string,
              detail: data.tool as string,
              status: 'running',
            },
          ],
        }
      })
      break

    case 'tool_result':
      setState((prev) => {
        const steps = prev.steps.map((s) =>
          s.status === 'running' && s.type === 'tool_call' ? { ...s, status: 'done' as const } : s,
        )
        return { ...prev, steps }
      })
      break

    case 'annotations': {
      const rawAnnotations = data.annotations as Annotation[]
      setState((prev) => {
        const steps = prev.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
        return {
          ...prev,
          annotations: rawAnnotations,
          steps: [
            ...steps,
            {
              type: 'annotations',
              title: `${rawAnnotations.length} animals detected`,
              detail: data.method_summary as string,
              status: 'done',
            },
          ],
        }
      })
      break
    }

    case 'complete':
      setState((prev) => {
        const steps = prev.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s))
        return { ...prev, status: 'complete', steps }
      })
      break

    case 'error':
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: data.message as string,
        steps: [
          ...prev.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' as const } : s)),
          { type: 'error', title: data.message as string, status: 'error' },
        ],
      }))
      break
  }
}
