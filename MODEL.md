# Simulation model & assumptions

Every number in the UI comes from `src/engine/calculator.ts` (closed-form formulas) or
`src/engine/simulate.ts` (deterministic discrete-time simulation). Nothing is hard-coded demo data.
Capacities, latencies, costs and availabilities are **modeled assumptions** chosen to be in a
plausible range. They are **not benchmarks** of real products. Change them per component.

## Workload

| Quantity | Formula |
|---|---|
| Daily requests | DAU × requests/user/day |
| Average RPS | daily requests ÷ 86,400 |
| Peak RPS | average RPS × peak multiplier |
| Read share (R:1) | R ÷ (R + 1) |
| Daily storage | daily writes × record size |
| Raw storage | daily storage × retention years × 365.25 |
| Provisioned storage | raw × (1 + index overhead) × replication factor |
| Cache memory (hot set) | daily reads × hot fraction × record size |
| Instances needed | ⌈load ÷ (per-node capacity × target utilization)⌉ |

Units are decimal (1 GB = 10⁹ B), as is usual in interviews.

## Traffic over time

The simulation runs `ticks` steps of `dt` simulated seconds. Offered load per tick is
`average RPS × m(t)`, where `m(t)` follows the selected profile:

* **ramp**: 1× → peak over 20% of the run, hold peak for 40%, back down to 1×
* **spike**: sudden burst to peak for about 20% of the run
* **peak** / **average**: constant

A whole day is compressed into the run, so this is a stress pattern, not a wall-clock replay.

## Request routing (uses the edges you draw)

Traffic is a fluid split into classes: `read`, `write`, `async`. Nodes are processed in
topological order; cycles are ignored with a warning.

* **Tier hop** (target is LB / gateway / rate limiter / app / CDN): split evenly
  (round-robin). Failed targets are skipped if a healthy one exists (health checks).
* **Data tier** (from an app or worker):
  * reads go to caches if connected, otherwise to read-capable stores weighted by read capacity
  * writes go to write-capable stores weighted by write capacity (read replicas never receive writes)
  * every write also acquires each connected **distributed lock**
  * `eventsPerRequest` side-effects go to a **queue** if one is connected, otherwise they become
    synchronous DB writes
* **Cache**: hits = reads × hit ratio are served; misses continue to the cache's own downstream.
  A cache with no outgoing edge is treated as look-aside: misses fall back to the stores its callers
  use (drawn as a dashed "miss fallback" edge).
* **Queue → workers → stores**: async, off the request path.
* Stores and locks are terminal. Edges out of them are informational.

## Capacity, queueing and latency per node

For each class `k` a node has a capacity `C_k` (req/s if it served only that class):

```
busy time     = Σ (backlog_k + arrivals_k) / C_k
processed     = demand × min(1, dt / busy time)
remainder     → queue; queued work beyond `timeout` seconds fails
utilization ρ = Σ arrivals_k / (C_k · dt)
latency_k     = base_k × (1 + 0.5·ρ⁶/(1−ρ))  (ρ capped at 0.95)  + queue wait
```

The inflation term is a smooth multi-server approximation: flat until ~70%, then a hockey stick.

Component specifics:

| Component | Capacity |
|---|---|
| App servers | min(instances × req/s, instances × maxConcurrent ÷ (processing + downstream latency)). Little's law; downstream latency is smoothed (EMA α = 0.3), so a slow DB exhausts app threads. |
| Relational DB | read = min(readRps, pool ÷ readLatency) × (1 + replicas); write = min(writeRps, pool ÷ writeLatency) |
| NoSQL | read = nodes × perNode ÷ replicas touched (1 / quorum / RF); write = nodes × perNode ÷ RF; latency ×1 / ×1.5 / ×2 |
| Sharded DB | shards × perShard ÷ hot-shard skew |
| Cache (working-set mode) | hit = 0.95 × min(1, memory ÷ hot set)^k, k = 0.4 LFU / 0.5 LRU / 0.6 TTL |
| Cache / CDN overload | no queue: overflow is treated as a miss (fallthrough) or fails (`fail` mode) |
| Rate limiter | traffic above `limitRps` is **rejected** (429), counted separately from failures |
| Queue | delivered = min(backlog + published, broker capacity, consumer capacity); the rest is lag |

## Health states

* **healthy**: ρ < 0.7, no queue
* **degraded**: ρ ≥ 0.7, queued work, or rate limiting active
* **overloaded**: requests failing, or ρ ≥ 1
* **down**: outage injected

A **bottleneck** is any node that becomes overloaded. They are ordered by when they first overloaded.

## Cost & availability (illustrative)

* Cost: rough monthly list prices per instance / GB (see `monthlyCost` in `components.ts`).
* Availability: product over components on the synchronous path; redundant units are
  `1 − (1 − a)ⁿ`. A cache in fallthrough mode does not reduce availability.

## Known simplifications

* Fluid model: no per-request randomness, so mean latency only (no p99).
* Replication lag, cache invalidation traffic and cross-shard queries are described as trade-offs,
  not simulated.
* Same-tick propagation: no network transit delay beyond 0.5 ms per hop.
