import { describe, expect, it } from 'vitest';
import type { Widget } from '@regis/shared';
import { applyLayout, firstFreePosition, layoutDiffers, placeNewWidget, toLayout } from './layout';

function widget(id: string, x: number, y: number, w: number, h: number): Widget {
  return { id, dashboardId: 'd1', kind: 'jobs', title: id, configJson: {}, x, y, w, h };
}

describe('firstFreePosition', () => {
  it('starts at the origin on an empty grid', () => {
    expect(firstFreePosition([], { w: 3, h: 4 })).toEqual({ x: 0, y: 0 });
  });

  it('fills the gap on the first row before going down', () => {
    const widgets = [widget('a', 0, 0, 3, 4), widget('b', 6, 0, 3, 4)];

    expect(firstFreePosition(widgets, { w: 3, h: 4 })).toEqual({ x: 3, y: 0 });
  });

  it('goes below when no gap is wide enough', () => {
    const widgets = [widget('a', 0, 0, 3, 4), widget('b', 4, 0, 8, 4)];

    expect(firstFreePosition(widgets, { w: 3, h: 4 })).toEqual({ x: 0, y: 4 });
  });

  it('never overflows the 12 columns', () => {
    expect(firstFreePosition([widget('a', 0, 0, 12, 2)], { w: 20, h: 2 })).toEqual({ x: 0, y: 2 });
  });
});

describe('placeNewWidget', () => {
  it('uses the default size at the first free position', () => {
    const placed = placeNewWidget(
      [widget('a', 0, 0, 3, 4)],
      'd1',
      { kind: 'inbox', title: 'Boîtes', configJson: {} },
      { w: 3, h: 4 },
    );

    expect(placed).toMatchObject({ id: '', dashboardId: 'd1', kind: 'inbox', x: 3, y: 0, w: 3, h: 4 });
  });
});

describe('layout mapping', () => {
  it('exposes the minimum size of each kind to the grid', () => {
    const layout = toLayout([widget('a', 1, 2, 3, 4)], () => ({ w: 2, h: 3 }));

    expect(layout).toEqual([{ i: 'a', x: 1, y: 2, w: 3, h: 4, minW: 2, minH: 3 }]);
  });

  it('merges the positions reported by the grid back into the widgets', () => {
    const widgets = [widget('a', 0, 0, 3, 4), widget('b', 3, 0, 3, 4)];

    const merged = applyLayout(widgets, [{ i: 'b', x: 6, y: 2, w: 4, h: 5 }]);

    expect(merged[0]).toBe(widgets[0]);
    expect(merged[1]).toMatchObject({ id: 'b', x: 6, y: 2, w: 4, h: 5, title: 'b' });
  });

  it('detects when a position changed', () => {
    const widgets = [widget('a', 0, 0, 3, 4)];

    expect(layoutDiffers(widgets, [widget('a', 0, 0, 3, 4)])).toBe(false);
    expect(layoutDiffers(widgets, [widget('a', 0, 1, 3, 4)])).toBe(true);
  });
});
