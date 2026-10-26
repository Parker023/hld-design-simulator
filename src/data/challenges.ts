import { CATALOG, PALETTE_ORDER, derivedKeys } from '../engine/components'
import type { ComponentConfig, ComponentKind, Design, DesignEdge, DesignNode, Workload } from '../engine/types'

export interface Challenge {
  id: string
  title: string
  difficulty: 'Easy' | 'Medium' | 'Hard'
  summary: string
  statement: string
  functional: string[]
  nonFunctional: string[]
  workload: Workload
  considerations: string[]
  components: ComponentKind[]
  evaluation: string[]
  hints: string[]
  /** a deliberately naive starting point the user may load */
  starter: Design
  reference: { design: Design; notes: string[] }
}

let seq = 0
export const node = (kind: ComponentKind, x: number, y: number, config: ComponentConfig = {}, label?: string, id?: string): DesignNode => ({
  id: id ?? `${kind}-${++seq}`,
  kind,
  label: label ?? CATALOG[kind].short,
  position: { x, y },
  // Explicit throughput numbers (e.g. readRps) only make sense in manual sizing; otherwise hardware derives them.
  config: { ...CATALOG[kind].defaults, ...(!('sizing' in config) && derivedKeys(kind).some((k) => k in config) ? { sizing: 'manual' } : {}), ...config },
})
export const edge = (a: DesignNode, b: DesignNode): DesignEdge => ({ id: `e-${a.id}-${b.id}`, source: a.id, target: b.id })
const design = (nodes: DesignNode[], links: [DesignNode, DesignNode][]): Design => ({ nodes, edges: links.map(([a, b]) => edge(a, b)) })

const baseWorkload: Workload = {
  dau: 10_000_000,
  requestsPerUserPerDay: 10,
  readWriteRatio: 100,
  peakMultiplier: 3,
  payloadBytes: 500,
  retentionYears: 5,
  hotDataFraction: 0.2,
  latencyTargetMs: 100,
  availabilityTarget: 0.999,
}

/** Classic 3-tier starter: client → LB → app → single DB. */
function threeTier(app: ComponentConfig, db: ComponentConfig, dbKind: ComponentKind = 'rdbms'): Design {
  const c = node('client', 0, 160, {}, 'Clients', 'client')
  const lb = node('dns_lb', 220, 160, {}, undefined, 'lb')
  const a = node('app_server', 440, 160, app, undefined, 'app')
  const d = node(dbKind, 680, 160, db, undefined, 'db')
  return design([c, lb, a, d], [[c, lb], [lb, a], [a, d]])
}

// ---------------------------------------------------------------------------
// 1. URL shortener (fully tuned Phase-1 challenge)

const urlShortenerRef = (() => {
  const c = node('client', 0, 200, {}, 'Clients', 'client')
  const lb = node('dns_lb', 200, 200, { instances: 2 }, undefined, 'lb')
  const rl = node('rate_limiter', 400, 200, { limitRps: 15000 }, undefined, 'rl')
  const app = node('app_server', 600, 200, { instances: 6, eventsPerRequest: 1 }, undefined, 'app')
  const cache = node('cache', 820, 80, { hitRatio: 0.9, memoryGb: 16 }, 'Redis (url→long)', 'cache')
  const db = node('rdbms', 1040, 200, { readReplicas: 1, storageGb: 3000, replicationFactor: 2 }, 'URL DB', 'db')
  const q = node('queue', 820, 360, { partitions: 6 }, 'Kafka (clicks)', 'q')
  const w = node('worker', 1040, 360, { instances: 10 }, 'Analytics workers', 'w')
  const an = node('nosql', 1260, 360, {}, 'Analytics store', 'an')
  return design([c, lb, rl, app, cache, db, q, w, an], [[c, lb], [lb, rl], [rl, app], [app, cache], [cache, db], [app, db], [app, q], [q, w], [w, an]])
})()

const urlShortener: Challenge = {
  id: 'url-shortener',
  title: 'URL Shortener',
  difficulty: 'Easy',
  summary: 'TinyURL / bit.ly: create short links and redirect at massive read scale.',
  statement:
    'Design a service that turns long URLs into short aliases and redirects visitors from the alias to the original URL. Redirects dominate traffic.',
  functional: [
    'Create a short URL for a long URL (optionally with a custom alias and expiry).',
    'Redirect a short URL to its long URL (HTTP 301/302).',
    'Track click counts per short URL (non-critical, can lag).',
  ],
  nonFunctional: [
    'Redirect latency: under 100 ms (modeled mean).',
    'Availability: 99.9% or better for redirects.',
    'Short codes must be unique and unguessable enough; links persist 5 years.',
    'Read-heavy: about 100 redirects per URL created.',
  ],
  workload: { ...baseWorkload },
  considerations: [
    'Key generation: base62 of a counter vs hashing vs a pre-generated key service.',
    'Read path caching: the hot set of URLs is small relative to total storage.',
    'Database choice: simple key→value lookups, 5-year retention.',
    'Click analytics should be off the redirect path.',
    'Abuse protection: rate limit creation.',
  ],
  components: PALETTE_ORDER,
  evaluation: [
    'Survives peak traffic with < 1% errors.',
    'Redirect latency within target.',
    'DB read load reduced by caching in proportion to hit ratio.',
    'Analytics decoupled from the redirect path.',
    'Storage sized for 5 years incl. replication.',
  ],
  hints: [
    'Compute peak read RPS first. Compare it to one database’s read throughput.',
    'What fraction of redirects go to the same few popular URLs? What does that suggest?',
    'Look at which component turns red first in the simulation. Then think about what reduces its offered load, rather than just making it bigger.',
    'Click counting is a write per redirect. Does the user need to wait for it?',
    'Try a 10× peak. Where does the bottleneck move?',
  ],
  starter: threeTier({ instances: 4 }, { vcpu: 4, ramGb: 16 }), // 4 vCPU → 2,000 reads/s, 500 writes/s
  reference: {
    design: urlShortenerRef,
    notes: [
      'Redis with ~90% hit ratio cuts DB reads to ~10% of peak read RPS.',
      'One read replica gives headroom for cache misses and a cache outage.',
      'Click events go to Kafka; workers aggregate into an analytics store (eventual consistency).',
      'Rate limiter protects the origin during 10× spikes and abusive clients.',
      'Storage ≈ 0.9 TB raw over 5 years; with indexes and 2 copies about 2.4 TB, so provision 3 TB.',
    ],
  },
}

// ---------------------------------------------------------------------------
// 2–10: additional challenges (same engine, different workloads)

function simpleRef(extra: (c: DesignNode, lb: DesignNode, app: DesignNode) => { nodes: DesignNode[]; links: [DesignNode, DesignNode][] }, app: ComponentConfig = { instances: 6 }): Design {
  const c = node('client', 0, 200, {}, 'Clients', 'client')
  const lb = node('dns_lb', 200, 200, { instances: 2 }, undefined, 'lb')
  const a = node('app_server', 420, 200, app, undefined, 'app')
  const x = extra(c, lb, a)
  return design([c, lb, a, ...x.nodes], [[c, lb], [lb, a], ...x.links])
}

const pastebin: Challenge = {
  id: 'pastebin',
  title: 'Pastebin',
  difficulty: 'Easy',
  summary: 'Store and serve text snippets; blobs are larger than URL mappings.',
  statement: 'Users paste text and receive a link. Anyone with the link can read the paste until it expires.',
  functional: ['Create a paste (up to 1 MB) with optional expiry.', 'Read a paste by key.', 'Expire pastes automatically.'],
  nonFunctional: ['Read latency under 200 ms.', '99.9% availability.', 'Pastes stored for up to 2 years.'],
  workload: { ...baseWorkload, dau: 2_000_000, requestsPerUserPerDay: 5, readWriteRatio: 10, payloadBytes: 10_000, retentionYears: 2, latencyTargetMs: 200 },
  considerations: ['Metadata DB vs blob store split.', 'CDN for popular pastes.', 'Expiry cleanup via background jobs.'],
  components: PALETTE_ORDER,
  evaluation: ['Content in object storage, metadata in DB.', 'Cache/CDN for hot pastes.', 'Storage sized for blob payloads.'],
  hints: ['10 KB × writes/day adds up quickly. Where should large blobs live?', 'Object storage has high throughput but higher latency. What hides that latency?'],
  starter: threeTier({ instances: 2 }, { readRps: 2000, writeRps: 500 }),
  reference: {
    design: simpleRef((_c, _lb, a) => {
      const cache = node('cache', 640, 80, { hitRatio: 0.8 }, undefined, 'cache')
      const db = node('rdbms', 860, 200, {}, 'Metadata DB', 'db')
      const s3 = node('object_storage', 860, 340, {}, 'Paste blobs', 's3')
      return { nodes: [cache, db, s3], links: [[a, cache], [a, db], [a, s3]] }
    }, { instances: 3 }),
    notes: ['Blob bodies in S3, metadata in SQL, Redis for hot keys.', 'Expiry via TTL index plus a cleanup worker.'],
  },
}

const rateLimiter: Challenge = {
  id: 'rate-limiter',
  title: 'Rate Limiter',
  difficulty: 'Medium',
  summary: 'A distributed limiter in front of an API with bursty clients.',
  statement: 'Design a rate limiting service that enforces per-client quotas across a fleet of API servers.',
  functional: ['Limit requests per client per window.', 'Return 429 with retry-after.', 'Configurable rules per API key.'],
  nonFunctional: ['Adds under 5 ms.', 'Must not become a single point of failure.', 'Accurate within ~1%.'],
  workload: { ...baseWorkload, dau: 5_000_000, requestsPerUserPerDay: 200, readWriteRatio: 1, peakMultiplier: 5, payloadBytes: 100, retentionYears: 0.01, latencyTargetMs: 50 },
  considerations: ['Token bucket vs sliding window.', 'Counter store (Redis) and its throughput.', 'Fail-open vs fail-closed.'],
  components: PALETTE_ORDER,
  evaluation: ['Spike traffic is rejected, not queued.', 'Counter store sized for peak.', 'Failure mode chosen deliberately.'],
  hints: ['Every request reads and updates a counter. How many counter ops per second at peak?', 'What happens to your API if the counter store goes down?'],
  starter: threeTier({ instances: 4 }, { readRps: 5000, writeRps: 2000 }),
  reference: {
    design: (() => {
      const c = node('client', 0, 200, {}, 'Clients', 'client')
      const lb = node('dns_lb', 200, 200, { instances: 2 }, undefined, 'lb')
      const rl = node('rate_limiter', 420, 200, { limitRps: 40000 }, undefined, 'rl')
      const a = node('app_server', 640, 200, { instances: 40 }, undefined, 'app')
      const r = node('nosql', 860, 200, { nodes: 6 }, 'Backend store', 'db')
      return design([c, lb, rl, a, r], [[c, lb], [lb, rl], [rl, a], [a, r]])
    })(),
    notes: ['Limiter in front of the app tier; counters in Redis cluster (modeled as limiter capacity).', 'Fail-open for availability, with conservative local fallback limits.'],
  },
}

const notification: Challenge = {
  id: 'notification-service',
  title: 'Notification Service',
  difficulty: 'Medium',
  summary: 'Fan out push/email/SMS notifications reliably at scale.',
  statement: 'Design a service that other teams call to send notifications through multiple channels with retries.',
  functional: ['Send notification via push, email, SMS.', 'User preferences and opt-out.', 'Retries with backoff; delivery status.'],
  nonFunctional: ['At-least-once delivery.', 'Accept API calls in under 50 ms.', 'Handle 10× marketing bursts.'],
  workload: { ...baseWorkload, dau: 20_000_000, requestsPerUserPerDay: 3, readWriteRatio: 0.5, peakMultiplier: 10, payloadBytes: 1_000, retentionYears: 0.25, latencyTargetMs: 50 },
  considerations: ['Queue between API and channel workers.', 'Idempotency keys for retries.', 'Per-provider rate limits.'],
  components: PALETTE_ORDER,
  evaluation: ['API path is decoupled by a queue.', 'Consumers sized for burst drain time.', 'Retry/idempotency discussed.'],
  hints: ['Should the caller wait for the SMS provider to respond?', 'How long does a 10× burst take to drain with your consumer count?'],
  starter: threeTier({ instances: 4 }, { readRps: 3000, writeRps: 1000 }),
  reference: {
    design: simpleRef((_c, _lb, a) => {
      const db = node('nosql', 660, 80, {}, 'Prefs + status', 'db')
      const q = node('queue', 660, 300, { partitions: 12 }, 'Notification queue', 'q')
      const w = node('worker', 880, 300, { instances: 30 }, 'Channel workers', 'w')
      const log = node('nosql', 1100, 300, {}, 'Delivery log', 'log')
      return { nodes: [db, q, w, log], links: [[a, db], [a, q], [q, w], [w, log]] }
    }, { instances: 6, eventsPerRequest: 1 }),
    notes: ['API writes intent and enqueues; workers fan out per channel.', 'Queue absorbs bursts; lag is the metric to watch.'],
  },
}

const chat: Challenge = {
  id: 'chat',
  title: 'Chat Application',
  difficulty: 'Hard',
  summary: 'WhatsApp-style 1:1 and group messaging with delivery receipts.',
  statement: 'Design a messaging system supporting 1:1 and small-group chat, online presence and offline delivery.',
  functional: ['Send/receive messages in real time.', 'Offline message storage and sync.', 'Delivery/read receipts, presence.'],
  nonFunctional: ['Message delivery under 200 ms when both online.', 'Ordering per conversation.', 'Durable once acknowledged.'],
  workload: { ...baseWorkload, dau: 50_000_000, requestsPerUserPerDay: 40, readWriteRatio: 1, peakMultiplier: 3, payloadBytes: 300, retentionYears: 1, latencyTargetMs: 200 },
  considerations: ['Write-heavy: 1:1 read/write.', 'Wide-column store partitioned by conversation.', 'Connection gateways (WebSockets).'],
  components: PALETTE_ORDER,
  evaluation: ['Write path scales horizontally.', 'Partition key choice avoids hot shards.', 'Fan-out handled asynchronously.'],
  hints: ['At 1:1 ratio, caching reads helps much less. What scales writes?', 'What is the partition key for messages?'],
  starter: threeTier({ instances: 10 }, { readRps: 5000, writeRps: 2000 }),
  reference: {
    design: simpleRef((_c, _lb, a) => {
      const db = node('nosql', 660, 200, { nodes: 12 }, 'Messages (by convo)', 'db')
      const q = node('queue', 660, 360, { partitions: 24 }, 'Fan-out', 'q')
      const w = node('worker', 880, 360, { instances: 40 }, 'Push workers', 'w')
      const ps = node('nosql', 1100, 360, { nodes: 3 }, 'Inbox store', 'inbox')
      return { nodes: [db, q, w, ps], links: [[a, db], [a, q], [q, w], [w, ps]] }
    }, { instances: 40, eventsPerRequest: 0.5 }),
    notes: ['Cassandra-like store partitioned by conversation id.', 'Gateways hold WebSockets; fan-out via queue.'],
  },
}

const newsFeed: Challenge = {
  id: 'news-feed',
  title: 'News Feed / Instagram',
  difficulty: 'Hard',
  summary: 'Timeline generation with fan-out-on-write vs read.',
  statement: 'Design a photo-sharing feed where users follow others and see a ranked timeline.',
  functional: ['Post photos with captions.', 'Follow users.', 'View home timeline.'],
  nonFunctional: ['Timeline load under 200 ms.', 'Eventual consistency acceptable for feed.', 'Media served globally.'],
  workload: { ...baseWorkload, dau: 100_000_000, requestsPerUserPerDay: 30, readWriteRatio: 50, peakMultiplier: 3, payloadBytes: 2_000, retentionYears: 5, latencyTargetMs: 200 },
  considerations: ['Fan-out on write vs read (celebrity problem).', 'Feed cache per user.', 'Media in S3 + CDN.'],
  components: PALETTE_ORDER,
  evaluation: ['Precomputed timelines in cache.', 'Media via CDN.', 'Fan-out async.'],
  hints: ['Timeline reads vastly outnumber posts. Where should timelines be precomputed?', 'What happens when someone with 100M followers posts?'],
  starter: threeTier({ instances: 20 }, { readRps: 5000, writeRps: 1000 }),
  reference: {
    design: (() => {
      const c = node('client', 0, 200, {}, 'Clients', 'client')
      const cdn = node('cdn', 200, 200, { hitRatio: 0.6 }, undefined, 'cdn')
      const lb = node('dns_lb', 400, 200, { instances: 2, rpsPerInstance: 100000 }, undefined, 'lb')
      const a = node('app_server', 600, 200, { instances: 60, eventsPerRequest: 0.02 }, undefined, 'app')
      const cache = node('cache', 820, 60, { hitRatio: 0.95, rpsCapacity: 300000, memoryGb: 256 }, 'Feed cache', 'cache')
      const db = node('sharded_db', 1040, 200, { shards: 16 }, 'Posts/graph', 'db')
      const q = node('queue', 820, 360, { partitions: 24 }, 'Fan-out', 'q')
      const w = node('worker', 1040, 360, { instances: 20 }, 'Fan-out workers', 'w')
      const fs = node('nosql', 1260, 360, { nodes: 6 }, 'Timelines', 'tl')
      return design([c, cdn, lb, a, cache, db, q, w, fs], [[c, cdn], [cdn, lb], [lb, a], [a, cache], [cache, db], [a, db], [a, q], [q, w], [w, fs]])
    })(),
    notes: ['Hybrid fan-out: push for normal users, pull for celebrities.', 'Feed cache + CDN absorb most reads.'],
  },
}

const video: Challenge = {
  id: 'video-streaming',
  title: 'Video Streaming Platform',
  difficulty: 'Hard',
  summary: 'YouTube-style upload, transcode and global streaming.',
  statement: 'Design a platform to upload videos, transcode into multiple resolutions and stream to viewers worldwide.',
  functional: ['Upload videos.', 'Transcode to multiple bitrates.', 'Stream with adaptive bitrate.'],
  nonFunctional: ['Start playback under 2 s.', 'Massive egress bandwidth.', 'Durable storage.'],
  workload: { ...baseWorkload, dau: 30_000_000, requestsPerUserPerDay: 20, readWriteRatio: 200, peakMultiplier: 3, payloadBytes: 2_000_000, retentionYears: 10, latencyTargetMs: 300 },
  considerations: ['CDN carries most egress.', 'Async transcoding pipeline.', 'Segment-based streaming.'],
  components: PALETTE_ORDER,
  evaluation: ['CDN hit ratio drives origin cost.', 'Transcoding off the request path.', 'Storage per year computed.'],
  hints: ['Compute egress bandwidth at peak. Can an origin serve that?', 'Uploads trigger heavy CPU work. Should the uploader wait?'],
  starter: threeTier({ instances: 10 }, { readRps: 50000, writeRps: 10000 }, 'object_storage'),
  reference: {
    design: (() => {
      const c = node('client', 0, 200, {}, 'Viewers', 'client')
      const cdn = node('cdn', 200, 200, { hitRatio: 0.95 }, undefined, 'cdn')
      const lb = node('dns_lb', 400, 200, { instances: 2 }, undefined, 'lb')
      const a = node('app_server', 600, 200, { instances: 10, eventsPerRequest: 0.005 }, undefined, 'app')
      const s3 = node('object_storage', 820, 200, {}, 'Segments', 's3')
      const q = node('queue', 820, 360, {}, 'Transcode jobs', 'q')
      const w = node('worker', 1040, 360, { instances: 20, rpsPerInstance: 5 }, 'Transcoders', 'w')
      const meta = node('rdbms', 1260, 360, {}, 'Video metadata', 'meta')
      return design([c, cdn, lb, a, s3, q, w, meta], [[c, cdn], [cdn, lb], [lb, a], [a, s3], [a, q], [q, w], [w, meta]])
    })(),
    notes: ['CDN with ~95% hit ratio keeps origin egress manageable.', 'Transcoding via queue + worker fleet.'],
  },
}

const rideShare: Challenge = {
  id: 'ride-sharing',
  title: 'Ride-Sharing Service',
  difficulty: 'Hard',
  summary: 'Uber-style driver location updates and matching.',
  statement: 'Design a service that tracks driver locations and matches riders to nearby drivers.',
  functional: ['Drivers send location every 4 s.', 'Riders request a ride and get matched.', 'Trip lifecycle & payments.'],
  nonFunctional: ['Matching under 1 s.', 'Location writes dominate.', 'No double-booking of a driver.'],
  workload: { ...baseWorkload, dau: 5_000_000, requestsPerUserPerDay: 300, readWriteRatio: 0.3, peakMultiplier: 4, payloadBytes: 100, retentionYears: 1, latencyTargetMs: 200 },
  considerations: ['Geo-indexing (geohash / quadtree).', 'In-memory location store.', 'Distributed lock on driver assignment.'],
  components: PALETTE_ORDER,
  evaluation: ['Location writes kept off durable DB hot path.', 'Locking for matching.', 'Geo-sharding.'],
  hints: ['Write-heavy: which store handles ~20K+ writes/s cheaply?', 'How do you stop two riders being matched to one driver?'],
  starter: threeTier({ instances: 10 }, { readRps: 5000, writeRps: 2000 }),
  reference: {
    design: simpleRef((_c, _lb, a) => {
      const geo = node('sharded_db', 660, 160, { shards: 16, writeRpsPerShard: 5000, readRpsPerShard: 5000, strategy: 'geo', hotShardSkew: 1.8 }, 'Geo location store', 'db')
      const lock = node('lock', 660, 320, { rpsCapacity: 50000 }, 'Driver lock', 'lock')
      return { nodes: [geo, lock], links: [[a, geo], [a, lock]] }
    }, { instances: 40 }),
    notes: ['Geo-sharded in-memory store; hot cities cause skew.', 'Lock/compare-and-set on driver assignment.'],
  },
}

const fileStorage: Challenge = {
  id: 'file-storage',
  title: 'File Storage Service',
  difficulty: 'Medium',
  summary: 'Dropbox-style sync with chunking and dedup.',
  statement: 'Design a service for users to upload, sync and share files across devices.',
  functional: ['Upload/download files.', 'Sync across devices.', 'Share links.'],
  nonFunctional: ['Durability 11 nines.', 'Large files via chunks.', 'Metadata strongly consistent.'],
  workload: { ...baseWorkload, dau: 10_000_000, requestsPerUserPerDay: 20, readWriteRatio: 3, peakMultiplier: 3, payloadBytes: 100_000, retentionYears: 10, latencyTargetMs: 300 },
  considerations: ['Metadata DB vs block storage.', 'Chunking + dedup.', 'Sync notifications via queue.'],
  components: PALETTE_ORDER,
  evaluation: ['Blocks in object storage.', 'Metadata DB sized for writes.', 'Notifications async.'],
  hints: ['Separate the file bytes from the file metadata. Which needs strong consistency?'],
  starter: threeTier({ instances: 6 }, { readRps: 3000, writeRps: 1000 }),
  reference: {
    design: simpleRef((_c, _lb, a) => {
      const s3 = node('object_storage', 660, 100, {}, 'Blocks', 's3')
      const db = node('sharded_db', 660, 240, { shards: 4 }, 'Metadata', 'db')
      const q = node('queue', 660, 380, {}, 'Sync events', 'q')
      const w = node('worker', 880, 380, { instances: 6 }, 'Notifiers', 'w')
      const n = node('nosql', 1100, 380, {}, 'Device inbox', 'inbox')
      return { nodes: [s3, db, q, w, n], links: [[a, s3], [a, db], [a, q], [q, w], [w, n]] }
    }, { instances: 10, eventsPerRequest: 0.25 }),
    notes: ['Blocks in S3; metadata sharded by user.', 'Sync events via queue.'],
  },
}

const jobScheduler: Challenge = {
  id: 'job-scheduler',
  title: 'Distributed Job Scheduler',
  difficulty: 'Hard',
  summary: 'Cron at scale with exactly-once-ish execution.',
  statement: 'Design a system that schedules and runs millions of jobs at specified times with retries.',
  functional: ['Create/cancel scheduled jobs.', 'Execute at the scheduled time.', 'Retry failed jobs.'],
  nonFunctional: ['Jobs start within 5 s of schedule.', 'No double execution.', 'Survive node failures.'],
  workload: { ...baseWorkload, dau: 1_000_000, requestsPerUserPerDay: 50, readWriteRatio: 2, peakMultiplier: 6, payloadBytes: 1_000, retentionYears: 1, latencyTargetMs: 100 },
  considerations: ['Partitioned time-bucket table.', 'Leasing via distributed lock.', 'Worker pool sized for top-of-hour spikes.'],
  components: PALETTE_ORDER,
  evaluation: ['Spikes absorbed by queue.', 'Lock/lease prevents double runs.', 'Workers sized for drain time.'],
  hints: ['Many jobs fire at :00. What is your peak multiplier?', 'How does a worker claim a job so no one else runs it?'],
  starter: threeTier({ instances: 4 }, { vcpu: 4, ramGb: 16 }), // 4 vCPU → 2,000 reads/s, 500 writes/s
  reference: {
    design: simpleRef((_c, _lb, a) => {
      const db = node('sharded_db', 660, 120, { shards: 4 }, 'Job table', 'db')
      const lock = node('lock', 660, 260, {}, 'Lease lock', 'lock')
      const q = node('queue', 660, 400, {}, 'Due jobs', 'q')
      const w = node('worker', 880, 400, { instances: 20 }, 'Executors', 'w')
      const log = node('nosql', 1100, 400, {}, 'Run history', 'log')
      return { nodes: [db, lock, q, w, log], links: [[a, db], [a, lock], [a, q], [q, w], [w, log]] }
    }, { instances: 6, eventsPerRequest: 1 }),
    notes: ['Time-bucketed job table; leases via lock.', 'Queue smooths top-of-hour spikes.'],
  },
}

export const CHALLENGES: Challenge[] = [urlShortener, pastebin, rateLimiter, notification, chat, newsFeed, video, rideShare, fileStorage, jobScheduler]

export const blankDesign = (): Design => ({ nodes: [node('client', 0, 200, {}, 'Clients', 'client')], edges: [] })
