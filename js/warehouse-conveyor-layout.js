(function () {
  'use strict';
  const EPS = 1e-8;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const point = (a, u, t) => ({ x: a.x + u.x * t, y: a.y + u.y * t });
  const area = p => p.reduce((s, a, i) => s + cross(a, p[(i + 1) % p.length]), 0) / 2;
  function hull(points) {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const half = values => { const result = []; for (const p of values) { while (result.length > 1 && cross(sub(result.at(-1), result.at(-2)), sub(p, result.at(-1))) <= EPS) result.pop(); result.push(p); } return result; };
    return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
  }
  // All footprint pieces are convex and counter-clockwise. No drawing coordinates are snapped.
  function clip(poly, a, b, inside = true) {
    const result = [], direction = sub(b, a), sign = inside ? 1 : -1;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const dp = cross(direction, sub(p, a)) * sign, dq = cross(direction, sub(q, a)) * sign;
      if (dp >= -EPS) result.push(p);
      if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) result.push(point(p, sub(q, p), dp / (dp - dq)));
    }
    return result.length >= 3 && Math.abs(area(result)) > EPS ? result : [];
  }
  function subtract(poly, obstacle) {
    const result = []; let remaining = poly;
    for (let i = 0; i < obstacle.length && remaining.length; i++) {
      const a = obstacle[i], b = obstacle[(i + 1) % obstacle.length], outside = clip(remaining, a, b, false);
      if (outside.length) result.push(outside);
      remaining = clip(remaining, a, b);
    }
    return result;
  }
  function interval(a, u, length, poly) {
    let lo = 0, hi = length;
    for (let i = 0; i < poly.length; i++) {
      const edge = sub(poly[(i + 1) % poly.length], poly[i]), start = cross(edge, sub(a, poly[i])), rate = cross(edge, u);
      if (Math.abs(rate) < EPS) { if (start < -EPS) return null; }
      else if (rate > 0) lo = Math.max(lo, -start / rate);
      else hi = Math.min(hi, -start / rate);
      if (hi <= lo + EPS) return null;
    }
    return [lo, hi];
  }
  function removeInterval(intervals, removed) {
    if (!removed) return intervals;
    return intervals.flatMap(([a, b]) => removed[1] <= a + EPS || removed[0] >= b - EPS ? [[a, b]] :
      [[a, Math.min(b, removed[0])], [Math.max(a, removed[1]), b]].filter(([lo, hi]) => hi > lo + EPS));
  }
  function build(objects, pathSegments, segmentDirection = (o, line, index) => o.segmentDirections?.[line]?.[index] || o.flowDirection || 'forward', geometryOnly = false) {
    const footprints = [], endpoints = new Map(), junctions = [];
    for (const o of objects.filter(o => o.kind === 'CV')) for (const edge of pathSegments(o)) {
      const delta = sub(edge.b, edge.a), length = Math.hypot(delta.x, delta.y);
      if (length < EPS || !(o.width > 0)) continue;
      const u = { x: delta.x / length, y: delta.y / length }, n = { x: -u.y, y: u.x }, half = o.width / 2;
      const f = { id: o.id, lineId: edge.lineId, index: edge.index, reverse: segmentDirection(o, edge.lineId, edge.index) === 'reverse', a: edge.a, b: edge.b, u, n, length, width: o.width, angle: Math.atan2(u.y, u.x) };
      f.poly = [point(edge.a, n, -half), point(edge.b, n, -half), point(edge.b, n, half), point(edge.a, n, half)];
      footprints.push(f);
      for (const [p, sign] of [[edge.a, 1], [edge.b, -1]]) {
        const key = p.x.toFixed(7) + ':' + p.y.toFixed(7);
        if (!endpoints.has(key)) endpoints.set(key, []);
        endpoints.get(key).push({ p, u: { x: u.x * sign, y: u.y * sign }, incoming: sign === (f.reverse ? 1 : -1), f });
      }
    }
    // Fill the outside of a bend; a bounded miter avoids spikes at very sharp turns.
    for (const entries of endpoints.values()) {
      if (entries.length < 2) continue;
      const ports = entries.flatMap(e => [-1, 1].map(sign => point(e.p, { x: -e.u.y, y: e.u.x }, sign * e.f.width / 2)));
      const transferPorts = [...ports];
      if (entries.length === 2) {
        const [a, b] = entries, determinant = cross(a.u, b.u);
        if (Math.abs(determinant) > EPS) for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
          const pa = point(a.p, { x: -a.u.y, y: a.u.x }, sa * a.f.width / 2);
          const pb = point(b.p, { x: -b.u.y, y: b.u.x }, sb * b.f.width / 2);
          const ta = cross(sub(pb, pa), b.u) / determinant, tb = cross(sub(pb, pa), a.u) / determinant;
          const corner = point(pa, a.u, ta);
          if (Math.hypot(corner.x - a.p.x, corner.y - a.p.y) <= Math.max(a.f.width, b.f.width) * 2) {
            if (ta <= EPS && tb <= EPS) ports.push(corner);
            // Include the inside half too: the entire turn uses the incoming run's rollers.
            transferPorts.push(corner);
          }
        }
      }
      const poly = hull(ports);
      if (poly.length >= 3 && area(poly) > EPS) footprints.push({ ...entries[0].f, poly, joint: true });
      if (entries.some(e => Math.abs(cross(e.u, entries[0].u)) > EPS)) {
        // Flow decides the owner, independently of drawing order. Multiple incoming branches
        // use the existing path order as a deterministic tie-break; no routing is changed.
        const upstream = entries.find(e => e.incoming) || entries[0];
        junctions.push({ ...upstream.f, poly: hull(transferPorts), joint: true });
      }
    }
    if (geometryOnly) return footprints;
    const jointSurfaces = [];
    for (const junction of junctions) {
      let outside = [junction.poly];
      for (const f of footprints) outside = outside.flatMap(p => subtract(p, f.poly));
      if (!outside.length) jointSurfaces.push(junction);
      else for (const f of footprints) {
        // Short or sharp bends may not contain the full transfer patch. Clip it to the
        // existing footprint so changing roller direction never widens the conveyor.
        let poly = junction.poly;
        for (let i = 0; i < f.poly.length && poly.length; i++) poly = clip(poly, f.poly[i], f.poly[(i + 1) % f.poly.length]);
        if (poly.length) jointSurfaces.push({ ...junction, poly });
      }
    }
    const surfaces = [...jointSurfaces, ...footprints];
    // Join a transfer patch to collinear runs when their exact union is convex. This
    // keeps a continuous roller pitch instead of leaving a seam around an artificial patch.
    const overlapArea = (a, b) => area(a) - subtract(a, b).reduce((sum, p) => sum + area(p), 0);
    for (let i = 0; i < surfaces.length; i++) {
      for (let j = i + 1; j < surfaces.length; j++) {
        const a = surfaces[i], b = surfaces[j];
        if (Math.abs(cross(a.u, b.u)) > EPS) continue;
        const poly = hull([...a.poly, ...b.poly]), unionArea = area(a.poly) + area(b.poly) - overlapArea(a.poly, b.poly);
        if (Math.abs(area(poly) - unionArea) > EPS) continue;
        // Keep the priority of other turns, including a closed conveyor loop.
        if (surfaces.slice(i + 1, j).some(other => Math.abs(cross(a.u, other.u)) > EPS && overlapArea(poly, other.poly) > EPS)) continue;
        surfaces[i] = { ...a, poly }; surfaces.splice(j, 1); j = i;
      }
    }
    const models = new Map(), debug = { footprints: footprints.map(f => f.poly), joints: junctions.map(f => ({ id: f.id, lineId: f.lineId, index: f.index, angle: f.angle, poly: f.poly })), owned: [], rails: [], rollers: [], rollerOwners: [] };
    const model = id => { if (!models.has(id)) models.set(id, { id, position: [0, 0], angle: 0, layout: { cellSize: 500, modules: [], rails: [], parts: { steel: [], roller: [], yellow: [], rubber: [] }, supportCount: 0 } }); return models.get(id); };
    const add = (f, kind, p, y, sx, sy, sz, rx = 0, angle = f.angle) => model(f.id).layout.parts[kind].push({ x: p.x, y, z: p.y, sx, sy, sz, rx, rz: 0, ry: -angle });
    const candidates = [];
    surfaces.forEach((f, index) => {
      let owned = [f.poly];
      for (let j = 0; j < index && owned.length; j++) owned = owned.flatMap(p => subtract(p, surfaces[j].poly));
      debug.owned.push(...owned.map(poly => ({ id: f.id, poly })));
      const local = p => ({ x: dot(sub(p, f.a), f.u), y: dot(sub(p, f.a), f.n) });
      const world = (x, y) => point(point(f.a, f.u, x), f.n, y);
      // Slice the entire footprint, then subtract earlier runs. Slicing each convex fragment
      // separately would change roller spacing and leave artificial seams inside a junction.
      for (const polygon of owned.length ? [f.poly] : []) {
        const p = polygon.map(local), min = Math.min(...p.map(v => v.x)), max = Math.max(...p.map(v => v.x));
        const length = max - min, radius = Math.min(.035, length / 8, f.width / 8), inset = Math.min(.055, f.width * .12);
        if (radius < .001) continue;
        // Erode by the roller's actual bounding rectangle, so perpendicular rollers cannot intersect.
        const section = (x, alongInset, crossInset) => {
          let lo = -Infinity, hi = Infinity;
          for (let j = 0; j < p.length; j++) {
            const a = p[j], b = p[(j + 1) % p.length], dx = b.x - a.x, dy = b.y - a.y;
            const value = dy * (x - a.x) + Math.abs(dy) * alongInset + Math.abs(dx) * crossInset;
            if (Math.abs(dx) < EPS) { if (-dy * (x - a.x) < Math.abs(dy) * alongInset - EPS) return null; }
            else if (dx > 0) lo = Math.max(lo, a.y + value / dx);
            else hi = Math.min(hi, a.y + value / dx);
          }
          return hi - lo > .01 ? [lo, hi] : null;
        };
        const obstacles = surfaces.slice(0, index).map(other => other.poly.map(local));
        const expanded = (alongInset, crossInset) => obstacles.map(poly => hull(poly.flatMap(v => [-1, 1].flatMap(x => [-1, 1].map(y => ({ x: v.x + x * alongInset, y: v.y + y * crossInset }))))));
        const rollerObstacles = expanded(radius, inset), braceObstacles = expanded(.025, inset);
        const sections = (x, alongInset, obstacles) => {
          const span = section(x, alongInset, inset); if (!span) return [];
          let spans = [span];
          for (const obstacle of obstacles) {
            const covered = interval({ x, y: span[0] }, { x: 0, y: 1 }, span[1] - span[0], obstacle);
            if (covered) spans = removeInterval(spans, covered.map(y => y + span[0]));
          }
          return spans.filter(([lo, hi]) => hi - lo > .01);
        };
        const count = Math.max(1, Math.floor(length / (radius * 3.2)));
        for (let i = 0; i < count; i++) {
          const x = min + (i + .5) * length / count;
          for (const span of sections(x, radius, rollerObstacles)) {
            add(f, 'roller', world(x, (span[0] + span[1]) / 2), 1 - radius, radius, span[1] - span[0], radius, Math.PI / 2);
            debug.rollers.push([world(x - radius, span[0]), world(x + radius, span[0]), world(x + radius, span[1]), world(x - radius, span[1])]);
            debug.rollerOwners.push({ id: f.id, lineId: f.lineId, index: f.index, angle: f.angle });
          }
        }
        const supports = Math.max(2, Math.ceil(length / 1.5) + 1), endInset = Math.min(.12, length / 4);
        for (let i = 0; i < supports; i++) {
          const x = min + endInset + (length - endInset * 2) * i / (supports - 1);
          for (const span of sections(x, .025, braceObstacles)) for (const height of [.3, .85]) add(f, 'steel', world(x, (span[0] + span[1]) / 2), height, .05, .045, span[1] - span[0]);
        }
      }
    });
    footprints.forEach((f, index) => {
      for (let e = 0; e < f.poly.length; e++) {
        // Terminal ends remain open for loading, as in the original conveyor model.
        if (!f.joint && e % 2 === 1) continue;
        const a = f.poly[e], b = f.poly[(e + 1) % f.poly.length], d = sub(b, a), length = Math.hypot(d.x, d.y);
        const u = { x: d.x / length, y: d.y / length }, outward = { x: u.y, y: -u.x };
        let spans = [[0, length]];
        for (let j = 0; j < footprints.length && spans.length; j++) if (j !== index) spans = removeInterval(spans, interval(point(a, outward, .00001), u, length, footprints[j].poly));
        for (const [lo, hi] of spans) candidates.push({ f, a: point(a, u, lo), b: point(a, u, hi), u, outward });
      }
    });
    // Merge collinear outer edges (including duplicate CV objects) before adding rails or legs.
    const lines = new Map();
    for (const c of candidates) {
      let u = c.u; if (u.x < -EPS || (Math.abs(u.x) < EPS && u.y < 0)) u = { x: -u.x, y: -u.y };
      const n = { x: -u.y, y: u.x }, offset = dot(c.a, n), side = Math.sign(dot(c.outward, n));
      const key = [u.x, u.y, offset, side].map(v => v.toFixed(6)).join(':');
      if (!lines.has(key)) lines.set(key, { ...c, u, n, offset, spans: [] });
      lines.get(key).spans.push([Math.min(dot(c.a, u), dot(c.b, u)), Math.max(dot(c.a, u), dot(c.b, u))]);
    }
    const legs = [];
    for (const line of lines.values()) {
      const merged = [];
      for (const span of line.spans.sort((a, b) => a[0] - b[0])) { const last = merged.at(-1); if (last && span[0] <= last[1] + .00003) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
      for (const [lo, hi] of merged) {
        const length = hi - lo; if (length < .001) continue;
        const world = t => ({ x: line.u.x * t + line.n.x * line.offset, y: line.u.y * t + line.n.y * line.offset });
        const angle = Math.atan2(line.u.y, line.u.x), middle = point(world((lo + hi) / 2), line.outward, -.0225);
        add(line.f, 'steel', middle, .90, length, .16, .045, 0, angle);
        add(line.f, 'yellow', middle, .99, length, .04, .045, 0, angle);
        debug.rails.push({ a: world(lo), b: world(hi), outward: line.outward });
        const count = Math.max(2, Math.ceil(length / 1.5) + 1), inset = Math.min(.12, length / 4);
        for (let i = 0; i < count; i++) {
          const p = point(world(lo + inset + (length - inset * 2) * i / (count - 1)), line.outward, -.055);
          if (legs.some(q => Math.hypot(p.x - q.x, p.y - q.y) < .17)) continue;
          legs.push(p); model(line.f.id).layout.supportCount++;
          add(line.f, 'steel', p, .445, .065, .83, .065, 0, angle);
          add(line.f, 'rubber', p, .015, .12, .03, .12, 0, angle);
        }
      }
    }
    // Preserve the original factory, including instance matrices, for a single straight run.
    if (footprints.length === 1) {
      const f = footprints[0], length = f.length, width = f.width;
      models.set(f.id, { id: f.id, position: [(f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2], angle: f.angle,
        layout: { cellSize: 500, modules: [{ axis: 'x', minX: -length * 500, maxX: length * 500, minY: -width * 500, maxY: width * 500, length: length * 1000, width: width * 1000 }],
          rails: [-1, 1].map(side => ({ axis: 'x', x: 0, y: side * width * 500, dx: 0, dy: side, length: length * 1000 })) } });
    }
    return { models: [...models.values()], debug };
  }
  const footprints = (objects, pathSegments) => build(objects.map(o => ({ ...o, kind: 'CV' })), pathSegments, undefined, true);
  window.WmsWarehouseConveyorLayout = { build, subtract, area, footprints };
})();
