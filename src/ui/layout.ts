export const NODE_W = 190
export const NODE_H = 90
const GAP = 24

type Pt = { x: number; y: number }

const overlaps = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < NODE_W + GAP && Math.abs(a.y - b.y) < NODE_H + GAP

/** Nearest grid position to `start` that doesn't overlap any existing node (searches outward ring by ring). */
export function freeSpot(existing: Pt[], start: Pt): Pt {
  const stepX = NODE_W + GAP * 2
  const stepY = NODE_H + GAP * 2
  for (let r = 0; r <= 8; r++) {
    // Visit the ring at Chebyshev distance r, preferring below, then right, then the rest.
    const ring: Pt[] = []
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push({ x: dx, y: dy })
    ring.sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - (Math.abs(b.x) + Math.abs(b.y)) || b.y - a.y || b.x - a.x)
    for (const d of ring) {
      const p = { x: start.x + d.x * stepX, y: start.y + d.y * stepY }
      if (!existing.some((e) => overlaps(e, p))) return p
    }
  }
  return { x: start.x + 40, y: start.y + 40 }
}
