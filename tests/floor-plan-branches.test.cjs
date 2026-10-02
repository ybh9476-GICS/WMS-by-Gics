const assert = require('assert/strict');
const M = require('../js/floor-plan-model.js');

function branched(kind) {
  return {
    id: kind + '01',
    kind,
    points: [{ x: 2, y: 4 }, { x: 10, y: 4 }, { x: 18, y: 4 }],
    branches: [
      { id: 'B1', from: 1, points: [{ x: 10, y: 10 }, { x: 15, y: 12 }] },
      { id: 'B2', from: 1, points: [{ x: 6, y: 10 }] }
    ],
    width: 1.5,
    cap: 'butt',
    locked: false
  };
}

for (const kind of ['T', 'GR', 'CV', 'ST']) {
  const plan = M.blank();
  plan.objects = [branched(kind)];
  const read = M.read(plan);
  const path = read.objects[0];

  assert.equal(M.pathLines(path).length, 3, kind + ' exposes its main path and two branches');
  assert.equal(M.polygons(path).length, 9, kind + ' renders branch segments and joints');
  assert.ok(M.totalPathLength(path) > M.pathLength(path), kind + ' total length includes branches');
  assert.deepEqual(M.read(JSON.parse(JSON.stringify(read))), read, kind + ' survives a plan JSON roundtrip');
  assert.deepEqual(M.readFile(JSON.parse(M.serializeFile(read))), read, kind + ' survives a .gics roundtrip');

  const before = M.clone(path);
  const beforeLength = M.totalPathLength(path);
  M.move(path, 5, 5);
  const dx = path.points[0].x - before.points[0].x;
  const dy = path.points[0].y - before.points[0].y;
  assert.equal(path.branches[0].points[0].x - before.branches[0].points[0].x, dx);
  assert.equal(path.branches[0].points[0].y - before.branches[0].points[0].y, dy);
  M.rotate(path);
  assert.equal(path.branches.length, 2);
  assert.ok(Math.abs(M.totalPathLength(path) - beforeLength) < 1e-7, kind + ' keeps length after move and rotate');
}

const plan = M.blank();
const base = {
  id: 'T01',
  kind: 'T',
  points: [{ x: 2, y: 2 }, { x: 8, y: 2 }],
  width: 1,
  cap: 'butt',
  locked: false
};

const invalidBranches = [
  [{ id: 'BAD', from: 0, points: [{ x: 4, y: 4 }] }],
  [{ id: 'B1', from: 4, points: [{ x: 4, y: 4 }] }],
  [{ id: 'B1', from: 0, points: [] }],
  [{ id: 'B1', from: 0, points: [{ x: 2, y: 2 }] }],
  [
    { id: 'B1', from: 0, points: [{ x: 3, y: 3 }] },
    { id: 'B1', from: 1, points: [{ x: 7, y: 3 }] }
  ]
];
for (const branches of invalidBranches) {
  assert.throws(() => M.read({ ...plan, objects: [{ ...base, branches }] }), /분기/);
}

const tooManyPoints = Array.from({ length: 99 }, (_, index) => ({ x: 3 + index * 0.01, y: 3 }));
assert.throws(
  () => M.read({ ...plan, objects: [{ ...base, branches: [{ id: 'B1', from: 0, points: tooManyPoints }] }] }),
  /합계 100개/
);

const recursivePlan = M.blank();
recursivePlan.objects = [{
  id: 'TREC',
  kind: 'T',
  points: [{ x: 2, y: 4 }, { x: 10, y: 4 }, { x: 20, y: 4 }],
  branches: [
    { id: 'B1', from: 1, points: [{ x: 10, y: 8 }, { x: 14, y: 10 }] },
    { id: 'B2', parent: 'B1', from: 2, points: [{ x: 16, y: 14 }, { x: 18, y: 16 }] },
    { id: 'B3', from: 1, points: [{ x: 6, y: 9 }] }
  ],
  width: 1,
  cap: 'butt',
  locked: false
}];
const recursive = M.read(recursivePlan).objects[0];
const recursiveLines = new Map(M.pathLines(recursive).map(line => [line.id, line]));
assert.deepEqual(recursiveLines.get('B1').labels, ['2', '2-1', '2-2']);
assert.deepEqual(recursiveLines.get('B2').labels, ['2-2', '2-2-1', '2-2-2']);
assert.deepEqual(recursiveLines.get('B3').labels, ['2', '2-3']);
assert.equal(M.branchLabel(recursive, 'B2'), '2-2-1 ~ 2-2-2');
const nestedSource = M.pathPointRef(recursive, 'B2', 0);
nestedSource.points[nestedSource.index] = { x: 15, y: 11 };
assert.deepEqual(M.pathLines(recursive).find(line => line.id === 'B2').points[0], { x: 15, y: 11 });
assert.deepEqual(M.readFile(JSON.parse(M.serializeFile({ ...recursivePlan, objects: [recursive] }))).objects[0], recursive);

for (const branches of [
  [{ id: 'B1', parent: 'B9', from: 0, points: [{ x: 4, y: 5 }] }],
  [
    { id: 'B1', parent: 'B2', from: 0, points: [{ x: 4, y: 5 }] },
    { id: 'B2', parent: 'B1', from: 0, points: [{ x: 5, y: 6 }] }
  ],
  [
    { id: 'B1', from: 1, points: [{ x: 8, y: 5 }] },
    { id: 'B2', parent: 'B1', from: 5, points: [{ x: 9, y: 6 }] }
  ]
]) {
  assert.throws(() => M.read({ ...plan, objects: [{ ...base, branches }] }), /분기/);
}
const legacy = M.read({ ...plan, objects: [base] }).objects[0];
assert.deepEqual(legacy, base, 'an old single path remains byte-shape compatible without an empty branches field');

const scan = branched('CV');
assert.equal(M.pathLength(scan), 16, 'main path length remains the scan-tunnel distance reference');
assert.equal(M.atDistance(scan, 15).x, 17, 'scan-tunnel offset still follows the main path');

for (const kind of ['T', 'GR', 'CV']) {
  const closedPlan = M.blank();
  closedPlan.objects = [{
    id: kind + 'CLOSED', kind, width: 1, cap: 'butt', locked: false, closed: true,
    points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }]
  }];
  const closed = M.read(closedPlan).objects[0];
  assert.equal(M.pathLines(closed)[0].points.length, 5, kind + ' adds the closing segment without duplicating stored points');
  assert.deepEqual(M.pathLines(closed)[0].points.at(-1), closed.points[0]);
  assert.equal(M.pathSegments(closed).length, 4);
  assert.equal(M.totalPathLength(closed), 24);
  assert.deepEqual(M.readFile(JSON.parse(M.serializeFile(M.read(closedPlan)))).objects[0], closed, kind + ' closed path survives .gics');
}

const connectedPlan = M.blank();
connectedPlan.objects = [{
  id: 'GRLINK', kind: 'GR', width: 1, cap: 'butt', locked: false,
  points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
  branches: [{ id: 'B1', from: 0, points: [], target: { line: 'main', index: 2 } }]
}];
const connected = M.read(connectedPlan).objects[0];
assert.equal(M.pathLines(connected).find(line => line.id === 'B1').points.length, 2, 'a direct connection reuses both existing points');
assert.equal(M.connectionCycleSize({ ...connected, branches: [] }, { line: 'main', index: 0 }, { line: 'main', index: 2 }), 3, 'cycle size includes the existing route and new link');
assert.deepEqual(M.readFile(JSON.parse(M.serializeFile(M.read(connectedPlan)))).objects[0], connected, 'connected branch survives .gics');
const selfClosedPlan = M.blank();
selfClosedPlan.objects = [{
  id: 'CVLOOP', kind: 'CV', width: 1, cap: 'butt', locked: false,
  points: [{ x: 2, y: 2 }, { x: 8, y: 2 }],
  branches: [{ id: 'B1', from: 0, points: [{ x: 5, y: 6 }, { x: 8, y: 6 }], target: { line: 'main', index: 0 } }]
}];
const selfClosed = M.read(selfClosedPlan).objects[0];
assert.equal(M.pathLines(selfClosed).find(line => line.id === 'B1').points.length, 4, 'a branch can close back to its own start after two new points');
assert.equal(M.connectionCycleSize({ ...selfClosed, branches: [] }, { line: 'main', index: 0 }, { line: 'main', index: 0 }, 2), 3);

const crossing = M.blank();
crossing.objects = [{
  id: 'TCROSS', kind: 'T', width: 1, cap: 'butt', locked: false, closed: true,
  points: [{ x: 2, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }, { x: 8, y: 2 }]
}];
assert.throws(() => M.read(crossing), /겹치거나 교차/);
assert.throws(() => M.read({ ...connectedPlan, objects: [{ ...connectedPlan.objects[0], branches: [{ id: 'B1', from: 0, points: [], target: { line: 'main', index: 1 } }] }] }), /세 지점|겹치거나 교차|연결/);

console.log('Floor-plan branches: recursive and closed geometry, point connections, crossing guards, legacy ST compatibility, transform, and .gics roundtrip passed.');
