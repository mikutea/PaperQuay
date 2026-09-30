export function graphNodeTextColor(container: HTMLElement): string {
  // Production CSS may shorten rgba theme tokens to #RRGGBBAA, which
  // Cytoscape does not parse. Computed `color` resolves them to rgb/rgba.
  return getComputedStyle(container).color || '#1c1917';
}
