const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const M = require('../js/floor-plan-model.js'), window = {};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../js/warehouse-conveyor-layout.js'), 'utf8'), { window });
const api = window.WmsWarehouseConveyorLayout;
const cv = (id, points, width = 1) => ({ id, kind: 'CV', width, points: points.map(([x, y]) => ({ x, y })) });
const fixtures = {
  straight: [cv('CV1', [[0, 0], [5, 0]])],
  corner: [cv('CV1', [[0, 0], [5, 0], [5, 5]])],
  tee: [cv('CV1', [[0, 0], [5, 0], [10, 0]]), cv('CV2', [[5, 0], [5, 5]])],
  cross: [cv('CV1', [[0, 0], [10, 0]]), cv('CV2', [[5, -5], [5, 5]])],
  diagonal: [cv('CV1', [[0, 0], [5, 0], [8, 4]])],
  acute: [cv('CV1', [[0, 0], [5, 0], [1, .5]])],
  duplicate: [cv('CV1', [[0, 0], [5, 0]]), cv('CV2', [[5, 0], [0, 0]])],
  partial: [cv('CV1', [[0, 0], [5, 0]]), cv('CV2', [[2, 0], [8, 0]])],
  short: [cv('CV1', [[0, 0], [.3, 0], [.3, .3], [.6, .3]])],
  differentWidths: [cv('CV1', [[0, 0], [5, 0]], 1.5), cv('CV2', [[5, 0], [5, 5]], .8)],
  loop: [cv('CV1', [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]])]
};
const polygonArea = p => Math.abs(api.area(p));
function intersectionArea(a, b) { return polygonArea(a) - api.subtract(a, b).reduce((sum, p) => sum + polygonArea(p), 0); }
for (const [name, objects] of Object.entries(fixtures)) {
  const before = JSON.stringify(objects), result = api.build(objects, M.pathSegments), { owned, rollers, footprints, rails } = result.debug;
  assert.equal(JSON.stringify(objects), before, name + ': drawing must not change');
  assert.ok(rollers.length && rails.length, name + ': visible parts');
  for (let i = 0; i < owned.length; i++) for (let j = 0; j < i; j++) assert.ok(intersectionArea(owned[i].poly, owned[j].poly) < 1e-7, name + ': duplicated surface');
  for (const footprint of footprints) {
    let remaining = [footprint];
    for (const piece of owned) remaining = remaining.flatMap(p => api.subtract(p, piece.poly));
    assert.ok(remaining.reduce((sum, p) => sum + polygonArea(p), 0) < 1e-7, name + ': missing surface');
  }
  for (let i = 0; i < rollers.length; i++) for (let j = 0; j < i; j++) assert.ok(intersectionArea(rollers[i], rollers[j]) < 1e-7, name + ': rollers intersect');
  for (const rail of rails) {
    // A rail must have free space immediately outside it, including at branches and crossings.
    const p = { x: (rail.a.x + rail.b.x) / 2 + rail.outward.x * .0001, y: (rail.a.y + rail.b.y) / 2 + rail.outward.y * .0001 };
    for (const poly of footprints) assert.ok(!poly.every((a, i) => { const b = poly[(i + 1) % poly.length]; return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) > 1e-8; }), name + ': rail blocks another conveyor');
  }
  for (const model of result.models) for (const parts of Object.values(model.layout.parts || {})) for (const part of parts) assert.ok(Object.values(part).every(Number.isFinite), name + ': non-finite geometry');
  if (name === 'corner') assert.ok(Math.abs(owned.reduce((sum, p) => sum + polygonArea(p.poly), 0) - 10) < 1e-7);
  if (name === 'duplicate') assert.equal(rollers.length, api.build(fixtures.straight, M.pathSegments).debug.rollers.length);
  console.log('PASS conveyor joint:', name, rollers.length, 'non-overlapping rollers');
}
module.exports = fixtures;

// The turn square must belong entirely to the incoming leg, including the half that
// used to be owned by the outgoing rectangle. Verify actual roller boxes, not just metadata.
const turn = [cv('CV1', [[0, 0], [5, 0], [5, 5]])];
const corner = [{ x: 4.5, y: -.5 }, { x: 5.5, y: -.5 }, { x: 5.5, y: .5 }, { x: 4.5, y: .5 }];
function assertTurn(objects, expectedId, expectedIndex, expectedAngle, region = corner) {
  const result = api.build(objects, M.pathSegments, M.segmentDirection), hits = [];
  result.debug.rollers.forEach((poly, i) => { if (intersectionArea(poly, region) > 1e-7) hits.push(result.debug.rollerOwners[i]); });
  assert.ok(hits.length >= 4, 'corner must contain a full set of rollers');
  for (const owner of hits) {
    assert.equal(owner.id, expectedId); assert.equal(owner.index, expectedIndex);
    assert.ok(Math.abs(Math.sin(owner.angle - expectedAngle)) < 1e-8, 'entire turn must use incoming roller orientation');
  }
  // Direction changes must preserve the physical footprint and perimeter.
  return JSON.stringify(result.debug.rails);
}
const forwardRails = assertTurn(turn, 'CV1', 0, 0);
assert.equal(assertTurn([{ ...turn[0], flowDirection: 'reverse' }], 'CV1', 1, Math.PI / 2), forwardRails);
assert.equal(assertTurn([{ ...turn[0], flowDirection: 'forward', segmentDirections: { main: { 0: 'reverse', 1: 'reverse' } } }], 'CV1', 1, Math.PI / 2), forwardRails);
// Outgoing object is intentionally stored first; array order must not choose the owner.
assertTurn([cv('OUT', [[5, 0], [5, 5]]), cv('IN', [[0, 0], [5, 0]])], 'IN', 0, 0);
assertTurn([{ ...cv('BRANCH', [[0, 0], [5, 0]]), branches: [{ id: 'B1', from: 1, points: [{ x: 5, y: 5 }] }], flowDirection: 'reverse' }], 'BRANCH', 0, Math.PI / 2);
// A rotated turn follows the same rule without snapping to X/Z axes.
const rotate = p => ({ x: p.x * Math.cos(.6) - p.y * Math.sin(.6), y: p.x * Math.sin(.6) + p.y * Math.cos(.6) });
assertTurn([{ ...turn[0], points: turn[0].points.map(rotate) }], 'CV1', 0, .6, corner.map(rotate));
console.log('PASS conveyor direction: full upstream turn, reverse flow, per-edge override, object order, reverse branch and rotated corner; perimeter unchanged');
