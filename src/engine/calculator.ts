import type { Workload } from './types'

export const SECONDS_PER_DAY = 86_400
export const DAYS_PER_YEAR = 365.25

export interface CapacityInputs {
  appRpsPerInstance: number
  dbReadRpsPerNode: number
  dbWriteRpsPerNode: number
  cacheHitRatio: number
  indexOverhead: number
  replicationFactor: number
  /** target max utilization when sizing (headroom), e.g. 0.7 */
  targetUtilization: number
  consumerRpsPerInstance: number
  eventsPerRequest: number
}

export const DEFAULT_CAPACITY_INPUTS: CapacityInputs = {
  appRpsPerInstance: 1000,
  dbReadRpsPerNode: 2000,
  dbWriteRpsPerNode: 500,
  cacheHitRatio: 0.8,
  indexOverhead: 0.3,
  replicationFactor: 3,
  targetUtilization: 0.7,
  consumerRpsPerInstance: 500,
  eventsPerRequest: 1,
}

export interface CalcStep {
  id: string
  label: string
  formula: string
  /** formula with numbers substituted */
  substituted: string
  value: number
  unit: 'req/day' | 'req/s' | 'bytes' | 'bytes/s' | 'instances' | 'fraction' | 'days'
  group: 'Traffic' | 'Storage' | 'Capacity'
  /** steps a user may try to estimate before revealing */
  estimable?: boolean
}

export const readFraction = (w: Workload) => w.readWriteRatio / (w.readWriteRatio + 1)
export const writeFraction = (w: Workload) => 1 / (w.readWriteRatio + 1)

export interface Estimates {
  dailyRequests: number
  avgRps: number
  peakRps: number
  readFraction: number
  writeFraction: number
  avgReadRps: number
  avgWriteRps: number
  peakReadRps: number
  peakWriteRps: number
  dailyWrites: number
  dailyStorageBytes: number
  retentionDays: number
  rawStorageBytes: number
  totalStorageBytes: number
  cacheMemoryBytes: number
  peakIngressBytesPerSec: number
  peakEgressBytesPerSec: number
  appInstances: number
  dbReadNodesNoCache: number
  dbReadNodesWithCache: number
  dbWriteNodes: number
  queueEventsPerSec: number
  consumerInstances: number
  steps: CalcStep[]
}

const f = (n: number, digits = 2) =>
  Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: digits })

/** Every number shown in the calculator comes from here. Pure and deterministic. */
export function estimate(w: Workload, cap: CapacityInputs = DEFAULT_CAPACITY_INPUTS): Estimates {
  const dailyRequests = w.dau * w.requestsPerUserPerDay
  const avgRps = dailyRequests / SECONDS_PER_DAY
  const peakRps = avgRps * w.peakMultiplier
  const rf = readFraction(w)
  const wf = writeFraction(w)
  const avgReadRps = avgRps * rf
  const avgWriteRps = avgRps * wf
  const peakReadRps = peakRps * rf
  const peakWriteRps = peakRps * wf
  const dailyWrites = dailyRequests * wf
  const dailyStorageBytes = dailyWrites * w.payloadBytes
  const retentionDays = w.retentionYears * DAYS_PER_YEAR
  const rawStorageBytes = dailyStorageBytes * retentionDays
  const totalStorageBytes = rawStorageBytes * (1 + cap.indexOverhead) * cap.replicationFactor
  const dailyReads = dailyRequests * rf
  const cacheMemoryBytes = dailyReads * w.hotDataFraction * w.payloadBytes
  const peakIngressBytesPerSec = peakWriteRps * w.payloadBytes
  const peakEgressBytesPerSec = peakReadRps * w.payloadBytes
  const u = cap.targetUtilization
  const appInstances = Math.ceil(peakRps / (cap.appRpsPerInstance * u))
  const dbReadNodesNoCache = Math.ceil(peakReadRps / (cap.dbReadRpsPerNode * u))
  const dbReadNodesWithCache = Math.ceil((peakReadRps * (1 - cap.cacheHitRatio)) / (cap.dbReadRpsPerNode * u))
  const dbWriteNodes = Math.ceil(peakWriteRps / (cap.dbWriteRpsPerNode * u))
  const queueEventsPerSec = peakRps * cap.eventsPerRequest
  const consumerInstances = Math.ceil(queueEventsPerSec / (cap.consumerRpsPerInstance * u))

  const steps: CalcStep[] = [
    { id: 'dailyRequests', group: 'Traffic', label: 'Daily requests', formula: 'DAU × requests/user/day', substituted: `${f(w.dau)} × ${f(w.requestsPerUserPerDay)}`, value: dailyRequests, unit: 'req/day', estimable: true },
    { id: 'avgRps', group: 'Traffic', label: 'Average RPS', formula: 'daily requests ÷ 86,400', substituted: `${f(dailyRequests)} ÷ 86,400`, value: avgRps, unit: 'req/s', estimable: true },
    { id: 'peakRps', group: 'Traffic', label: 'Peak RPS', formula: 'average RPS × peak multiplier', substituted: `${f(avgRps)} × ${f(w.peakMultiplier)}`, value: peakRps, unit: 'req/s', estimable: true },
    { id: 'readFraction', group: 'Traffic', label: 'Read share', formula: 'R ÷ (R + 1) for R:1', substituted: `${f(w.readWriteRatio)} ÷ ${f(w.readWriteRatio + 1)}`, value: rf, unit: 'fraction' },
    { id: 'peakReadRps', group: 'Traffic', label: 'Peak read RPS', formula: 'peak RPS × read share', substituted: `${f(peakRps)} × ${f(rf, 4)}`, value: peakReadRps, unit: 'req/s', estimable: true },
    { id: 'peakWriteRps', group: 'Traffic', label: 'Peak write RPS', formula: 'peak RPS × write share', substituted: `${f(peakRps)} × ${f(wf, 4)}`, value: peakWriteRps, unit: 'req/s', estimable: true },
    { id: 'dailyStorage', group: 'Storage', label: 'Daily storage growth', formula: 'daily writes × record size', substituted: `${f(dailyWrites, 0)} × ${f(w.payloadBytes)} B`, value: dailyStorageBytes, unit: 'bytes', estimable: true },
    { id: 'rawStorage', group: 'Storage', label: 'Raw storage over retention', formula: 'daily growth × retention days', substituted: `${fmtBytes(dailyStorageBytes)} × ${f(retentionDays)} days`, value: rawStorageBytes, unit: 'bytes', estimable: true },
    { id: 'totalStorage', group: 'Storage', label: 'Provisioned storage', formula: 'raw × (1 + index overhead) × replication factor', substituted: `${fmtBytes(rawStorageBytes)} × ${f(1 + cap.indexOverhead)} × ${f(cap.replicationFactor)}`, value: totalStorageBytes, unit: 'bytes' },
    { id: 'cacheMemory', group: 'Storage', label: 'Cache memory (hot set)', formula: 'daily reads × hot fraction × record size', substituted: `${f(dailyReads, 0)} × ${f(w.hotDataFraction)} × ${f(w.payloadBytes)} B`, value: cacheMemoryBytes, unit: 'bytes', estimable: true },
    { id: 'egress', group: 'Capacity', label: 'Peak egress bandwidth', formula: 'peak read RPS × payload', substituted: `${f(peakReadRps)} × ${f(w.payloadBytes)} B`, value: peakEgressBytesPerSec, unit: 'bytes/s' },
    { id: 'ingress', group: 'Capacity', label: 'Peak ingress bandwidth', formula: 'peak write RPS × payload', substituted: `${f(peakWriteRps)} × ${f(w.payloadBytes)} B`, value: peakIngressBytesPerSec, unit: 'bytes/s' },
    { id: 'appInstances', group: 'Capacity', label: 'App instances', formula: '⌈peak RPS ÷ (per-instance RPS × target util)⌉', substituted: `⌈${f(peakRps)} ÷ (${f(cap.appRpsPerInstance)} × ${f(u)})⌉`, value: appInstances, unit: 'instances', estimable: true },
    { id: 'dbReadNoCache', group: 'Capacity', label: 'DB read nodes (no cache)', formula: '⌈peak reads ÷ (per-node reads × util)⌉', substituted: `⌈${f(peakReadRps)} ÷ (${f(cap.dbReadRpsPerNode)} × ${f(u)})⌉`, value: dbReadNodesNoCache, unit: 'instances' },
    { id: 'dbReadWithCache', group: 'Capacity', label: 'DB read nodes (with cache)', formula: '⌈peak reads × (1 − hit) ÷ (per-node reads × util)⌉', substituted: `⌈${f(peakReadRps)} × ${f(1 - cap.cacheHitRatio)} ÷ (${f(cap.dbReadRpsPerNode)} × ${f(u)})⌉`, value: dbReadNodesWithCache, unit: 'instances' },
    { id: 'dbWrite', group: 'Capacity', label: 'DB write capacity (primaries/shards)', formula: '⌈peak writes ÷ (per-node writes × util)⌉', substituted: `⌈${f(peakWriteRps)} ÷ (${f(cap.dbWriteRpsPerNode)} × ${f(u)})⌉`, value: dbWriteNodes, unit: 'instances' },
    { id: 'queue', group: 'Capacity', label: 'Queue throughput', formula: 'peak RPS × events/request', substituted: `${f(peakRps)} × ${f(cap.eventsPerRequest)}`, value: queueEventsPerSec, unit: 'req/s' },
    { id: 'consumers', group: 'Capacity', label: 'Queue consumers', formula: '⌈events/s ÷ (per-consumer rate × util)⌉', substituted: `⌈${f(queueEventsPerSec)} ÷ (${f(cap.consumerRpsPerInstance)} × ${f(u)})⌉`, value: consumerInstances, unit: 'instances' },
  ]

  return {
    dailyRequests,
    avgRps,
    peakRps,
    readFraction: rf,
    writeFraction: wf,
    avgReadRps,
    avgWriteRps,
    peakReadRps,
    peakWriteRps,
    dailyWrites,
    dailyStorageBytes,
    retentionDays,
    rawStorageBytes,
    totalStorageBytes,
    cacheMemoryBytes,
    peakIngressBytesPerSec,
    peakEgressBytesPerSec,
    appInstances,
    dbReadNodesNoCache,
    dbReadNodesWithCache,
    dbWriteNodes,
    queueEventsPerSec,
    consumerInstances,
    steps,
  }
}

// ---- Units (decimal SI, as used in interviews: 1 KB = 1000 B)
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
export function fmtBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes)) return '—'
  let i = 0
  let v = Math.abs(bytes)
  while (v >= 1000 && i < BYTE_UNITS.length - 1) {
    v /= 1000
    i++
  }
  return `${(Math.sign(bytes) * v).toLocaleString('en-US', { maximumFractionDigits: digits })} ${BYTE_UNITS[i]}`
}

export function fmtNum(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`
  if (a >= 1e4) return `${(n / 1e3).toFixed(digits)}K`
  if (a >= 100) return Math.round(n).toLocaleString('en-US')
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function fmtValue(value: number, unit: CalcStep['unit']): string {
  switch (unit) {
    case 'bytes':
      return fmtBytes(value)
    case 'bytes/s':
      return `${fmtBytes(value)}/s (${fmtBits(value * 8)})`
    case 'fraction':
      return `${(value * 100).toFixed(2)}%`
    case 'req/s':
      return `${fmtNum(value)} req/s`
    case 'req/day':
      return `${fmtNum(value)} req/day`
    case 'instances':
      return `${value.toLocaleString('en-US')}`
    case 'days':
      return `${fmtNum(value)} days`
  }
}

export function fmtBits(bits: number): string {
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']
  let i = 0
  let v = bits
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

export const rpsToPerDay = (rps: number) => rps * SECONDS_PER_DAY
export const perDayToRps = (perDay: number) => perDay / SECONDS_PER_DAY

/** Parse a user estimate like "1.2k", "3,500", "900 GB", "1e6" into a base-unit number. */
export function parseEstimate(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '')
  if (!s) return null
  const m = s.match(/^([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)([a-z]*)(\/s)?$/)
  if (!m) return null
  const n = parseFloat(m[1])
  const suffix = m[2]
  const mult: Record<string, number> = {
    '': 1, k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
    byte: 1, bytes: 1, rps: 1, req: 1,
  }
  if (!(suffix in mult)) return null
  return n * mult[suffix]
}

/** Interview-style grading: within 2× is usually considered a good order-of-magnitude estimate. */
export function compareEstimate(guess: number, actual: number) {
  if (actual === 0) return { ratio: guess === 0 ? 1 : Infinity, verdict: guess === 0 ? 'exact' : 'off' as const }
  const ratio = guess / actual
  const err = Math.abs(Math.log10(Math.max(ratio, 1e-12)))
  const verdict = err <= Math.log10(1.1) ? 'exact' : err <= Math.log10(2) ? 'close' : err <= 1 ? 'same order' : 'off'
  return { ratio, verdict }
}
