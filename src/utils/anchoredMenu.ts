export interface MenuAnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface AnchoredMenuPlacement {
  left: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
  top?: number;
  bottom?: number;
}

export function placeAnchoredMenu(input: {
  anchor: MenuAnchorRect;
  viewportWidth: number;
  viewportHeight: number;
  preferredWidth: number;
  preferredMaxHeight?: number;
  minUsefulHeight?: number;
  gap?: number;
  padding?: number;
}): AnchoredMenuPlacement {
  const padding = input.padding ?? 12;
  const gap = input.gap ?? 6;
  const preferredMaxHeight = input.preferredMaxHeight ?? 420;
  const minUsefulHeight = input.minUsefulHeight ?? 220;
  const width = Math.min(
    Math.max(0, input.viewportWidth - padding * 2),
    Math.max(input.preferredWidth, Math.round(input.anchor.width)),
  );
  const left = Math.max(padding, Math.min(input.anchor.left, input.viewportWidth - width - padding));
  const spaceBelow = Math.max(0, input.viewportHeight - input.anchor.bottom - gap - padding);
  const spaceAbove = Math.max(0, input.anchor.top - gap - padding);
  const placement = spaceBelow < minUsefulHeight && spaceAbove > spaceBelow ? 'above' : 'below';
  const maxHeight = Math.min(preferredMaxHeight, placement === 'above' ? spaceAbove : spaceBelow);

  return placement === 'above'
    ? {
        placement,
        left,
        width,
        maxHeight,
        bottom: input.viewportHeight - input.anchor.top + gap,
      }
    : {
        placement,
        left,
        width,
        maxHeight,
        top: input.anchor.bottom + gap,
      };
}
