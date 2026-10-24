/** Number of lane colours defined as --lane-N in styles.css (readable on light and dark). */
export const PALETTE_SIZE = 10;

/** Palette index → CSS value; layout colour indexes grow without bound, so wrap around. */
export function laneColor(index: number): string {
  const i = ((Math.trunc(index) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return `var(--lane-${i})`;
}
