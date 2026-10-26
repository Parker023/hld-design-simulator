import type { Experiment } from '../engine/analysis'
import type { CapacityInputs } from '../engine/calculator'
import type { Design, SimSettings, Workload } from '../engine/types'

export interface Notes {
  requirements: string
  api: string
  dataModel: string
  tradeoffs: string
}

export interface EstimateAttempt {
  guess: string
  revealed: boolean
  verdict?: string
}

export interface Progress {
  notes: Notes
  estimates: Record<string, EstimateAttempt>
  hintsUsed: number
  runs: number
  guideStep: number
  referenceRevealed: boolean
  bottleneckAnswer?: string
  compared: boolean
}

export interface SavedDesign {
  id: string
  name: string
  savedAt: number
  design: Design
  workload: Workload
}

export interface ChallengeState {
  design: Design
  workload: Workload
  settings: SimSettings
  capInputs: CapacityInputs
  experiments: Experiment[]
  savedDesigns: SavedDesign[]
  progress: Progress
}

/**
 * Persistence boundary. The app ships with a browser (localStorage) implementation so it
 * deploys as a static site. A server-backed implementation (e.g. a Vercel Function + Postgres)
 * can implement the same interface without touching the UI.
 */
export interface WorkspaceStore {
  loadChallenge(id: string): ChallengeState | null
  saveChallenge(id: string, s: ChallengeState): void
  loadPrefs(): Prefs
  savePrefs(p: Prefs): void
  exportAll(): string
  importAll(json: string): number
}

export interface Prefs {
  challengeId: string
  mode: 'guided' | 'lab'
}

const PREFIX = 'hld-sim:v1:'

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}

export const browserStore: WorkspaceStore = {
  loadChallenge(id) {
    const raw = safeGet(`${PREFIX}challenge:${id}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as ChallengeState
    } catch {
      return null
    }
  },
  saveChallenge(id, s) {
    safeSet(`${PREFIX}challenge:${id}`, JSON.stringify(s))
  },
  loadPrefs() {
    try {
      const raw = safeGet(`${PREFIX}prefs`)
      if (raw) return JSON.parse(raw) as Prefs
    } catch {
      /* ignore */
    }
    return { challengeId: 'url-shortener', mode: 'lab' }
  },
  savePrefs(p) {
    safeSet(`${PREFIX}prefs`, JSON.stringify(p))
  },
  exportAll() {
    const out: Record<string, unknown> = {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!
        if (k.startsWith(PREFIX)) out[k] = JSON.parse(localStorage.getItem(k)!)
      }
    } catch {
      /* ignore */
    }
    return JSON.stringify({ format: 'hld-sim-export', version: 1, data: out }, null, 2)
  },
  importAll(json) {
    const parsed = JSON.parse(json) as { format?: string; data?: Record<string, unknown> }
    if (parsed.format !== 'hld-sim-export' || !parsed.data) throw new Error('Not an HLD simulator export file')
    let n = 0
    for (const [k, v] of Object.entries(parsed.data)) {
      if (!k.startsWith(PREFIX)) continue
      safeSet(k, JSON.stringify(v))
      n++
    }
    return n
  },
}
