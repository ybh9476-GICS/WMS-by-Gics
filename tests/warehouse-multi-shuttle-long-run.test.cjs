const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('../output/three-0.185.1.cjs');
const model = require('../js/floor-plan-model.js');
const operations = require('../js/warehouse-operations.js');

let session;
const window = {
    WmsFloorPlanModel: model, WmsWarehouseOperations: operations,
    WmsWarehouseConveyorLayout: { build: () => ({ models: [] }) },
    WmsWarehouseShuttleRails: { build: () => ({ pieces: [] }) },
    WmsSimulationControls: { markup: () => '', update: () => {} },
    WmsSimulationSession: { attach(value) { session = value; return () => {}; }, publish() {} }
};
class Element {
    constructor() { this.dataset = {}; this.classList = { add() {} }; this.style = { setProperty() {} }; }
    append() {} prepend() {} setAttribute() {} addEventListener() {}
    querySelector() { return new Element(); }
}
const panel = new Element(), utilization = new Element(), available = new Element();
const shellRoot = { querySelector(selector) {
    if (selector === '.warehouse-3d-bottom-panel') return panel;
    if (selector === '[data-warehouse-kpi="utilization"]') return utilization;
    if (selector.startsWith('[data-warehouse-kpi="available"]')) return available;
    return null;
} };
const viewport = new Element(); viewport.closest = () => shellRoot;
const document = { hidden: false, createElement: () => new Element() };
let randomState = 0x51a7e;
const seededMath = Object.create(Math);
seededMath.random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 0x100000000);
const context = vm.createContext({ window, document, console, Math: seededMath });
for (const file of ['warehouse-drawing', 'warehouse-route-preview', 'warehouse-drawing-scene'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file + '.js'), 'utf8'), context);

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, '../output/floor-plan.gics'), 'utf8')).plan;
const equipment = plan.objects.filter(object => model.equipmentKinds.includes(object.kind));
const actors = equipment.map(object => {
    const suffix = object.id.match(/\d+$/)[0].padStart(3, '0');
    return { ...object, code: object.kind === 'SH' ? `4SHUTTLE-${suffix}` : `AMR-${suffix}`,
        master: { enabled: true, configuredSpeed: 1 }, status: { communicationStatus: 'ONLINE' } };
});
const rackPositions = [
    ['W01', 3.6, 5.5], ['W02', 12.4, 5.5], ['W03', 3.6, 10.5], ['W04', 12.4, 10.5]
];
const rackEntries = rackPositions.map(([code, x, z], rackIndex) => {
    const group = new THREE.Group(); group.updateMatrixWorld(true);
    return { rack: { code }, group, slots: Array.from({ length: 10 }, (_, index) => {
        const level = index + 1, occupied = (rackIndex + index) % 2 === 0;
        return { locationCode: `${code}-L${level}`, group, position: [x, 1.2 + index, z],
            palletBaseY: 1.3 + index, boxSize: [0.8, 0.7, 0.8], level,
            type: { levelHeight: 1000 }, location: { capacity: 10 }, occupied,
            stock: occupied ? { itemCode: 'P-1001', quantity: 3, status: 'normal' } : null };
    }) };
});
const routes = [
    { code: 'IN01', enabled: true, direction: '입고', dock: 'D01', buffer: 'B02', station: 'S02', amr: 'AMR-002' },
    { code: 'IN02', enabled: true, direction: '입고', dock: 'D02', buffer: 'B03', station: 'S03', amr: 'AMR-003' },
    { code: 'OUT01', enabled: true, direction: '출고', dock: 'D03', buffer: 'B01', station: 'S01', amr: 'AMR-001' }
];
const workOrders = routes.map((route, index) => ({ code: `LONG-${index}`, direction: route.direction,
    status: '대기', equipmentCode: route.amr, itemCode: 'P-1001', quantity: 3, routeCode: route.code }));
const data = { meta: { plan, actors }, rackTypes: [{ levels: 10, levelHeight: 1000 }],
    racks: rackPositions.map(([code]) => ({ code })), items: [{ code: 'P-1001', color: '#c79555' }],
    operationRoutes: routes, workOrders };
const scene = new THREE.Group();
const label = () => new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.Texture() }));
const env = { THREE, shell: { viewport, zoneButtons: new Element() }, data, scene,
    signal: new AbortController().signal, rackEntries, warehouseFloorElevation: 1.2,
    amrFleet: [], shuttleFleet: [],
    originalShuttleFrame: { frameHeight: 0.1, frameOffset: 0,
        frameMaterial: new THREE.MeshStandardMaterial(), deckMaterial: new THREE.MeshStandardMaterial() },
    createLabel: label,
    createTaskLoad({ loadAnchor }) {
        const load = new THREE.Group();
        load.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.8), new THREE.MeshStandardMaterial()));
        load.setStorageState = () => {}; loadAnchor.add(load); return load;
    },
    createDrawingEquipment() { const group = new THREE.Group(), tag = label();
        tag.userData.amr = { state: '대기', equipmentStatus: '대기' }; scene.add(group);
        return { group, label: tag }; },
    createDrawingLift: () => ({ platform: new THREE.Group() }),
    setSlotInstanceVisible() {}, slotVisualState: () => ({ visible: true, opacity: 1, color: '#c79555' }),
    isLevelFocused: () => false
};
const mount = window.WmsWarehouseDrawingScene.mount(env);
session.play();
const totals = [];
let longestSafetyWait = 0, safetySince = new Map(), maxActiveInbound = 0;
const bufferArrivals = { B02: new Set(), B03: new Set() };
for (let time = 0; time <= 720000; time += 100) {
    mount.update(time);
    if (time % 1000) continue;
    const jobs = JSON.parse(viewport.dataset.operationJobs);
    for (const job of jobs) {
        for (const code of ['B02', 'B03']) if (job.cargoOwner === `buffer:${code}`) bufferArrivals[code].add(job.id);
    }
    for (const job of jobs) {
        if (job.status === '안전 거리 대기') {
            if (!safetySince.has(job.id)) safetySince.set(job.id, time);
            longestSafetyWait = Math.max(longestSafetyWait, (time - safetySince.get(job.id)) / 1000);
        } else safetySince.delete(job.id);
    }
    maxActiveInbound = Math.max(maxActiveInbound,
        ...['D01', 'D02'].map(code => jobs.filter(job => job.direction === '입고'
            && job.route === (code === 'D01' ? 'IN01' : 'IN02') && !job.done).length));
    if ([300000, 600000, 720000].includes(time))
        totals.push({ time, ...JSON.parse(viewport.dataset.operationCycleTotals),
            B02: bufferArrivals.B02.size, B03: bufferArrivals.B03.size,
            D01Entries: jobs.filter(job => job.route === 'IN01' && Number.isFinite(job.conveyorEnteredAt)).length,
            D02Entries: jobs.filter(job => job.route === 'IN02' && Number.isFinite(job.conveyorEnteredAt)).length });
}
assert.equal(session.snapshot().status, 'running');
assert.ok(totals[0].출고 >= 4, 'Outbound work must complete before five minutes.');
assert.ok(totals[1].출고 > totals[0].출고 && totals[2].출고 > totals[1].출고,
    'Outbound work must keep progressing after five and ten minutes.');
assert.ok(totals[1].입고 > totals[0].입고 && totals[2].입고 > totals[1].입고,
    'Inbound work must keep progressing after five and ten minutes.');
assert.ok(totals.every(sample => Math.abs(sample.D01Entries - sample.D02Entries) <= 2
    && Math.abs(sample.B02 - sample.B03) <= 3),
    `The two inbound buffers must receive similar numbers of cartons throughout the run: ${JSON.stringify(totals)}`);
assert.ok(totals[0].입고 >= 12 && totals[2].입고 >= 30,
    'Balancing inbound buffers must preserve useful throughput.');
assert.ok(longestSafetyWait < 60, 'No shuttle may remain in a safety-distance wait for a full minute.');
assert.ok(maxActiveInbound <= 12, 'Each inbound lane must have bounded active work.');
mount.dispose();
console.log('PASS 12-minute multi-shuttle flow', JSON.stringify({ totals, longestSafetyWait, maxActiveInbound }));
