// The Go core emits a numeric `Lane.color` palette slot (domain.proto); the
// renderer owns the slot → CSS color mapping so theming can change without a
// contract change. Slots map onto the semantic graph-lane tokens, so the lane
// palette follows the theme with no code change.
export const LANE_PALETTE: readonly string[] = [
  'var(--st-color-graph-lane-1)',
  'var(--st-color-graph-lane-2)',
  'var(--st-color-graph-lane-3)',
  'var(--st-color-graph-lane-4)',
  'var(--st-color-graph-lane-5)',
  'var(--st-color-graph-lane-6)',
  'var(--st-color-graph-lane-7)',
  'var(--st-color-graph-lane-8)',
];

/** Map a lane palette slot to a concrete color (wraps around, tolerant of junk). */
export function laneColor(slot: number): string {
  if (!Number.isFinite(slot) || slot < 0) return LANE_PALETTE[0];
  return LANE_PALETTE[Math.trunc(slot) % LANE_PALETTE.length];
}
