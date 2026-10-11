(function () {
  'use strict';
  function build(objects, pathSegments) {
    const geometry = window.WmsWarehouseConveyorLayout;
    const paths = objects.filter(o => o.kind === 'GR' || o.kind === 'ST');
    const width = o => Math.min(.07, o.width * .14);
    const outer = geometry.footprints(paths, pathSegments);
    const inner = geometry.footprints(paths.map(o => ({ ...o, width: o.width - 2 * width(o) })), pathSegments);
    const pieces = [];
    // A rail is the difference between the complete outer and inner corridors.
    // Both outlines share joined corners: no independent beam ends cross a turn,
    // and the outer corner stays connected. Open path ends remain open for transfer.
    outer.forEach((footprint, index) => {
      let remaining = [footprint.poly];
      for (const obstacle of [...inner, ...outer.slice(0, index)]) {
        remaining = remaining.flatMap(poly => geometry.subtract(poly, obstacle.poly));
        if (!remaining.length) break;
      }
      pieces.push(...remaining.map(poly => ({ id: footprint.id, poly })));
    });
    return { pieces, outer: outer.map(f => f.poly), inner: inner.map(f => f.poly) };
  }
  window.WmsWarehouseShuttleRails = { build };
})();
