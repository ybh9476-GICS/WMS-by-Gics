const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const Ops = require('../js/warehouse-operations.js');
// Vehicle transfer completion is independent of rack putaway or AMR delivery.
for (const [direction, action, effect] of [['입고', '하차', 'truck-unload'], ['출고', '상차', 'truck-load']]) {
    const jobs = [0, 1].map(() => ({ route: { dock: 'D01', direction } }));
    assert.equal(Ops.truckProgress(jobs, 'D01', direction), `${action} 대기`);
    jobs[0].steps = [{ effect, started: true }];
    assert.equal(Ops.truckProgress(jobs, 'D01', direction), `${action} 중`);
    jobs[0].truckTransferComplete = true;
    assert.equal(Ops.truckProgress(jobs, 'D01', direction), `${action} 중`, 'Partial transfer must not finish the vehicle.');
    jobs[1].truckTransferComplete = true;
    assert.equal(Ops.truckProgress(jobs, 'D01', direction), `${action} 완료`);
    assert.equal(Ops.truckProgress(jobs, 'D02', direction), `${action} 대기`, 'An empty dock must not report complete.');
}
const ctx = { window: { dispatchEvent() {} }, Event: class {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require.resolve('../js/warehouse-3d.js'), 'utf8'), ctx);
const api = ctx.window.wmsWarehouse3D;
const cells = require('./fixtures/warehouse-operation-floor.json');
const select = value => cells.filter(c => c.value === value);
const regions = prefix => Ops.regions(cells.filter(c => c.value.startsWith(prefix) && c.value !== 'ST').map(c => ({ ...c, code: c.value })), 500);
const clearance = api.calculateAmrPassageClearanceMm(select('T'), 500, 1950);
const networks = { buffers: regions('B'), docks: regions('D'), stations: regions('S'),
    amrGraph: api.buildPassageNavigationGraph(select('T'), 500, clearance),
    conveyorGraph: api.buildPassageNavigationGraph(select('CV'), 500, 920), cellSize: 500 };
const actualConveyorPaths = [];
for (const route of [
    { dock: 'D01', buffer: 'B01', station: 'S02' },
    { dock: 'D02', buffer: 'B02', station: 'S03' },
    { dock: 'D03', buffer: 'B03', station: 'S01' }
]) {
    const compiled = Ops.compileRoute(route, networks);
    actualConveyorPaths.push(compiled.conveyorPath?.map(p => ({ x: p.x / 1000, y: 1, z: p.y / 1000 })));
    assert.ok(!compiled.error, JSON.stringify({ route, error: compiled.error }));
    assert.ok(compiled.amrPath.length > 2 && compiled.conveyorPath.length > 2);
    for (const [graph, path] of [[networks.amrGraph, compiled.amrPath], [networks.conveyorGraph, compiled.conveyorPath]]) {
        path.slice(1).forEach((node, i) => assert.ok(graph.nodesByKey.get(path[i].key).neighbors.includes(node.key)));
    }
}
assert.match(Ops.compileRoute({ dock: 'D01', buffer: 'B02', station: 'S02' }, networks).error, /T 통로/);
assert.match(Ops.compileRoute({ dock: 'D99', buffer: 'B01', station: 'S02' }, networks).error, /위치/);
assert.match(Ops.compileRoute({ dock: 'D01', buffer: 'B01', station: 'S02' }, { ...networks, conveyorGraph: { nodes: [], nodesByKey: new Map() } }).error, /CV/);

const staged = Ops.arrangeRegionQueue(
    { minX: 0, maxX: 2200, minY: 0, maxY: 2200, centerX: 1100, centerY: 1100 },
    5,
    { width: 1000, depth: 1000 },
    { gap: 100, margin: 0, entryX: 0, entryY: 0 }
);
assert.equal(staged.length, 5);
assert.equal(staged[0].perLayer, 4, 'A 2.2m square must hold four 1m pallets with 0.1m gaps per layer.');
assert.equal(staged[4].layer, 1, 'Overflow must continue at the same footprint on the next layer.');
assert.equal(staged[4].x, staged[0].x);
assert.equal(staged[4].y, staged[0].y);
for (const point of staged.slice(0, 4)) {
    assert.ok(point.x >= 500 && point.x <= 1700 && point.y >= 500 && point.y <= 1700, 'Every pallet footprint must stay inside the region.');
}
assert.ok(Math.hypot(staged[0].x, staged[0].y) <= Math.hypot(staged[3].x, staged[3].y), 'The queue must fill from the entry side.');
const departureOrder = Ops.topFirstQueueOrder(staged);
assert.deepEqual(departureOrder, [4, 0, 1, 2, 3], 'The upper pallet must depart before the ground layer.');
const stackedJobs = staged.map((place, index) => ({ id: `STACK-${index}`, index, place }));
const stackSim = new Ops.Simulation({ actors: [], jobs: stackedJobs,
    prepare: (job, simulation) => {
        // A delayed upper pallet must not let the lower pallet escape underneath it.
        if (job.index === 4 && simulation.elapsed < 0.5) return null;
        const rank = departureOrder.indexOf(job.index);
        return { cargo: { owner: 'dock:D01', position: { x: job.index * 10, y: job.place.layer, z: 0 } }, steps: [{
            startOwner: 'conveyor', entryQueue: 'D01', entryOrder: rank, entryInterval: 5,
            waitForJobs: departureOrder.slice(0, rank).map(index => `STACK-${index}`), label: '진입', duration: 0.1
        }] };
    } });
stackSim.tick(0.25);
assert.ok(stackSim.jobs.every(job => !Number.isFinite(job.conveyorEnteredAt)), 'Lower pallets must wait when the upper pallet is not ready.');
stackSim.tick(25);
const admitted = [...stackSim.jobs].sort((a, b) => a.conveyorEnteredAt - b.conveyorEnteredAt);
assert.deepEqual(admitted.map(job => job.index), departureOrder);
admitted.slice(1).forEach((job, index) => assert.ok(job.conveyorEnteredAt - admitted[index].conveyorEnteredAt >= 5 - 1e-8));

const events = [];
const route = { code: 'IN01', direction: '입고', amr: 'AMR-002', buffer: 'B01', station: 'S02' };
const sim = new Ops.Simulation({
    actors: [{ code: route.amr, kind: 'amr', enabled: true, online: true, speed: 1, radius: 0.4, position: { x: 0, y: 0, z: 0 } }],
    jobs: [1, 2].map(i => ({ id: `JOB${i}`, route, itemCode: 'ITEM', quantity: 3 })),
    prepare: job => ({ reservations: ['buffer:B01', `actor:${route.amr}`],
        cargo: { owner: 'buffer:B01', position: { x: 0, y: 0, z: 0 }, dimensions: [1, 0.8, 1] },
        steps: [{ actor: route.amr, owner: route.amr, label: '상차', duration: 0.2 },
            { actor: route.amr, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }], label: '운반' },
            { actor: route.amr, owner: 'station:S02', position: { x: 0, y: 0, z: 2 }, label: '하차', effect: 'drop' }] }),
    onEvent: (event, job) => events.push(`${job.id}:${event}`)
});
sim.tick(0.1); sim.tick(0.1);
assert.equal(sim.jobs[0].cargo.owner, route.amr);
assert.equal(sim.jobs[1].steps, null, 'Occupied destination must block a second job.');
sim.actors.get(route.amr).online = false;
const held = { ...sim.actors.get(route.amr).position };
for (let i = 0; i < 20; i++) sim.tick(0.1);
assert.deepEqual(sim.actors.get(route.amr).position, held);
assert.equal(sim.jobs[0].cargo.owner, route.amr, 'Offline carrier must keep its load.');
assert.ok(sim.locks.size, 'Offline carrier keeps reservations.');
sim.actors.get(route.amr).online = true;
sim.paused = true; sim.tick(0.1); assert.deepEqual(sim.actors.get(route.amr).position, held);
sim.paused = false;
for (let i = 0; i < 250; i++) sim.tick(0.1);
assert.ok(sim.jobs.every(j => j.done));
assert.equal(sim.locks.size, 0);
assert.equal(events.filter(e => e.endsWith(':drop')).length, 2);
assert.deepEqual(sim.jobs[0].cargo.dimensions, [1, 0.8, 1]);
assert.equal(sim.jobs[0].cargo.owner, 'station:S02');
assert.equal(sim.jobs[0].quantity, 3);
assert.ok(events.indexOf('JOB1:complete') < events.indexOf('JOB2:started'));
const forkSim = new Ops.Simulation({
    actors: [{ code: route.amr, kind: 'amr', enabled: true, online: true, speed: 1, position: { x: 1, y: 0, z: 2 } }],
    jobs: [{ id: 'FORK', route }],
    prepare: () => ({ reservations: [], cargo: { owner: 'buffer:B01', position: { x: 1, y: 1, z: 2 } }, steps: [
        { actor: route.amr, pose: { yaw: Math.PI / 2, forkHeight: 1, forkExtension: 0.5 }, label: '상차 준비' },
        { actor: route.amr, owner: route.amr, duration: 0.2, label: '상차' }
    ] })
});
forkSim.tick(0.1);
assert.equal(forkSim.jobs[0].cargo.owner, 'buffer:B01', 'Cargo stays at the source while forks align.');
for (let i = 0; i < 30; i++) forkSim.tick(0.1);
const forkActor = forkSim.actors.get(route.amr);
assert.deepEqual(forkActor.position, { x: 1, y: 0, z: 2 }, 'Fork alignment must not translate the vehicle.');
assert.ok(Math.abs(forkActor.yaw - Math.PI / 2) < 0.001);
assert.equal(forkActor.forkHeight, 1);
assert.equal(forkActor.forkExtension, 0.5);
assert.equal(forkSim.jobs[0].cargo.owner, route.amr);
// Equal wall time must give equal travel at high and low display frame rates.
function travelAt(frameSeconds, speed, conveyor = false) {
    const simulation = new Ops.Simulation({
        actors: conveyor ? [] : [{ code: 'A', enabled: true, online: true, speed, position: { x: 0, y: 0, z: 0 } }],
        jobs: [{ id: 'SPEED' }],
        prepare: () => ({ cargo: { position: { x: 0, y: 0, z: 0 } }, steps: [
            { actor: conveyor ? null : 'A', speed: conveyor ? speed : undefined,
                path: [{ x: 0, y: 0, z: 100 }], label: '운반' }
        ] })
    });
    for (let i = 0; i < Math.round(2 / frameSeconds); i++) simulation.tick(frameSeconds);
    const moving = conveyor ? simulation.jobs[0].cargo : simulation.actors.get('A');
    assert.ok(Math.abs(simulation.elapsed - 2) < 1e-8, 'Low frame rates must not discard elapsed time.');
    assert.ok(Math.abs(moving.position.z - 2 * speed) < 1e-8, 'Distance must equal configured m/s × elapsed seconds.');
}
for (const frame of [1 / 60, 0.25, 0.5]) {
    for (const speed of [0.3, 1, 2]) travelAt(frame, speed);
    travelAt(frame, 1.5, true);
}
const operationScene = fs.readFileSync(require.resolve('../js/warehouse-operation-scene.js'), 'utf8');
// Reproduce the old array-order starvation: a new outbound job used to take a just-freed route
// before an inbound job that had already waited. Fair requests must reverse that outcome.
function reservationOrder(fairAcquire) {
    const claims = [];
    const queue = new Ops.Simulation({ actors: [], jobs: ['IN', 'OUT1', 'OUT2'].map(id => ({ id })),
        prepare: job => ({ cargo: { position: { x: 0, y: 0, z: 0 } }, steps: [
            ...(job.id !== 'OUT1' ? [{ duration: 0.05, label: '도착' }] : []),
            { acquire: ['shared'], fairAcquire, effect: 'claim', label: '배정' },
            { duration: 0.2, release: ['shared'], label: '운반' }
        ] }), onEvent: (event, job) => { if (event === 'claim') claims.push(job.id); } });
    for (let i = 0; i < 100; i++) queue.tick(0.05);
    assert.ok(queue.jobs.every(job => job.done));
    assert.equal(queue.locks.size, 0);
    assert.equal(queue.reservationWaiters.size, 0);
    return claims;
}
assert.deepEqual(reservationOrder(false), ['OUT1', 'OUT2', 'IN']);
assert.deepEqual(reservationOrder(true), ['OUT1', 'IN', 'OUT2']);
const track = (x, y, z, endX, endZ) => [{ x, y, z }, { x: endX, y, z: endZ }];
const shuttleTracks = [track(0, 0, 0, 4, 0), track(2, 0, -2, 2, 2), track(0, 0, 8, 4, 8), track(0, 2, 0, 4, 0)];
const routeKeys = shuttleTracks.map(path => Ops.shuttleRouteResources([path]));
assert.ok(routeKeys[0].some(key => routeKeys[1].includes(key)), 'Crossing footprints on one level must conflict.');
assert.ok(!routeKeys[0].some(key => routeKeys[2].includes(key)), 'Disjoint routes must not block the entire ST network.');
assert.ok(!routeKeys[0].some(key => routeKeys[3].includes(key)), 'Different rack levels may run concurrently.');
const tripSim = new Ops.Simulation({ actors: shuttleTracks.map((path, index) => ({ code: `SH${index}`, kind: 'shuttle',
    enabled: true, online: true, speed: 1, radius: 0.43, position: path[0] })),
    jobs: shuttleTracks.map((_, index) => ({ id: `TRIP${index}`, index })),
    prepare: job => ({ cargo: { position: shuttleTracks[job.index][0] }, steps: [
        { actor: `SH${job.index}`, acquire: routeKeys[job.index], fairAcquire: true, path: shuttleTracks[job.index], label: '운반' },
        { actor: `SH${job.index}`, path: shuttleTracks[job.index].slice().reverse(), release: routeKeys[job.index], releaseActor: true, label: '복귀' }
    ] }) });
tripSim.tick(0.05);
assert.equal([...tripSim.actors.values()].filter(actor => actor.job).length, 3, 'Nonconflicting routes and levels must move together.');
assert.equal(tripSim.actors.get('SH1').status, '합류·리프트 대기', 'Blocked billboards must show waiting rather than the last transfer state.');
for (let i = 0; i < 500; i++) {
    tripSim.tick(0.05);
    const fleet = [...tripSim.actors.values()];
    fleet.forEach((a, index) => fleet.slice(index + 1).forEach(b => {
        if (Math.abs(a.position.y - b.position.y) < 0.4) assert.ok(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) >= 0.774 - 1e-8);
    }));
}
assert.ok(tripSim.jobs.every(job => job.done), 'Crossing shuttle trips must finish without deadlock.');
assert.equal(tripSim.locks.size, 0);
assert.equal(tripSim.reservationWaiters.size, 0);
assert.ok(!operationScene.includes("'ST:transport'"), 'The scene must not reserve the whole shuttle network.');
assert.match(operationScene, /fairAcquire: true/);
const originals = [{ code: 'W1', status: '대기', barcode: 'HU-1', quantity: 3 }, { code: 'DONE', status: '완료' }];
const doubled = Ops.expandSimulationOrders(originals);
assert.equal(doubled.length, 3);
assert.equal(originals.length, 2, 'Simulation expansion must not alter the supplied master orders.');
assert.equal(doubled[2].quantity, 3, 'Increase pallet count, not units on a pallet.');
assert.notEqual(doubled[2].code, originals[0].code);
assert.notEqual(doubled[2].barcode, originals[0].barcode);
const position = (x, z) => ({ x, y: 1, z });
// Admission intervals apply per entry, pause with simulation time, and keep loads moving in parallel.
for (const frame of [1 / 60, 0.5]) {
    const entrySim = new Ops.Simulation({ actors: [],
        jobs: [0, 1].flatMap(stream => [0, 1, 2].map(index => ({ id: `ENTRY-${stream}-${index}`, stream, index }))),
        prepare: job => ({ cargo: { owner: 'buffer', position: position(job.stream * 10, 0), dimensions: [1, 0.8, 1] }, steps: [
            { conveyor: true, speed: 1.5, startOwner: 'conveyor', entryQueue: `entry:${job.stream}`,
                entryOrder: job.index, entryInterval: 5, path: [position(job.stream * 10, 0)], label: '진입' },
            { conveyor: true, speed: 1.5, path: [position(job.stream * 10, 40)], label: '운반' }
        ] }) });
    entrySim.tick(frame);
    assert.equal(entrySim.jobs.filter(job => job.cargo.owner === 'conveyor').length, 2, 'Different entries may admit independently.');
    assert.ok(entrySim.jobs.some(job => job.status === '컨베이어 투입 간격 대기'));
    const elapsed = entrySim.elapsed;
    entrySim.paused = true; entrySim.tick(20);
    assert.equal(entrySim.elapsed, elapsed, 'Paused wall time must not advance the admission timer.');
    entrySim.paused = false;
    for (let i = 0; i < Math.ceil(11 / frame); i++) entrySim.tick(frame);
    for (const stream of [0, 1]) {
        const entries = entrySim.jobs.filter(job => job.stream === stream);
        assert.ok(entries.every(job => Number.isFinite(job.conveyorEnteredAt)));
        entries.slice(1).forEach((job, index) => assert.ok(job.conveyorEnteredAt - entries[index].conveyorEnteredAt >= 5 - 1e-8));
        assert.ok(Math.abs(entries[0].cargo.position.z - (entrySim.elapsed - entries[0].conveyorEnteredAt) * 1.5) < 1e-8, 'Admission waiting must not slow an admitted pallet.');
    }
}
const mainLane = [position(0, 0), position(0, 12), position(12, 12)];
const mergeLane = [position(-8, 12), position(12, 12)];
const junctions = Ops.conveyorJunctions([mainLane, mergeLane]);
assert.ok(junctions.some(p => p.x === 0 && p.z === 12), 'Crossings and turns need junction protection.');
assert.ok(Ops.opposingConveyorPaths(mainLane, mainLane.slice().reverse()));
assert.ok(!Ops.opposingConveyorPaths(mainLane, mergeLane));
function verifyConveyorFlow(lanes) {
    const flow = new Ops.Simulation({ actors: [], jobs: lanes.flatMap((lane, stream) =>
        Array.from({ length: 4 }, (_, index) => ({ id: `CV-${stream}-${index}`, stream, index }))),
        prepare: job => {
            const lane = lanes[job.stream], start = lane[0];
            const options = { conveyor: true, speed: 3, clearance: 0.3,
                junctions: Ops.conveyorJunctions(lanes), lanePath: lane };
            return { cargo: { owner: 'dock', position: start, dimensions: [1, 0.8, 1] }, steps: [
                { ...options, path: [start], acquire: [`entry:${job.stream}`], startOwner: 'conveyor', release: [`entry:${job.stream}`],
                    entryQueue: `entry:${job.stream}`, entryOrder: job.index, label: '진입' },
                { ...options, path: lane, label: '운반' },
                { owner: 'buffer', acquire: ['buffer'], duration: 0.2, label: '인계', conveyor: true, lanePath: lane },
                { owner: 'consumed', duration: 2, label: '상차', release: ['buffer'] }
            ] };
        } });
    let peak = 0, spacingWait = false, mergeWait = false;
    for (let i = 0; i < 6000 && !flow.jobs.every(job => job.done); i++) {
        flow.tick(0.05);
        const carrying = flow.jobs.filter(job => job.cargo?.owner === 'conveyor');
        peak = Math.max(peak, carrying.length);
        spacingWait ||= flow.jobs.some(job => job.status === '컨베이어 간격 대기');
        mergeWait ||= flow.jobs.some(job => job.status === '컨베이어 합류 대기');
        for (let a = 0; a < carrying.length; a++) for (let b = a + 1; b < carrying.length; b++) {
            const p = carrying[a].cargo.position, q = carrying[b].cargo.position;
            assert.ok(Math.abs(p.x - q.x) >= 1.3 - 1e-8 || Math.abs(p.z - q.z) >= 1.3 - 1e-8,
                'Conveyor pallets must retain 0.3m clear space, including merges and turns.');
        }
    }
    assert.ok(peak >= 3, 'Following pallets must enter before the first one completes its conveyor journey.');
    assert.ok(spacingWait || mergeWait, 'A full buffer must make upstream pallets wait safely.');
    assert.ok(flow.jobs.every(job => job.done), `Merging or opposing traffic must recover without deadlock: ${JSON.stringify(flow.jobs.filter(job => !job.done).map(job => ({id:job.id,status:job.status,stage:job.stage,p:job.cargo.position})))}`);
    assert.equal(flow.locks.size, 0);
}
verifyConveyorFlow([mainLane]);
verifyConveyorFlow([mainLane, mergeLane]);
verifyConveyorFlow([mainLane, mainLane.slice().reverse()]);
verifyConveyorFlow(actualConveyorPaths.map((path, index) => index === 2 ? path.slice().reverse() : path));
// Each carrier records its own handoff, sharing the same item and barcode.
const historySim = new Ops.Simulation({
    startedAt: Date.parse('2026-09-16T00:00:00Z'),
    actors: ['AMR', 'SHUTTLE'].map(code => ({ code, enabled: true, online: true, speed: 1, position: { x: 0, y: 0, z: 0 } })),
    jobs: [{ id: 'HISTORY' }],
    prepare: () => ({ cargo: { owner: 'buffer:B01', position: { x: 0, y: 0, z: 0 } },
        transports: [
            { actor: 'AMR', from: 'B01', to: 'S02', itemInfo: 'P-1003 · 펌프 · 3개', barcode: 'HU-001' },
            { actor: 'SHUTTLE', from: 'S02', to: 'A01-W01-01-01-01', itemInfo: 'P-1003 · 펌프 · 3개', barcode: 'HU-001' }
        ], steps: [
            { actor: 'AMR', owner: 'AMR', duration: 0.2, label: '상차' },
            { actor: 'AMR', owner: 'station:S02', duration: 0.2, label: '하차' },
            { actor: 'AMR', duration: 0.2, label: '복귀', releaseActor: true },
            { actor: 'SHUTTLE', owner: 'SHUTTLE', duration: 0.2, label: '상차' },
            { actor: 'SHUTTLE', owner: 'rack:A01-W01-01-01-01', duration: 0.2, label: '랙 적치', releaseActor: true }
        ] })
});
historySim.tick(0.05);
const amrHistory = historySim.actors.get('AMR').transportHistory[0];
const shuttleHistory = historySim.actors.get('SHUTTLE').transportHistory[0];
assert.equal(amrHistory.loadedAt, null, 'Pending loading must not fabricate a timestamp.');
assert.equal(shuttleHistory.status, '배정 대기');
historySim.actors.get('AMR').online = false;
historySim.tick(0.3);
assert.equal(amrHistory.status, '작업 보류');
assert.equal(amrHistory.loadedAt, null);
historySim.actors.get('AMR').online = true;
historySim.tick(0.15);
assert.ok(amrHistory.loadedAt);
assert.equal(amrHistory.unloadedAt, null);
historySim.tick(2);
assert.equal(amrHistory.status, '완료', 'Returning empty must not overwrite completed transport.');
assert.equal(shuttleHistory.status, '완료');
assert.equal(amrHistory.barcode, shuttleHistory.barcode);
assert.equal(amrHistory.to, shuttleHistory.from);
assert.ok(amrHistory.assignedAt < amrHistory.loadedAt && amrHistory.loadedAt < amrHistory.unloadedAt);
assert.ok(amrHistory.unloadedAt < shuttleHistory.loadedAt && shuttleHistory.loadedAt < shuttleHistory.unloadedAt);
assert.equal(historySim.actors.get('AMR').transportHistory.length, 1);
assert.match(operationScene, /const conveyorSpeed = 1\.5;/, 'The conveyor must move at 1.5m\/s.');
assert.match(operationScene, /speed: amr\.configuredSpeed/, 'AMR speed must continue to come from equipment master data.');
assert.match(operationScene, /speed: shuttle\.configuredSpeed/, 'Shuttle speed must continue to come from equipment master data.');
assert.match(operationScene, /operationQueuePolicy = 'entry-nearest-row-major-then-next-layer'/);
console.log('Warehouse operation routes, handoffs, reservations, offline recovery and frame-independent speeds passed.');
