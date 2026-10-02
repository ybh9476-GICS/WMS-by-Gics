const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const sandbox = { window: { dispatchEvent() {} }, Event: class Event {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/warehouse-barcode-tunnel.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/warehouse-3d.js'), 'utf8'), sandbox);
const { buildLayout, createPassDetector, createScanRecord } = sandbox.window.WmsBarcodeTunnel;
const rect = (x, z, w, d, size = 500) => Array.from({ length: w * d }, (_, i) => ({ x: x + i % w * size, y: z + Math.floor(i / w) * size }));
const cv = [...rect(5000, 20000, 4, 24), ...rect(16000, 20000, 4, 24)];
const bt = [...rect(5000, 26000, 4, 5), ...rect(16000, 26000, 4, 5)];
const layout = buildLayout(bt, cv);
assert.equal(layout.length, 2);
layout.forEach(r => { assert.equal(r.width, 2); assert.equal(r.length, 2.5); assert.equal(r.axis, 'z'); });
assert.equal(buildLayout(rect(0, 0, 2, 5), rect(0, -500, 2, 7))[0].width, 1, 'Narrower sheet markings shrink the tunnel.');
assert.equal(buildLayout(rect(0, 0, 4, 2), rect(-1000, 0, 8, 2))[0].axis, 'x', 'Horizontal CV connections turn the tunnel.');
assert.equal(buildLayout(rect(0, 0, 4, 2), rect(0, -2000, 4, 10))[0].axis, 'z', 'Connections determine direction even for a short tunnel.');
assert.equal(buildLayout(rect(0, 0, 2, 3, 1000), rect(0, -1000, 2, 5, 1000), 1000)[0].length, 3);
assert.equal(buildLayout([]).length, 0);
const irregular = [...rect(0, 0, 2, 3), ...rect(1000, 0, 2, 1)];
assert.equal(buildLayout(irregular).reduce((sum, r) => sum + r.width * r.length, 0), irregular.length * 0.25, 'Do not build over unmarked gaps.');
const detect = createPassDetector(layout, 2.2);
const cargo = (z, y = 2.2, x = 6, id = 'P1') => [{ id, x, y, z }];
assert.equal(detect(cargo(25)).length, 0);
assert.equal(detect(cargo(26.1)).length, 1);
assert.equal(detect(cargo(27)).length, 0, 'A stopped or moving pallet inside must not repeatedly retrigger.');
assert.equal(detect(cargo(29)).length, 0);
assert.equal(detect(cargo(27)).length, 1, 'A returning pallet must scan again.');
detect([]);
assert.equal(detect(cargo(27, 4)).length, 0, 'Cargo above the conveyor must not trigger the scanner.');
detect(cargo(25));
assert.equal(detect(cargo(29)).length, 1, 'Detect an entire tunnel crossing between frames.');
assert.equal(detect(cargo(30)).length, 0);
assert.equal(detect(cargo(27, 2.2, 17, 'P2'))[0].index, 1, 'The two scanners operate independently.');
const data = sandbox.window.wmsWarehouse3D.convertGoogleSheetCsv({
    floorPlan: 'Y\\X,1,2,3\n1,CV,BT,CV',
    rackTypes: '랙타입코드,랙타입명,베이폭(m),깊이(m),전체높이(m),단수,단당높이(m)',
    zones: '구역코드,구역명,용도,기본랙타입코드',
    racks: '랙코드,구역코드,랙타입코드,방향,베이 수(가로 칸 수),평면도 랙 전체 길이(m),평면도 랙 깊이(m)',
    locations: '로케이션코드,랙코드,베이번호,단번호,깊이번호,최대수량',
    items: '품목코드,품목명,표시색상', inventory: '로케이션코드,품목코드,재고수량,재고상태',
    workOrders: '작업 코드,작업 구분,품목코드,수량(개)'
});
assert.equal(data.meta.barcodeTunnelCells.length, 1);
assert.equal(data.meta.conveyorCells.length, 3, 'Replacing CV with BT must preserve the continuous conveyor graph.');
assert.equal(data.meta.unmappedFloorRackCodes.length, 0);
const scanRecord = createScanRecord('JOB-001', {
    itemInfo: 'ITEM-01 · 테스트 품목 · 3개', destination: 'S02', barcode: '8801234567890'
}, new Date('2026-09-16T01:02:03.000Z'));
assert.equal(scanRecord.result, '정상 인식');
assert.equal(scanRecord.itemInfo, 'ITEM-01 · 테스트 품목 · 3개');
assert.equal(scanRecord.destination, 'S02');
assert.equal(scanRecord.barcode, '8801234567890');
assert.equal(scanRecord.passedAt, '2026-09-16T01:02:03.000Z');
const warehouse3dSource = fs.readFileSync(path.join(root, 'js/warehouse-3d.js'), 'utf8');
const operationSceneSource = fs.readFileSync(path.join(root, 'js/warehouse-operation-scene.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'css/warehouse-3d.css'), 'utf8');
assert(warehouse3dSource.includes("kind: 'barcode-tunnel-label'"), 'Scan tunnels expose an AMR-style selectable billboard.');
assert(warehouse3dSource.includes('data-warehouse-history="scan"'), 'The selected tunnel provides a history popup button.');
assert(warehouse3dSource.includes("'인식 상태', '도착지'"), 'Scan history labels the final rack location as 도착지.');
assert(warehouse3dSource.includes("workOrder?.finalLocationCode || '랙 로케이션 배정 대기'"), 'Scan history uses the reserved rack location instead of an intermediate station.');
assert(operationSceneSource.includes('job.order.finalLocationCode = slot.locationCode'), 'Operation planning exposes the reserved rack location to scan history.');
const resolverSource = warehouse3dSource.match(/const resolveBarcodeScanMetadata = cargoId => \{[\s\S]*?\n        \};/)[0];
const resolverContext = {
    workOrderByCode: new Map([
        ['IN-01', { direction: '입고', routeCode: 'IN', finalLocationCode: 'A01-W04-04-02-04' }],
        ['OUT-01', { direction: '출고', routeCode: 'OUT', finalLocationCode: 'A01-W01-01-01-01' }]
    ]),
    scanItemByCode: new Map(),
    data: { workOrders: [{ code: 'IN-01-P2', direction: '입고', routeCode: 'IN', barcode: 'HU-IN-01-P2', finalLocationCode: 'A01-W02-01-02-01' }] },
    scanRouteByCode: new Map([['OUT', { buffer: 'B03' }]])
};
vm.runInNewContext(`${resolverSource}\n inbound = resolveBarcodeScanMetadata('IN-01'); outbound = resolveBarcodeScanMetadata('OUT-01');`, resolverContext);
assert.equal(resolverContext.inbound.destination, 'A01-W04-04-02-04', 'Inbound scans retain the final rack location.');
assert.equal(resolverContext.outbound.destination, 'B03', 'Outbound scans show the AMR dropoff buffer, not the rack pickup location.');
vm.runInContext("extraPallet = resolveBarcodeScanMetadata('IN-01-P2');", resolverContext);
assert.equal(resolverContext.extraPallet.destination, 'A01-W02-01-02-01');
assert.equal(resolverContext.extraPallet.barcode, 'HU-IN-01-P2', 'Additional simulated pallets must retain their own scan metadata.');
assert(cssSource.includes('.warehouse-history-table-scroll') && cssSource.includes('overflow: auto'), 'Long histories scroll in the popup table.');
console.log('Barcode tunnel sizing, orientation, conveyor continuity and entry detection passed.');
