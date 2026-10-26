// Core domain types for the HLD simulator. Nothing in /engine imports React.

export type ComponentKind =
  | 'client'
  | 'dns_lb'
  | 'api_gateway'
  | 'rate_limiter'
  | 'app_server'
  | 'cache'
  | 'rdbms'
  | 'nosql'
  | 'read_replica'
  | 'sharded_db'
  | 'queue'
  | 'worker'
  | 'object_storage'
  | 'cdn'
  | 'search'
  | 'lock'

export type ConfigValue = number | string | boolean
export type ComponentConfig = Record<string, ConfigValue>

export interface DesignNode {
  id: string
  kind: ComponentKind
  label: string
  position: { x: number; y: number }
  config: ComponentConfig
}

export interface DesignEdge {
  id: string
  source: string
  target: string
}

export interface Design {
  nodes: DesignNode[]
  edges: DesignEdge[]
}

export interface Workload {
  dau: number
  requestsPerUserPerDay: number
  /** reads per write, e.g. 100 means 100:1 */
  readWriteRatio: number
  peakMultiplier: number
  payloadBytes: number
  retentionYears: number
  /** fraction of daily read volume considered "hot" (80/20 rule → 0.2) */
  hotDataFraction: number
  latencyTargetMs: number
  availabilityTarget: number
}

export type TrafficProfile = 'average' | 'peak' | 'ramp' | 'spike'

export interface SimSettings {
  profile: TrafficProfile
  /** simulated seconds per tick */
  dt: number
  ticks: number
}

export type RequestClass = 'read' | 'write' | 'async'
export const CLASSES: RequestClass[] = ['read', 'write', 'async']
export type ClassRates = Record<RequestClass, number>

export type HealthStatus = 'idle' | 'healthy' | 'degraded' | 'overloaded' | 'failed'

export interface NodeTickMetrics {
  /** offered arrival rate per class, req/s */
  offered: ClassRates
  /** processed (completed) rate per class, req/s */
  processed: ClassRates
  /** requests failed here (timeouts / overflow / outage), req/s */
  failed: number
  /** requests rejected on purpose (rate limiter), req/s */
  rejected: number
  /** queued requests carried to next tick */
  backlog: number
  utilization: number
  /** effective capacity in req/s per class if the node only served that class */
  capacity: ClassRates
  /** mean time spent at this node per class, ms (service + queue wait) */
  latencyMs: ClassRates
  hits: number
  misses: number
  status: HealthStatus
}

export interface EdgeTickMetrics {
  rate: number
  read: number
  write: number
  async: number
  /** response edges (component → client): successful responses per second */
  response?: number
  responseBytesPerSec?: number
}

export interface TickResult {
  t: number
  offeredRps: number
  successRps: number
  failedRps: number
  rejectedRps: number
  readLatencyMs: number
  writeLatencyMs: number
  avgLatencyMs: number
  dbReadRps: number
  dbWriteRps: number
  /** read requests offered to stores (demand, before capacity limits) */
  dbReadDemandRps: number
  /** writes that ended at a component with no database/storage behind it */
  unpersistedWriteRps: number
  cacheHitRps: number
  queueBacklog: number
  nodes: Record<string, NodeTickMetrics>
  edges: Record<string, EdgeTickMetrics>
}

export interface Bottleneck {
  nodeId: string
  label: string
  kind: ComponentKind
  firstTick: number
  peakUtilization: number
  failedRequests: number
  reason: string
}

export interface SimSummary {
  peakOfferedRps: number
  peakSuccessRps: number
  totalRequests: number
  totalFailed: number
  totalRejected: number
  errorRate: number
  rejectRate: number
  avgLatencyMs: number
  peakLatencyMs: number
  peakDbReadRps: number
  peakDbReadDemandRps: number
  peakUnpersistedWriteRps: number
  peakDbWriteRps: number
  peakCacheHitRps: number
  maxQueueBacklog: number
  monthlyCostUsd: number
  availability: number
  bottlenecks: Bottleneck[]
}

export interface SimResult {
  ticks: TickResult[]
  summary: SimSummary
  warnings: string[]
}
