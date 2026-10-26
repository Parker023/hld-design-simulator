import { useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CATALOG, PALETTE_ORDER } from '../engine/components'
import { CHALLENGES, node as makeNode } from '../data/challenges'
import { buildModel } from '../engine/simulate'
import type { ComponentKind } from '../engine/types'
import { Notes } from './Review'
import { useWS, type BottomTab, type LeftTab } from './store'

export function LeftSidebar() {
  const { leftTab, setLeftTab, mode } = useWS()
  const tabs: { id: LeftTab; label: string }[] = [
    ...(mode === 'guided' ? [{ id: 'guide' as const, label: 'Guide' }] : []),
    { id: 'components', label: 'Components' },
    { id: 'challenges', label: 'Challenges' },
  ]
  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-slate-800">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setLeftTab(t.id)} className={`flex-1 px-2 py-2 text-xs font-semibold ${leftTab === t.id ? 'border-b-2 border-sky-400 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {leftTab === 'guide' && <Guide />}
        {leftTab === 'components' && <Palette />}
        {leftTab === 'challenges' && <ChallengeList />}
      </div>
    </div>
  )
}

function Palette() {
  const { update, setSelected, state } = useWS()
  const rf = useReactFlow()
  const add = (kind: ComponentKind) => {
    // Drop at the centre of the visible canvas, nudged so repeated clicks don't stack exactly.
    const el = document.querySelector('.react-flow')?.getBoundingClientRect()
    const c = el ? rf.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 }
    const k = state.design.nodes.length % 5
    const n = makeNode(kind, c.x - 95 + k * 24, c.y - 30 + k * 24, {}, undefined, `${kind}-${Date.now().toString(36)}`)
    update((s) => ({ ...s, design: { ...s.design, nodes: [...s.design.nodes, n] } }))
    setSelected(n.id)
  }
  return (
    <div className="space-y-1 p-2">
      <p className="px-1 pb-1 text-[11px] text-slate-500">Drag onto the canvas or click to add. Connect right handle → left handle.</p>
      {PALETTE_ORDER.map((k) => {
        const s = CATALOG[k]
        return (
          <div
            key={k}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/hld-component', k)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => add(k)}
            title={s.description}
            className="flex cursor-grab items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 hover:border-slate-600 hover:bg-slate-800 active:cursor-grabbing"
          >
            <span className="w-5 text-center text-base">{s.icon}</span>
            <span className="truncate">{s.name}</span>
          </div>
        )
      })}
    </div>
  )
}

function ChallengeList() {
  const { challenge, setChallengeId, storeApi } = useWS()
  return (
    <div className="space-y-1.5 p-2">
      {CHALLENGES.map((c) => {
        const saved = storeApi.loadChallenge(c.id)
        return (
          <button
            key={c.id}
            onClick={() => c.id !== challenge.id && setChallengeId(c.id)}
            className={`block w-full rounded-md border px-2.5 py-2 text-left text-xs ${c.id === challenge.id ? 'border-sky-500/60 bg-sky-500/10' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-100">{c.title}</span>
              <span className={`text-[10px] ${c.difficulty === 'Easy' ? 'text-emerald-400' : c.difficulty === 'Medium' ? 'text-amber-300' : 'text-red-300'}`}>{c.difficulty}</span>
            </div>
            <div className="mt-0.5 text-slate-400">{c.summary}</div>
            {saved && (saved.progress.runs > 0 || saved.experiments.length > 0) && (
              <div className="mt-1 text-[10px] text-sky-300">{saved.progress.runs} runs · {saved.experiments.length} experiments</div>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface Step {
  title: string
  prompt: string
  done: boolean
  tab?: BottomTab
  body?: React.ReactNode
}

function Guide() {
  const ws = useWS()
  const { state, update, challenge, result, setBottomTab } = ws
  const p = state.progress
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
  const revealedCount = (ids: string[]) => ids.filter((i) => p.estimates[i]?.revealed).length
  const model = buildModel(state.design)
  const hasStore = state.design.nodes.some((n) => ['store'].includes(CATALOG[n.kind].category))
  const drawn = hasStore && model.warnings.filter((w) => w.includes('not connected') || w.includes('Add a Client')).length === 0 && state.design.edges.length >= 2
  const [answer, setAnswer] = useState(p.bottleneckAnswer ?? '')
  const firstBottleneck = result.summary.bottlenecks[0]

  const steps: Step[] = [
    { title: 'Clarify requirements', prompt: 'Write the functional and non-functional requirements you would confirm with the interviewer. Include scale, latency, availability and consistency.', done: words(p.notes.requirements) >= 20, body: <Notes only={['requirements']} />, tab: 'brief' },
    { title: 'Estimate traffic & storage', prompt: 'In the calculator, type your own estimate for daily requests, average RPS, daily storage and total storage before revealing.', done: revealedCount(['dailyRequests', 'avgRps', 'dailyStorage', 'rawStorage']) >= 3, tab: 'calculator' },
    { title: 'Read/write throughput & peak', prompt: 'Estimate peak RPS and the peak read and write RPS. How far apart are reads and writes?', done: revealedCount(['peakRps', 'peakReadRps', 'peakWriteRps']) >= 2, tab: 'calculator' },
    { title: 'APIs & data model', prompt: 'Define the main endpoints and the schema: primary key, indexes, and how unique keys are generated.', done: words(p.notes.api) + words(p.notes.dataModel) >= 20, body: <Notes only={['api', 'dataModel']} /> },
    { title: 'Draw the initial architecture', prompt: 'Build the simplest design that works: a path from the Client to a persistent store. Configure capacities realistically.', done: drawn, tab: 'brief' },
    { title: 'Run a traffic simulation', prompt: 'Press Run. Watch the request flow, utilization and latency as traffic ramps to peak.', done: p.runs > 0, tab: 'timeline' },
    {
      title: 'Identify the bottleneck',
      prompt: 'Which component saturates first, and why? Commit to an answer before reading the insights.',
      done: !!p.bottleneckAnswer,
      tab: 'logs',
      body: (
        <div className="space-y-1.5">
          <select className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs" value={answer} onChange={(e) => setAnswer(e.target.value)}>
            <option value="">Choose a component…</option>
            <option value="none">Nothing overloads</option>
            {state.design.nodes.filter((n) => n.kind !== 'client').map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
          <button className="rounded bg-sky-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-40" disabled={!answer || p.runs === 0} onClick={() => update((s) => ({ ...s, progress: { ...s.progress, bottleneckAnswer: answer } }))}>Check</button>
          {p.bottleneckAnswer && (
            <div className={`rounded px-2 py-1 text-xs ${(firstBottleneck?.nodeId ?? 'none') === p.bottleneckAnswer ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-200'}`}>
              {(firstBottleneck?.nodeId ?? 'none') === p.bottleneckAnswer ? 'Correct. ' : `Not quite: the simulation shows ${firstBottleneck?.label ?? 'no bottleneck'} first. `}
              {firstBottleneck?.reason}
            </div>
          )}
        </div>
      ),
    },
    { title: 'Scale the design', prompt: 'Snapshot a baseline, then introduce one scaling strategy at a time (cache, replicas, more instances, queue, CDN, sharding, rate limiting) and snapshot again.', done: state.experiments.length >= 2, tab: 'experiments' },
    { title: 'Compare before vs after', prompt: 'Compare two experiments. Did the bottleneck move? What did it cost? Try a 10× peak and a cache outage too.', done: p.compared, tab: 'experiments' },
    { title: 'Review trade-offs', prompt: 'Write down the trade-offs and risks of your design, then evaluate it. The reference solution unlocks here.', done: words(p.notes.tradeoffs) >= 20, body: <Notes only={['tradeoffs']} />, tab: 'review' },
  ]
  const cur = Math.min(p.guideStep, steps.length - 1)
  const go = (i: number) => {
    update((s) => ({ ...s, progress: { ...s.progress, guideStep: i } }))
    if (steps[i].tab) setBottomTab(steps[i].tab!)
  }
  const s = steps[cur]
  return (
    <div className="space-y-3 p-2">
      <ol className="space-y-0.5">
        {steps.map((st, i) => (
          <li key={st.title}>
            <button onClick={() => go(i)} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${i === cur ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-900'}`}>
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${st.done ? 'bg-emerald-500 text-slate-950' : i === cur ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300'}`}>{st.done ? '✓' : i + 1}</span>
              {st.title}
            </button>
          </li>
        ))}
      </ol>
      <div className="rounded-md border border-slate-800 bg-slate-900 p-2.5">
        <div className="text-xs font-semibold text-slate-100">{cur + 1}. {s.title}</div>
        <p className="mt-1 text-xs text-slate-300">{s.prompt}</p>
        {s.body && <div className="mt-2">{s.body}</div>}
        <GuideHint stepIndex={cur} hints={challenge.hints} />
        <div className="mt-2 flex justify-between">
          <button disabled={cur === 0} onClick={() => go(cur - 1)} className="text-xs text-slate-400 disabled:opacity-30">← Back</button>
          <button disabled={cur === steps.length - 1} onClick={() => go(cur + 1)} className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-100 hover:bg-slate-600 disabled:opacity-30">Next →</button>
        </div>
      </div>
    </div>
  )
}

function GuideHint({ stepIndex, hints }: { stepIndex: number; hints: string[] }) {
  const { update } = useWS()
  const [open, setOpen] = useState(false)
  const hint = stepIndex >= 1 && stepIndex <= 2 ? hints[0] : stepIndex === 6 ? hints[2] : stepIndex === 7 ? hints[1] : stepIndex === 8 ? hints[hints.length - 1] : undefined
  if (!hint) return null
  return open ? (
    <div className="mt-2 rounded bg-sky-500/10 px-2 py-1 text-xs text-sky-200">💡 {hint}</div>
  ) : (
    <button className="mt-2 text-xs text-sky-300 hover:underline" onClick={() => { setOpen(true); update((s) => ({ ...s, progress: { ...s.progress, hintsUsed: s.progress.hintsUsed + 1 } })) }}>
      Stuck? Show a hint
    </button>
  )
}
