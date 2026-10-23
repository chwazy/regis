import type { Widget } from '@regis/shared';

export const GRID_COLUMNS = 12;

const FALLBACK_MIN_SIZE = { w: 1, h: 1 };
const MAX_SCAN_ROWS = 1000;

export interface Size {
  w: number;
  h: number;
}

export interface Placement extends Size {
  i: string;
  x: number;
  y: number;
  minW?: number;
  minH?: number;
}

type Box = Pick<Widget, 'x' | 'y' | 'w' | 'h'>;

export function toLayout(widgets: Widget[], minSizeOf: (kind: string) => Size | undefined): Placement[] {
  return widgets.map((widget) => {
    const min = minSizeOf(widget.kind) ?? FALLBACK_MIN_SIZE;
    return { i: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h, minW: min.w, minH: min.h };
  });
}

export function applyLayout(widgets: Widget[], layout: readonly Placement[]): Widget[] {
  const placements = new Map(layout.map((placement) => [placement.i, placement]));
  return widgets.map((widget) => {
    const placement = placements.get(widget.id);
    return placement === undefined
      ? widget
      : { ...widget, x: placement.x, y: placement.y, w: placement.w, h: placement.h };
  });
}

export function layoutDiffers(widgets: Widget[], next: Widget[]): boolean {
  return widgets.some((widget, index) => {
    const other = next[index];
    return (
      other === undefined ||
      widget.x !== other.x ||
      widget.y !== other.y ||
      widget.w !== other.w ||
      widget.h !== other.h
    );
  });
}

function overlaps(left: Box, right: Box): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  );
}

export function firstFreePosition(widgets: Box[], size: Size): { x: number; y: number } {
  const width = Math.min(size.w, GRID_COLUMNS);
  for (let y = 0; y < MAX_SCAN_ROWS; y += 1) {
    for (let x = 0; x + width <= GRID_COLUMNS; x += 1) {
      const candidate = { x, y, w: width, h: size.h };
      if (!widgets.some((widget) => overlaps(candidate, widget))) {
        return { x, y };
      }
    }
  }
  return { x: 0, y: widgets.reduce((bottom, widget) => Math.max(bottom, widget.y + widget.h), 0) };
}

export function placeNewWidget(
  existing: Widget[],
  dashboardId: string,
  draft: Pick<Widget, 'kind' | 'title' | 'configJson'>,
  size: Size,
): Widget {
  const { x, y } = firstFreePosition(existing, size);
  return { id: '', dashboardId, ...draft, x, y, w: Math.min(size.w, GRID_COLUMNS), h: size.h };
}
