export function graphContainerHasSize(
  container: Pick<HTMLElement, 'clientWidth' | 'clientHeight'> | null,
): boolean {
  return Boolean(container && container.clientWidth > 0 && container.clientHeight > 0);
}
