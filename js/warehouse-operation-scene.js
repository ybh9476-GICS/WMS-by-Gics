(function () {
    'use strict';
    window.createWarehouseOperationScene = function (env) {
        const { THREE, shell, data, scene, signal, amrFleet, shuttleFleet, shuttleLiftEntries, rackEntries,
            passageNavigation, shuttleNavigation, buildPassageNavigationGraph, createTaskLoad,
            setSlotInstanceVisible, warehouseFloorElevation: floorY, shuttleTravelBaseOffset,
            shuttleBodyCenterY, shuttleFrameHeight, setForkHeight, setForkExtension, stackerDimensions, travelForkHeight, isLevelFocused, slotVisualState } = env;
        const Ops = window.WmsWarehouseOperations;
        const conveyorSpeed = 1.5; // m/s; AMR and shuttle speeds come from the equipment master.
        const conveyorEntryInterval = 5; // Minimum seconds between successful admissions at each D/B entry.
        const size = data.meta?.floorPlanCellSize || 500;
        const routes = data.operationRoutes.filter(r => r.enabled).sort((a, b) => a.priority - b.priority);
        const buffers = Ops.regions(data.meta?.bufferCells || [], size);
        const docks = Ops.regions(data.meta?.dockCells || [], size);
        const stations = Ops.regions(data.meta?.stationCells || [], size);
        const slots = rackEntries.flatMap(r => r.slots);
        const sampleWidth = Math.max(0.1, ...slots.map(s => Math.max(s.boxSize[0], s.boxSize[2])));
        const sampleHeight = Math.max(0.1, ...slots.map(s => s.boxSize[1]));
        const conveyorGraph = buildPassageNavigationGraph(data.meta?.conveyorCells || [], size, sampleWidth * 1000);
        const networks = { buffers, docks, stations, amrGraph: passageNavigation, conveyorGraph, cellSize: size };
        const compiled = new Map(routes.map(r => [r.code, Ops.compileRoute(r, networks)]));
        const lifts = new Map(shuttleLiftEntries.map(l => [l.stationCode, l]));
        const models = new Map([...amrFleet, ...shuttleFleet].map(a => [a.equipmentCode, a]));
        const equipment = new Map((data.equipment || []).map(a => [a.code, a]));
        const actorTypes = new Map(amrFleet.map(a => [a.equipmentCode, 'amr']));
        shuttleFleet.forEach(s => actorTypes.set(s.equipmentCode, 'shuttle'));
        const yShuttle = floorY + shuttleTravelBaseOffset;
        const pos = (x, y, z) => ({ x, y, z });
        const asPoints = (nodes, y) => nodes.map(n => pos(n.x / 1000, y, n.y / 1000));
        const reverse = path => path.slice().reverse();
        const pointAt = (region, height = floorY) => pos(region.centerX / 1000, height, region.centerY / 1000);
        const line = (a, b) => [a, pos(b.x, a.y, a.z), b].filter((p, i, list) => !i || Math.hypot(p.x - list[i - 1].x, p.y - list[i - 1].y, p.z - list[i - 1].z) > 0.0001);
        const simplify = path => path.filter((p, i) => !i || i === path.length - 1
            || Math.abs((p.x - path[i - 1].x) * (path[i + 1].z - p.z) - (p.z - path[i - 1].z) * (path[i + 1].x - p.x)) > 0.00001
            || p.y !== path[i - 1].y || p.y !== path[i + 1].y);
        const cvJunctions = Ops.conveyorJunctions([...compiled.values()].filter(layout => !layout.error)
            .map(layout => simplify(asPoints(layout.conveyorPath, floorY + 1))));
        const shuttlePath = (lift, node, height) => {
            const nodes = Ops.pathBetween(shuttleNavigation, lift.node, node);
            if (!nodes.length) return [];
            const path = asPoints(nodes, height);
            return simplify([...line(pos(lift.x, height, lift.z), path[0]), ...path.slice(1)]);
        };
        const slotWorld = slot => slot.group.localToWorld(new THREE.Vector3(slot.position[0], slot.palletBaseY, slot.position[2]));
        const slotTargets = slots.map(slot => {
            const p = slotWorld(slot);
            const nodes = shuttleNavigation.nodes.filter(n => Math.hypot(n.x / 1000 - p.x, n.y / 1000 - p.z) <= sampleWidth + size / 1000 + 0.01);
            nodes.sort((a, b) => Math.hypot(a.x / 1000 - p.x, a.y / 1000 - p.z) - Math.hypot(b.x / 1000 - p.x, b.y / 1000 - p.z));
            return { slot, p, node: nodes[0] };
        }).filter(t => t.node);
        const actors = [];
        amrFleet.forEach(amr => {
            const route = routes.find(r => r.amr === amr.equipmentCode);
            const layout = route && compiled.get(route.code);
            if (layout && !layout.error) {
                const node = route.direction === '입고' ? layout.nearBuffer : layout.nearStation;
                amr.group.position.set(node.x / 1000, floorY, node.y / 1000);
                amr.currentKey = node.key;
            }
            amr.state = 'waiting'; amr.carriedLoad?.removeFromParent(); amr.carriedLoad = null;
            actors.push({ code: amr.equipmentCode, kind: 'amr', position: amr.group.position,
                enabled: equipment.get(amr.equipmentCode)?.enabled === true, online: amr.communicationStatus === 'ONLINE',
                speed: amr.configuredSpeed, radius: passageNavigation.vehicleDiameter / 2000, forkHeight: travelForkHeight, forkExtension: 0 });
        });
        shuttleFleet.forEach((shuttle, index) => {
            shuttle.load.visible = false;
            // The fourth shuttle waits above its lift, outside the ground handoff occupied by the first.
            const sameLiftBefore = shuttleFleet.slice(0, index).some(s => s.lift === shuttle.lift);
            const height = sameLiftBefore ? Math.max(...shuttle.lift.levelStops) : 0;
            shuttle.group.position.set(shuttle.lift.x, yShuttle + height, shuttle.lift.z);
            actors.push({ code: shuttle.equipmentCode, kind: 'shuttle', position: shuttle.group.position,
                home: shuttle.lift.stationCode, enabled: equipment.get(shuttle.equipmentCode)?.enabled === true,
                online: shuttle.communicationStatus === 'ONLINE', speed: shuttle.configuredSpeed, radius: 0.43 });
        });
        data.workOrders = Ops.expandSimulationOrders(data.workOrders || []);
        const jobs = [];
        routes.forEach(route => {
            let routeSequence = 0;
            (data.workOrders || []).filter(w => w.routeCode === route.code && !['완료', '취소'].includes(w.status)).forEach(w => {
                jobs.push({ id: w.code, route, routeSequence: routeSequence++, itemCode: w.itemCode, quantity: w.quantity, order: w });
            });
        });
        const routeJobCounts = new Map(routes.map(route => [route.code, jobs.filter(job => job.route.code === route.code).length]));
        const dockQueues = new Map();
        routes.forEach(route => {
            const layout = compiled.get(route.code);
            if (layout.error) return;
            const queue = Ops.arrangeRegionQueue(layout.dock, routeJobCounts.get(route.code),
                { width: sampleWidth * 1000, depth: sampleWidth * 1000 }, {
                    gap: 100, margin: 100, entryX: layout.conveyorPath[0].x, entryY: layout.conveyorPath[0].y
                });
            dockQueues.set(route.code, queue);
            const routeJobs = jobs.filter(job => job.route.code === route.code);
            routeJobs.forEach(job => { job.dockPlace = queue[job.routeSequence]; });
            if (route.direction !== '입고') return;
            const departures = Ops.topFirstQueueOrder(queue).map(index => routeJobs[index]);
            departures.forEach((job, index) => {
                job.dockEntryOrder = index;
                job.dockEntryPredecessors = departures.slice(0, index).map(previous => previous.id);
            });
        });
        const jobVisuals = new Map();
        const visualMaterials = new Set();
        signal.addEventListener('abort', () => { visualMaterials.forEach(material => material.dispose()); jobVisuals.forEach(visual => visual.removeFromParent()); }, { once: true });
        const ownershipPositions = new Map();
        const move = (actor, path, label, extra = {}) => ({ actor, path: simplify(path), label, ...extra });
        const transfer = (owner, position, label, extra = {}) => ({ owner, position, label, duration: 1.5, ...extra });
        const prepare = (job, sim) => {
            const route = job.route, layout = compiled.get(route.code), lift = lifts.get(route.station);
            if (layout.error) return { error: layout.error };
            if (!lift) return { error: `${route.station} 리프트 연결 확인` };
            if (job.order.equipmentCode !== route.amr || job.order.direction !== route.direction) return { error: '작업지시와 운영 경로 불일치' };
            if (!(job.quantity > 0) || !data.items.some(i => i.code === job.itemCode)) return { error: '작업 품목·수량 확인' };
            const amr = sim.actors.get(route.amr);
            if (!amr?.enabled || !amr.online || !(amr.speed > 0)) return { error: `${route.amr} 사용·통신·속도 확인` };
            const available = [...sim.actors.values()].filter(a => a.kind === 'shuttle' && a.enabled && a.online && a.speed > 0
                && Ops.pathBetween(shuttleNavigation, lifts.get(a.home)?.node, lift.node).length);
            available.sort((a, b) => (a.home === route.station ? -1 : 0) - (b.home === route.station ? -1 : 0));
            const shuttle = available[0];
            if (!shuttle) return { error: '연결 가능한 셔틀 대기' };
            const candidates = slotTargets.filter(t => !sim.locks.has(`slot:${t.slot.locationCode}`)
                && (route.direction === '입고' ? !t.slot.occupied && (t.slot.location?.capacity || 0) >= job.quantity
                    : t.slot.occupied && t.slot.stock?.itemCode === job.itemCode && t.slot.stock.quantity >= job.quantity
                      && !['hold', 'defect'].includes(t.slot.stock.status)))
                .sort((a, b) => a.slot.level - b.slot.level || Math.hypot(a.p.x - lift.x, a.p.z - lift.z) - Math.hypot(b.p.x - lift.x, b.p.z - lift.z));
            let target, rackPath;
            for (const t of candidates) {
                const h = (t.slot.level - 1) * t.slot.type.levelHeight / 1000;
                if (!lift.levelStops.some(stop => Math.abs(stop - h) < 0.001)) continue;
                const path = shuttlePath(lift, t.node, yShuttle + h);
                if (path.length) { target = t; rackPath = path; break; }
            }
            if (!target) return { error: route.direction === '입고' ? '접근 가능한 빈 랙 셀 대기' : '접근 가능한 출고 재고 확인' };
            const { slot, p } = target;
            job.slot = slot; job.shuttle = shuttle.code;
            job.order.finalLocationCode = slot.locationCode;
            const footprint = { width: sampleWidth * 1000, depth: sampleWidth * 1000 };
            const dockQueue = dockQueues.get(route.code);
            const dockPlace = dockQueue[job.routeSequence] || { x: layout.dock.centerX, y: layout.dock.centerY, layer: 0 };
            const dockPos = pos(dockPlace.x / 1000, floorY + 0.06 + dockPlace.layer * (sampleHeight + 0.08), dockPlace.y / 1000);
            const physicalBufferCapacity = Ops.arrangeRegionQueue(layout.buffer, 1, footprint, {
                gap: 100, margin: 100, entryX: layout.nearBuffer.x, entryY: layout.nearBuffer.y
            })[0]?.perLayer || 1;
            const capacity = Math.min(Math.max(1, Number(route.capacity) || 1), physicalBufferCapacity);
            const bufferSlot = job.routeSequence % capacity;
            const bufferQueue = Ops.arrangeRegionQueue(layout.buffer, capacity, footprint, {
                gap: 100, margin: 100, entryX: layout.nearBuffer.x, entryY: layout.nearBuffer.y
            });
            const bufferPlace = bufferQueue[bufferSlot];
            const bufferPos = pos(bufferPlace.x / 1000, floorY + 0.06, bufferPlace.y / 1000);
            const bufferLock = `buffer:${route.buffer}:${bufferSlot}`;
            const stationLock = `station:${route.station}`;
            const stationPos = pos(lift.x, yShuttle + shuttleBodyCenterY + shuttleFrameHeight / 2 + 0.01, lift.z);
            const cvPoints = asPoints(layout.conveyorPath, floorY + 1);
            const cvBuffer = { ...bufferPos, y: floorY + 1 };
            const amrPath = asPoints(layout.amrPath, floorY);
            const handoff = (destination, chassis, owner, label, transferExtra = {}) => {
                const dx = destination.x - chassis.x, dz = destination.z - chassis.z;
                const extension = Math.min(stackerDimensions.maxExtension, Math.max(0,
                    Math.hypot(dx, dz) - stackerDimensions.mastZ - stackerDimensions.forkCenterZ));
                const forkHeight = Math.max(0.04, destination.y - floorY - 0.0275);
                return [
                    { actor: amr.code, pose: { yaw: Math.atan2(dx, dz) }, label: '정렬' },
                    { actor: amr.code, pose: { forkHeight }, label: '포크 높이 조정' },
                    { actor: amr.code, pose: { forkExtension: extension }, label },
                    transfer(owner, owner === amr.code ? null : destination, label, { actor: amr.code, ...transferExtra }),
                    { actor: amr.code, pose: { forkExtension: 0 }, label: '포크 회수' },
                    { actor: amr.code, pose: { forkHeight: travelForkHeight }, label: '포크 하강' }
                ];
            };
            const amrStart = route.direction === '입고' ? amrPath[0] : amrPath[amrPath.length - 1];
            const amrNode = passageNavigation.nodesByKey.get(models.get(amr.code).currentKey)
                || Ops.accessNode(passageNavigation, { minX: amr.position.x * 1000, maxX: amr.position.x * 1000,
                    minY: amr.position.z * 1000, maxY: amr.position.z * 1000, centerX: amr.position.x * 1000, centerY: amr.position.z * 1000 }, size);
            const startNode = route.direction === '입고' ? layout.nearBuffer : layout.nearStation;
            const approach = Ops.pathBetween(passageNavigation, amrNode, startNode);
            if (!approach.length) return { error: 'AMR 대기 위치의 T 연결 확인' };
            const levelY = rackPath[0].y;
            const atLiftGround = pos(lift.x, yShuttle, lift.z), atLiftLevel = pos(lift.x, levelY, lift.z);
            const homeLift = lifts.get(shuttle.home);
            const homeLevel = pos(homeLift.x, levelY, homeLift.z);
            const reposition = [];
            if (Math.hypot(shuttle.position.x - lift.x, shuttle.position.z - lift.z) > 0.01) {
                const fromHome = shuttlePath(homeLift, lift.node, levelY);
                reposition.push(move(shuttle.code, [shuttle.position, homeLevel], '리프트 이동'),
                    move(shuttle.code, [...fromHome, ...line(fromHome[fromHome.length - 1], atLiftLevel).slice(1)], '이동'),
                    move(shuttle.code, [atLiftLevel, atLiftGround], '리프트 하강'));
            } else reposition.push(move(shuttle.code, [shuttle.position, atLiftGround], '리프트 하강'));
            const corridorId = passageNavigation.components.findIndex(c => c.includes(layout.nearBuffer.key));
            const amrLocks = [`T:${corridorId}`];
            const cvEntryLock = `CV:entry:${route.direction === '입고' ? route.dock : route.buffer}`;
            const lanePath = simplify(route.direction === '입고' ? cvPoints : reverse(cvPoints));
            const cvMove = (path, label, extra = {}) => move(null, path, label, {
                speed: conveyorSpeed, conveyor: true, clearance: 0.3, junctions: cvJunctions, lanePath, ...extra
            });
            const stLocks = [`actor:${shuttle.code}`, `lift:${route.station}`, `lift:${shuttle.home}`,
                ...Ops.shuttleRouteResources([...reposition.map(step => step.path), rackPath,
                    [atLiftGround, atLiftLevel]], { radius: Math.max(shuttle.radius, sampleWidth / 2) + 0.1 })];
            const beginShuttle = { ...reposition[0], acquire: stLocks, fairAcquire: true };
            const releaseShuttle = move(shuttle.code, [atLiftLevel, atLiftGround], '리프트 하강', { release: stLocks, releaseActor: true });
            const cvInbound = [transfer(`dock:${route.dock}`, dockPos, '차량 하역', { effect: 'truck-unload' }),
                cvMove(line(dockPos, cvPoints[0]), '컨베이어 진입', { acquire: [cvEntryLock], startOwner: 'conveyor', release: [cvEntryLock],
                    entryQueue: cvEntryLock, entryOrder: job.dockEntryOrder, waitForJobs: job.dockEntryPredecessors,
                    entryInterval: conveyorEntryInterval }),
                cvMove(cvPoints, '컨베이어 입고 운반'),
                cvMove([...line(cvPoints[cvPoints.length - 1], cvBuffer), bufferPos], '컨베이어 버퍼 인계', {
                    acquire: [bufferLock], owner: `buffer:${route.buffer}`, position: bufferPos })];
            const amrIn = [move(amr.code, asPoints(approach, floorY), '상차지 이동', { acquire: [`actor:${amr.code}`, ...amrLocks] }),
                ...handoff(bufferPos, amrPath[0], amr.code, '상차', { release: [bufferLock] }),
                move(amr.code, amrPath, '운반'),
                ...handoff(stationPos, amrPath[amrPath.length - 1], `station:${route.station}`, '하차', { acquire: [stationLock] }),
                move(amr.code, reverse(amrPath), '복귀', { release: [`actor:${amr.code}`, ...amrLocks], releaseActor: true })];
            const shuttleIn = [beginShuttle, ...reposition.slice(1),
                transfer(shuttle.code, null, '상차', { actor: shuttle.code, release: [stationLock] }),
                move(shuttle.code, [atLiftGround, atLiftLevel], '리프트 상승'),
                move(shuttle.code, rackPath, '적치 이동'),
                transfer(`rack:${slot.locationCode}`, p, '랙 적치', { actor: shuttle.code, effect: 'putaway' }),
                move(shuttle.code, reverse(rackPath), '복귀'), releaseShuttle];
            const shuttleOut = [beginShuttle, ...reposition.slice(1),
                move(shuttle.code, [atLiftGround, atLiftLevel], '리프트 상승'),
                move(shuttle.code, rackPath, '피킹 이동'),
                transfer(shuttle.code, null, '피킹', { actor: shuttle.code, effect: 'pick' }),
                move(shuttle.code, reverse(rackPath), '운반'),
                move(shuttle.code, [atLiftLevel, atLiftGround], '리프트 하강'),
                transfer(`station:${route.station}`, stationPos, '하차', { actor: shuttle.code, acquire: [stationLock], release: stLocks, releaseActor: true })];
            const amrOut = [move(amr.code, asPoints(approach, floorY), '상차지 이동', { acquire: [`actor:${amr.code}`, ...amrLocks] }),
                ...handoff(stationPos, amrPath[amrPath.length - 1], amr.code, '상차', { release: [stationLock] }),
                move(amr.code, reverse(amrPath), '운반'),
                ...handoff(bufferPos, amrPath[0], `buffer:${route.buffer}`, '하차', { acquire: [bufferLock] }),
                move(amr.code, amrPath, '복귀', { release: [`actor:${amr.code}`, ...amrLocks], releaseActor: true })];
            const cvOut = [transfer(`buffer:${route.buffer}`, cvBuffer, '컨베이어 인계', { acquire: [cvEntryLock] }),
                cvMove(reverse(line(cvPoints[cvPoints.length - 1], cvBuffer)), '컨베이어 진입', {
                    startOwner: 'conveyor', release: [cvEntryLock, bufferLock],
                    entryQueue: cvEntryLock, entryOrder: job.routeSequence, entryInterval: conveyorEntryInterval }),
                cvMove(reverse(cvPoints), '컨베이어 출고 운반'),
                cvMove(reverse(line(dockPos, cvPoints[0])), '컨베이어 도크 인계', { owner: `dock:${route.dock}`, position: dockPos }),
                transfer(`truck:${route.dock}`, dockPos, '차량 상차', { effect: 'truck-load' })];
            // Pallets wait in D/B/S while a resource is busy. No teleporting through absent T/CV/ST.
            ownershipPositions.set(`station:${route.station}`, stationPos);
            return {
                reservations: [`slot:${slot.locationCode}`],
                transports: [
                    { actor: amr.code, from: route.direction === '입고' ? route.buffer : route.station,
                        to: route.direction === '입고' ? route.station : route.buffer },
                    { actor: shuttle.code, from: route.direction === '입고' ? route.station : slot.locationCode,
                        to: route.direction === '입고' ? slot.locationCode : route.station }
                ].map(transport => ({ ...transport,
                    itemInfo: `${job.itemCode} · ${data.items.find(item => item.code === job.itemCode)?.name || '미설정'} · ${job.quantity}개`,
                    barcode: job.order.barcode || `HU-${job.id}` })),
                cargo: { owner: route.direction === '입고' ? `truck:${route.dock}` : `rack:${slot.locationCode}`,
                    position: route.direction === '입고' ? dockPos : p, dimensions: slot.boxSize.slice() },
                steps: route.direction === '입고' ? [...cvInbound, ...amrIn, ...shuttleIn] : [...shuttleOut, ...amrOut, ...cvOut]
            };
        };
        const onEvent = (event, job) => {
            if (event === 'truck-unload' || event === 'truck-load') job.truckTransferComplete = true;
            const slot = job.slot;
            if (event === 'started') {
                const dummy = { loadAnchor: new THREE.Group() };
                const load = createTaskLoad(dummy, { slot: { ...slot, item: data.items.find(i => i.code === job.itemCode) } });
                const copies = new Map();
                load.traverse(part => {
                    if (!part.material) return;
                    if (!copies.has(part.material)) { const copy = part.material.clone(); copies.set(part.material, copy); visualMaterials.add(copy); }
                    part.material = copies.get(part.material);
                });
                load.removeFromParent(); load.name = `operation-pallet-${job.id}`;
                load.userData.jobCode = job.id; scene.add(load); jobVisuals.set(job.id, load);
            }
            if (event === 'putaway') {
                slot.occupied = true;
                slot.stock = { ...(slot.location || {}), locationCode: slot.locationCode, itemCode: job.itemCode,
                    quantity: job.quantity, capacity: slot.location?.capacity || 0, status: 'normal' };
                slot.item = data.items.find(i => i.code === job.itemCode);
                setSlotInstanceVisible(slot, false);
            }
            if (event === 'pick') {
                slot.stock.quantity -= job.quantity;
                slot.occupied = slot.stock.quantity > 0;
                if (!slot.occupied) {
                    setSlotInstanceVisible(slot, false);
                    simulation.jobs.forEach(previous => {
                        if (previous !== job && previous.cargo?.owner === `rack:${slot.locationCode}`) previous.cargo.owner = 'consumed';
                    });
                }
            }
            if (event === 'complete') {
                const a = simulation.actors.get(job.shuttle);
                a.home = job.route.station;
                const model = models.get(job.route.amr);
                const l = compiled.get(job.route.code);
                model.currentKey = job.route.direction === '입고' ? l.nearBuffer.key : l.nearStation.key;
            }
        };
        const simulation = new Ops.Simulation({ actors, jobs, prepare, onEvent });
        // A small, accessible status strip also explains why an invalid connection is waiting.
        const panel = shell.viewport.closest('.warehouse-3d-shell').querySelector('.warehouse-3d-bottom-panel');
        const controls = document.createElement('div'); controls.className = 'warehouse-operation-controls';
        const heading = document.createElement('span'); heading.textContent = '물류 흐름 · 모의 운행';
        const pause = document.createElement('button'); pause.type = 'button'; pause.textContent = '일시정지';
        pause.addEventListener('click', () => { simulation.paused = !simulation.paused; pause.textContent = simulation.paused ? '운행 재개' : '일시정지'; }, { signal });
        controls.append(heading, pause); panel.append(controls);
        const statusList = document.createElement('div'); statusList.className = 'warehouse-operation-list'; panel.append(statusList);
        const rows = routes.map(route => {
            const row = document.createElement('div'); row.className = 'warehouse-operation-row';
            row.dataset.operationRoute = route.code; statusList.append(row); return { route, row };
        });
        if (!routes.length) { const warning = document.createElement('span'); warning.textContent = data.operationWarning || '운영 경로를 설정해 주세요.'; statusList.append(warning); }
        panel.classList.add('has-operations');
        let previous = null, lastUi = -Infinity;
        document.addEventListener('visibilitychange', () => { previous = null; }, { signal });
        const refreshUi = () => {
            const root = panel.closest('.warehouse-3d-shell');
            rows.forEach(({ route, row }) => {
                const list = simulation.jobs.filter(j => j.route.code === route.code);
                const active = list.find(j => !j.done) || list[list.length - 1];
                const flow = route.direction === '입고' ? `${route.buffer} → ${route.station}` : `${route.station} → ${route.buffer}`;
                row.textContent = `${route.direction} ${route.dock} · ${route.amr} · ${flow} · ${active?.status || compiled.get(route.code)?.error || '작업지시 대기'}`;
                row.title = active ? `${active.id} · ${active.itemCode} ${active.quantity}개 · ${active.cargo?.owner || '작업 대기'}` : '';
            });
            shell.viewport.dataset.operationJobs = JSON.stringify(simulation.snapshot());
            shell.viewport.dataset.operationCargoAppearance = JSON.stringify([...jobVisuals].map(([id, visual]) => ({
                id, style: visual.userData.cargoAppearance, cartonCount: visual.getObjectByName('transport-carton-stack')?.userData.cartonCount,
                loadSize: visual.userData.loadSize
            })));
            shell.viewport.dataset.operationElapsed = simulation.elapsed.toFixed(3);
            shell.viewport.dataset.operationRoutes = routes.map(r => `${r.code}:${r.direction}:${r.dock}:${r.buffer}:${r.station}:${r.amr}`).join(';');
            shell.viewport.dataset.operationConveyorSpeed = String(conveyorSpeed);
            shell.viewport.dataset.operationConveyorEntryInterval = String(conveyorEntryInterval);
            shell.viewport.dataset.operationPalletMultiplier = '2';
            shell.viewport.dataset.operationConveyorPolicy = 'pipeline-0.3m-gap-junction-reservation';
            shell.viewport.dataset.operationQueuePolicy = 'entry-nearest-row-major-then-next-layer';
            shell.viewport.dataset.operationDockDeparturePolicy = 'top-layer-first-then-entry-nearest';
            shell.viewport.dataset.operationQueues = JSON.stringify([...simulation.jobs.reduce((groups, job) => {
                const owner = job.cargo?.owner || '';
                if (!owner.startsWith('dock:') && !owner.startsWith('buffer:')) return groups;
                if (!groups.has(owner)) groups.set(owner, []);
                groups.get(owner).push(job.id);
                return groups;
            }, new Map())].map(([owner, jobIds]) => ({ owner, count: jobIds.length, jobIds })));
            shell.viewport.dataset.operationInventoryPolicy = 'simulation-only';
            shell.viewport.dataset.operationActors = JSON.stringify([...simulation.actors.values()].map(a => ({ code: a.code, state: a.status, speed: a.speed, position: a.position, job: a.job })));
            shell.viewport.dataset.shuttleStates = shuttleFleet.map(a => a.state).join(',');
            shell.viewport.dataset.forkliftStates = amrFleet.map(a => a.state).join(',');
            shell.viewport.dataset.amrPositions = amrFleet.map(a => `${a.equipmentCode}:${a.group.position.x.toFixed(3)},${a.group.position.z.toFixed(3)}`).join(';');
            const occupied = slots.filter(slot => slot.occupied).length;
            const free = slots.length - occupied;
            const rate = slots.length ? (occupied / slots.length * 100).toFixed(1) : '0.0';
            const utilization = root.querySelector('[data-warehouse-kpi="utilization"]');
            if (utilization) {
                utilization.querySelector('.warehouse-3d-kpi-value').textContent = `${rate}%`;
                utilization.querySelector('small').textContent = `${occupied.toLocaleString()} / ${slots.length.toLocaleString()} 셀`;
                utilization.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', rate);
                utilization.querySelector('i').style.setProperty('--warehouse-kpi-progress', `${rate}%`);
            }
            const availability = root.querySelector('[data-warehouse-kpi="available"]');
            if (availability) {
                availability.querySelector('.warehouse-3d-kpi-value').textContent = `${free.toLocaleString()} 셀`;
                availability.querySelector('small').textContent = `${(100 - Number(rate)).toFixed(1)}%`;
            }
            shell.viewport.dataset.operationInventory = JSON.stringify({ occupied, free, quantity: slots.reduce((n, slot) => n + (slot.occupied ? Number(slot.stock?.quantity || 0) : 0), 0) });
            const warningCount = simulation.jobs.filter(j => /확인|보류/.test(j.status)).length;
            const warningValue = root.querySelector('[data-warehouse-kpi="alerts"] .warehouse-3d-kpi-value');
            if (warningValue) warningValue.textContent = `${warningCount} 건`;
            for (const kind of ['입고', '출고']) {
                const prefix = kind === '입고' ? 'inbound' : 'outbound';
                const list = simulation.jobs.filter(j => j.route.direction === kind);
                for (const [suffix, count] of [['complete', list.filter(j => j.done).length], ['progress', list.filter(j => j.steps && !j.done).length], ['request', list.filter(j => !j.steps).length]]) {
                    const element = panel.closest('.warehouse-3d-shell').querySelector(`[data-warehouse-kpi="${prefix}-${suffix}"] .warehouse-3d-kpi-value`);
                    if (element) element.textContent = `${count} 건`;
                }
            }
        };
        refreshUi();
        return {
            truckProgress(dock, direction) { return Ops.truckProgress(simulation.jobs, dock, direction); },
            update(timestamp) {
                if (document.hidden) { previous = null; return true; }
                const dt = previous === null ? 0 : Math.max(0, (timestamp - previous) / 1000);
                previous = timestamp; simulation.tick(dt);
                simulation.actors.forEach(actor => {
                    const model = models.get(actor.code);
                    model.group.position.set(actor.position.x, actor.position.y, actor.position.z);
                    model.group.rotation.y = actor.yaw;
                    model.state = actor.status; model.equipmentStatus = actor.status;
                    model.transportHistory = actor.transportHistory;
                    model.currentSpeed = ['이동', '운반', '복귀', '상차지 이동', '적치 이동', '피킹 이동'].includes(actor.status) ? actor.speed : 0;
                    model.group.userData.operationState = actor.status;
                    model.label.setOperationStatus?.(actor.status);
                    if (actor.kind === 'amr') { setForkHeight(model, actor.forkHeight); setForkExtension(model, actor.forkExtension); }
                    model.group.updateMatrixWorld(true);
                    const button = panel.closest('.warehouse-3d-shell').querySelector(`[data-warehouse-object-code="${actor.code}"] .warehouse-3d-object-status`);
                    if (button && button.textContent !== actor.status) {
                        button.textContent = actor.status;
                        button.style.setProperty('--warehouse-equipment-status-color', model.label.userData.equipmentStatusColor);
                    }
                });
                simulation.jobs.forEach(job => {
                    const visual = jobVisuals.get(job.id); if (!visual || !job.cargo) return;
                    const cargo = job.cargo, actor = simulation.actors.get(cargo.owner);
                    const pendingRackPickup = job.route.direction === '출고' && cargo.owner.startsWith('rack:');
                    const stored = cargo.owner.startsWith('rack:');
                    const appearance = stored ? slotVisualState(job.slot) : { visible: !isLevelFocused(), opacity: 1 };
                    visual.setStorageState(stored, appearance.color);
                    visual.visible = !pendingRackPickup && cargo.owner !== 'consumed' && !cargo.owner.startsWith('truck:') && appearance.visible;
                    if (visual.userData.operationOpacity !== appearance.opacity) {
                        visual.traverse(part => { if (part.material) { part.material.transparent = appearance.opacity < 1; part.material.opacity = appearance.opacity; part.material.depthWrite = appearance.opacity === 1; part.material.needsUpdate = true; } });
                        visual.userData.operationOpacity = appearance.opacity;
                    }
                    if (actor) {
                        const model = models.get(actor.code);
                        const p = actor.kind === 'amr' ? model.loadAnchor.getWorldPosition(new THREE.Vector3())
                            : new THREE.Vector3(actor.position.x, actor.position.y + shuttleBodyCenterY + shuttleFrameHeight / 2 + 0.01, actor.position.z);
                        visual.position.copy(p); visual.rotation.y = actor.yaw;
                    } else { visual.position.set(cargo.position.x, cargo.position.y, cargo.position.z); visual.rotation.y = cargo.owner.startsWith('rack:') ? job.slot.group.rotation.y : 0; }
                });
                if (timestamp - lastUi > 500) { refreshUi(); lastUi = timestamp; }
                return true;
            }
        };
    };
}());
