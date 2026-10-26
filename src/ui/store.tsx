import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CHALLENGES, blankDesign, type Challenge } from '../data/challenges'
import { DEFAULT_CAPACITY_INPUTS } from '../engine/calculator'
import { DEFAULT_SETTINGS, simulate } from '../engine/simulate'
import type { Experiment } from '../engine/analysis'
import type { Design, SimResult } from '../engine/types'
import { supportsHardware } from '../engine/hardware'
import { browserStore, type ChallengeState, type Prefs } from './storage'

export type BottomTab = 'brief' | 'calculator' | 'timeline' | 'logs' | 'experiments' | 'review'
export type LeftTab = 'guide' | 'challenges' | 'components'

const store = browserStore

export function freshState(ch: Challenge): ChallengeState {
  return {
    design: blankDesign(),
    workload: { ...ch.workload },
    settings: { ...DEFAULT_SETTINGS },
    capInputs: { ...DEFAULT_CAPACITY_INPUTS },
    experiments: [],
    savedDesigns: [],
    progress: {
      notes: { requirements: '', api: '', dataModel: '', tradeoffs: '' },
      estimates: {},
      hintsUsed: 0,
      runs: 0,
      guideStep: 0,
      referenceRevealed: false,
      compared: false,
    },
  }
}

/**
 * Designs saved before hardware sizing existed typed throughput numbers directly.
 * Keep them exactly as they were by marking those components as manual sizing.
 */
function migrateDesign(d: Design): Design {
  return {
    ...d,
    nodes: d.nodes.map((n) => (supportsHardware(n.kind) && !('sizing' in n.config) ? { ...n, config: { ...n.config, sizing: 'manual' } } : n)),
  }
}

function loadState(ch: Challenge): ChallengeState {
  const saved = store.loadChallenge(ch.id)
  if (!saved) return freshState(ch)
  const base = freshState(ch)
  return {
    ...base,
    ...saved,
    design: migrateDesign(saved.design),
    savedDesigns: (saved.savedDesigns ?? []).map((x) => ({ ...x, design: migrateDesign(x.design) })),
    experiments: (saved.experiments ?? []).map((x) => ({ ...x, design: migrateDesign(x.design) })),
    progress: { ...base.progress, ...saved.progress },
    capInputs: { ...base.capInputs, ...saved.capInputs },
  }
}

interface WS {
  challenge: Challenge
  setChallengeId: (id: string) => void
  mode: Prefs['mode']
  setMode: (m: Prefs['mode']) => void
  state: ChallengeState
  update: (fn: (s: ChallengeState) => ChallengeState) => void
  result: SimResult
  hasRun: boolean
  playing: boolean
  tick: number
  setTick: (t: number) => void
  speed: number
  setSpeed: (n: number) => void
  run: () => void
  pause: () => void
  reset: () => void
  selected: string | null
  setSelected: (id: string | null) => void
  bottomTab: BottomTab
  setBottomTab: (t: BottomTab) => void
  leftTab: LeftTab
  setLeftTab: (t: LeftTab) => void
  saveExperiment: (name?: string) => Experiment
  compare: [string | null, string | null]
  setCompare: (c: [string | null, string | null]) => void
  toast: string | null
  notify: (msg: string) => void
  storeApi: typeof store
}

const Ctx = createContext<WS | null>(null)
export const useWS = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWS outside provider')
  return v
}

export const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const prefs = useMemo(() => store.loadPrefs(), [])
  const [challengeId, setChallengeIdRaw] = useState(CHALLENGES.some((c) => c.id === prefs.challengeId) ? prefs.challengeId : CHALLENGES[0].id)
  const challenge = CHALLENGES.find((c) => c.id === challengeId)!
  const [mode, setModeRaw] = useState<Prefs['mode']>(prefs.mode)
  const [state, setState] = useState<ChallengeState>(() => loadState(challenge))
  const [hasRun, setHasRun] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [tick, setTick] = useState(0)
  const [speed, setSpeed] = useState(4)
  const [selected, setSelected] = useState<string | null>(null)
  const [bottomTab, setBottomTab] = useState<BottomTab>('brief')
  const [leftTab, setLeftTab] = useState<LeftTab>(prefs.mode === 'guided' ? 'guide' : 'components')
  const [compare, setCompare] = useState<[string | null, string | null]>([null, null])
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const update = useCallback((fn: (s: ChallengeState) => ChallengeState) => setState((s) => fn(s)), [])

  // Persist (debounced) on every change.
  useEffect(() => {
    const h = window.setTimeout(() => store.saveChallenge(challengeId, state), 300)
    return () => window.clearTimeout(h)
  }, [state, challengeId])

  useEffect(() => store.savePrefs({ challengeId, mode }), [challengeId, mode])

  const setChallengeId = useCallback(
    (id: string) => {
      store.saveChallenge(challengeId, state)
      const ch = CHALLENGES.find((c) => c.id === id)!
      setChallengeIdRaw(id)
      setState(loadState(ch))
      setHasRun(false)
      setPlaying(false)
      setTick(0)
      setSelected(null)
      setCompare([null, null])
      setBottomTab('brief')
    },
    [challengeId, state],
  )

  const setMode = useCallback((m: Prefs['mode']) => {
    setModeRaw(m)
    setLeftTab(m === 'guided' ? 'guide' : 'components')
  }, [])

  // Simulation recomputes whenever anything that affects it changes (positions excluded).
  const simKey = JSON.stringify({
    n: state.design.nodes.map((n) => [n.id, n.kind, n.label, n.config]),
    e: state.design.edges.map((e) => [e.source, e.target]),
    w: state.workload,
    s: state.settings,
  })
  const result = useMemo(
    () => simulate(state.design, state.workload, state.settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [simKey],
  )

  useEffect(() => {
    if (!playing) return
    const h = window.setInterval(() => {
      setTick((t) => {
        if (t >= result.ticks.length - 1) {
          setPlaying(false)
          return t
        }
        return t + 1
      })
    }, 1000 / speed)
    return () => window.clearInterval(h)
  }, [playing, speed, result.ticks.length])

  useEffect(() => {
    if (tick > result.ticks.length - 1) setTick(Math.max(0, result.ticks.length - 1))
  }, [result.ticks.length, tick])

  const run = useCallback(() => {
    if (!hasRun || tick >= result.ticks.length - 1) {
      setTick(0)
      update((s) => ({ ...s, progress: { ...s.progress, runs: s.progress.runs + 1 } }))
    }
    setHasRun(true)
    setPlaying(true)
  }, [hasRun, tick, result.ticks.length, update])
  const pause = useCallback(() => setPlaying(false), [])
  const reset = useCallback(() => {
    setPlaying(false)
    setHasRun(false)
    setTick(0)
  }, [])

  const saveExperiment = useCallback(
    (name?: string) => {
      const exp: Experiment = {
        id: uid('exp'),
        name: name ?? `Experiment ${state.experiments.length + 1}`,
        createdAt: Date.now(),
        challengeId,
        design: structuredClone(state.design),
        workload: { ...state.workload },
        settings: { ...state.settings },
        summary: result.summary,
      }
      update((s) => ({ ...s, experiments: [...s.experiments, exp] }))
      setCompare(([a, b]) => (a ? [a, b ?? exp.id] : [exp.id, null]))
      return exp
    },
    [state, challengeId, result.summary, update],
  )

  const value: WS = {
    challenge,
    setChallengeId,
    mode,
    setMode,
    state,
    update,
    result,
    hasRun,
    playing,
    tick,
    setTick,
    speed,
    setSpeed,
    run,
    pause,
    reset,
    selected,
    setSelected,
    bottomTab,
    setBottomTab,
    leftTab,
    setLeftTab,
    saveExperiment,
    compare,
    setCompare,
    toast,
    notify,
    storeApi: store,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
