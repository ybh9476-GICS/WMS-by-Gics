(function (root) {
    'use strict';
    // Pure scheduling and movement model. No sheet/localStorage writes: a mount is one simulation run.
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const point = (p) => ({ x: p.x, y: p.y || 0, z: p.z });
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    function parseRoutes(records) {
        const seen = new Set();
        return records.filter(r => r['경로 코드']).map(r => {
            const route = {
                code: String(r['경로 코드']).trim(), direction: String(r['작업 구분']).trim(),
                dock: String(r['도크 코드'] || '').trim(), buffer: String(r['버퍼 코드'] || '').trim(),
                station: String(r['스테이션 코드'] || '').trim(), amr: String(r['AMR 코드'] || '').trim(),
                enabled: String(r['사용 여부']).trim().toUpperCase() === 'Y',
                capacity: Math.max(1, Math.floor(number(r['버퍼 수용 팔레트'], 1))),
                priority: number(r['우선순위'], 10)
            };
            if (seen.has(route.code)) throw new Error(`중복 운영 경로: ${route.code}`);
            seen.add(route.code);
            if (!['입고', '출고'].includes(route.direction) || !route.dock || !route.buffer || !route.station || !route.amr) {
                throw new Error(`${route.code}: 용도·도크·버퍼·스테이션·AMR을 확인해 주세요.`);
            }
            return route;
        });
    }
    function regions(cells, size) {
        const result = new Map();
        cells.forEach(c => {
            if (!c.code) return;
            const r = result.get(c.code) || { code: c.code, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            r.minX = Math.min(r.minX, c.x); r.maxX = Math.max(r.maxX, c.x + size);
            r.minY = Math.min(r.minY, c.y); r.maxY = Math.max(r.maxY, c.y + size);
            result.set(c.code, r);
        });
        result.forEach(r => { r.centerX = (r.minX + r.maxX) / 2; r.centerY = (r.minY + r.maxY) / 2; });
        return result;
    }
    function arrangeRegionQueue(region, count, footprint = {}, options = {}) {
        if (!region || !(count > 0)) return [];
        const width = Math.max(1, number(footprint.width, 1000));
        const depth = Math.max(1, number(footprint.depth, 1000));
        const gap = Math.max(0, number(options.gap, 100));
        const margin = Math.max(0, number(options.margin, 100));
        const regionWidth = Math.max(1, region.maxX - region.minX);
        const regionDepth = Math.max(1, region.maxY - region.minY);
        const usableWidth = Math.max(width, regionWidth - margin * 2);
        const usableDepth = Math.max(depth, regionDepth - margin * 2);
        const columns = Math.max(1, Math.floor((usableWidth + gap) / (width + gap)));
        const rows = Math.max(1, Math.floor((usableDepth + gap) / (depth + gap)));
        const occupiedWidth = columns * width + Math.max(0, columns - 1) * gap;
        const occupiedDepth = rows * depth + Math.max(0, rows - 1) * gap;
        const startX = region.centerX - occupiedWidth / 2 + width / 2;
        const startY = region.centerY - occupiedDepth / 2 + depth / 2;
        const cells = [];
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                cells.push({ x: startX + column * (width + gap), y: startY + row * (depth + gap), row, column });
            }
        }
        const entryX = number(options.entryX, region.minX);
        const entryY = number(options.entryY, region.minY);
        cells.sort((a, b) => Math.hypot(a.x - entryX, a.y - entryY) - Math.hypot(b.x - entryX, b.y - entryY)
            || a.row - b.row || a.column - b.column);
        return Array.from({ length: Math.floor(count) }, (_, index) => {
            const cell = cells[index % cells.length];
            return { ...cell, layer: Math.floor(index / cells.length), perLayer: cells.length };
        });
    }
    function topFirstQueueOrder(queue) {
        return queue.map((place, index) => ({ layer: place.layer, index }))
            .sort((a, b) => b.layer - a.layer || a.index - b.index).map(place => place.index);
    }
    function accessNode(graph, region, gap) {
        if (!region) return null;
        return graph.nodes.filter(n => Math.hypot(
            Math.max(region.minX - n.x, 0, n.x - region.maxX),
            Math.max(region.minY - n.y, 0, n.y - region.maxY)
        ) <= gap + 0.001).sort((a, b) =>
            Math.hypot(a.x - region.centerX, a.y - region.centerY) - Math.hypot(b.x - region.centerX, b.y - region.centerY)
        )[0] || null;
    }
    function pathBetween(graph, start, end) {
        if (!start || !end) return [];
        const queue = [start.key], parent = new Map([[start.key, null]]);
        for (let i = 0; i < queue.length; i++) {
            const key = queue[i];
            if (key === end.key) {
                const path = [];
                for (let cursor = key; cursor !== null; cursor = parent.get(cursor)) path.push(graph.nodesByKey.get(cursor));
                return path.reverse();
            }
            for (const next of graph.nodesByKey.get(key)?.neighbors || []) {
                if (!parent.has(next)) { parent.set(next, key); queue.push(next); }
            }
        }
        return [];
    }
    function compileRoute(route, { buffers, docks, stations, amrGraph, conveyorGraph, cellSize }) {
        const buffer = buffers.get(route.buffer), dock = docks.get(route.dock), station = stations.get(route.station);
        if (!buffer || !dock || !station) return { error: '평면도 D·B·S 위치 확인' };
        const nearBuffer = accessNode(amrGraph, buffer, cellSize * 1.5);
        const nearStation = accessNode(amrGraph, station, cellSize * 1.5);
        const amrPath = pathBetween(amrGraph, nearBuffer, nearStation);
        if (!amrPath.length) return { error: `${route.buffer}↔${route.station} T 통로 연결 확인` };
        const cvDock = accessNode(conveyorGraph, dock, cellSize * 1.5);
        const cvBuffer = accessNode(conveyorGraph, buffer, cellSize * 1.5);
        const conveyorPath = pathBetween(conveyorGraph, cvDock, cvBuffer);
        if (!conveyorPath.length) return { error: `${route.dock}↔${route.buffer} CV 연결 확인` };
        return { buffer, dock, station, amrPath, conveyorPath, nearBuffer, nearStation };
    }
    function expandSimulationOrders(orders) {
        const used = new Set(orders.map(order => order.code));
        const extra = orders.filter(order => !['완료', '취소'].includes(order.status)).map(order => {
            let suffix = 2;
            while (used.has(`${order.code}-P${suffix}`)) suffix++;
            const code = `${order.code}-P${suffix}`; used.add(code);
            return { ...order, code, barcode: `${order.barcode || `HU-${order.code}`}-P${suffix}`, sourceWorkOrder: order.code };
        });
        return [...orders, ...extra];
    }
    function conveyorJunctions(paths) {
        const points = new Map(), segments = [];
        const add = p => points.set(`${p.x.toFixed(4)}:${p.z.toFixed(4)}`, { x: p.x, z: p.z });
        paths.forEach(raw => {
            const path = raw.filter((p, i) => !i || i === raw.length - 1
                || Math.abs((p.x - raw[i - 1].x) * (raw[i + 1].z - p.z)
                    - (p.z - raw[i - 1].z) * (raw[i + 1].x - p.x)) > 1e-6);
            path.forEach((p, i) => { add(p); if (i) segments.push([path[i - 1], p]); });
        });
        segments.forEach(([a, b]) => segments.forEach(([c, d]) => {
            if (Math.abs(a.z - b.z) > 1e-6 || Math.abs(c.x - d.x) > 1e-6) return;
            if (c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x)
                && a.z >= Math.min(c.z, d.z) && a.z <= Math.max(c.z, d.z)) add({ x: c.x, z: a.z });
        }));
        return [...points.values()];
    }
    function opposingConveyorPaths(first = [], second = []) {
        for (let i = 1; i < first.length; i++) {
            const a = first[i - 1], b = first[i];
            for (let j = 1; j < second.length; j++) {
                const c = second[j - 1], d = second[j];
                const horizontal = Math.abs(a.z - b.z) < 1e-6 && Math.abs(c.z - d.z) < 1e-6 && Math.abs(a.z - c.z) < 1e-6;
                const vertical = Math.abs(a.x - b.x) < 1e-6 && Math.abs(c.x - d.x) < 1e-6 && Math.abs(a.x - c.x) < 1e-6;
                if (horizontal && (b.x - a.x) * (d.x - c.x) < 0
                    && Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) > Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) + 1e-6) return true;
                if (vertical && (b.z - a.z) * (d.z - c.z) < 0
                    && Math.min(Math.max(a.z, b.z), Math.max(c.z, d.z)) > Math.max(Math.min(a.z, b.z), Math.min(c.z, d.z)) + 1e-6) return true;
            }
        }
        return false;
    }
    // Reserve only the swept footprint of the trip on each height, including its return.
    // Acquire the complete set atomically so opposite traffic cannot hold half a route each.
    function shuttleRouteResources(paths, { cellSize = 0.5, radius = 0.6 } = {}) {
        const keys = new Set();
        const add = p => {
            for (let x = Math.floor((p.x - radius) / cellSize); x <= Math.floor((p.x + radius) / cellSize); x++) {
                for (let z = Math.floor((p.z - radius) / cellSize); z <= Math.floor((p.z + radius) / cellSize); z++) {
                    keys.add(`ST:level:${p.y.toFixed(3)}:${x}:${z}`);
                }
            }
        };
        paths.forEach(path => {
            if (!path?.length) return;
            add(path[0]);
            path.slice(1).forEach((b, i) => {
                const a = path[i];
                // Vertical travel is guarded by the exclusive lift reservation.
                if (Math.abs(a.y - b.y) > 0.001) { add(b); return; }
                const samples = Math.max(1, Math.ceil(distance(a, b) / (cellSize / 2)));
                for (let j = 1; j <= samples; j++) add({ x: a.x + (b.x - a.x) * j / samples,
                    y: a.y, z: a.z + (b.z - a.z) * j / samples });
            });
        });
        return [...keys];
    }
    class Simulation {
        constructor({ actors, jobs, prepare, onEvent = () => {}, startedAt = Date.now() }) {
            if (new Set(jobs.map(j => j.id)).size !== jobs.length) throw new Error('작업 코드가 중복되었습니다. 작업지시를 확인해 주세요.');
            this.actors = new Map(actors.map(a => [a.code, { ...a, position: point(a.position), yaw: a.yaw || 0, status: '대기', job: null }]));
            this.jobs = jobs.map(j => ({ ...j, stage: 0, steps: null, status: '대기', elapsed: 0, done: false, cargo: null }));
            this.prepare = prepare; this.onEvent = onEvent; this.locks = new Map(); this.paused = false; this.elapsed = 0;
            this.startedAt = startedAt;
            this.conveyorEntryTimes = new Map();
            this.reservationWaiters = new Map(); this.reservationSequence = 0;
            this.actors.forEach(actor => { actor.transportHistory = []; });
        }
        reserve(job, keys) {
            const unique = [...new Set(keys || [])];
            if (unique.some(k => this.locks.has(k) && this.locks.get(k) !== job.id)) return false;
            unique.forEach(k => this.locks.set(k, job.id));
            return true;
        }
        release(job, keys) {
            (keys || []).forEach(k => { if (this.locks.get(k) === job.id) this.locks.delete(k); });
        }
        reserveStep(job, step) {
            if (!step.fairAcquire) return this.reserve(job, step.acquire);
            let waiter = this.reservationWaiters.get(job.id);
            if (!waiter) {
                waiter = { keys: new Set(step.acquire || []), order: this.reservationSequence++ };
                this.reservationWaiters.set(job.id, waiter);
            }
            if ([...this.reservationWaiters.values()].some(other => other.order < waiter.order
                && [...other.keys].some(key => waiter.keys.has(key)))) return false;
            if (!this.reserve(job, step.acquire)) return false;
            this.reservationWaiters.delete(job.id);
            return true;
        }
        tick(dt) {
            if (this.paused || !Number.isFinite(dt) || !(dt > 0)) return;
            // Keep elapsed time at low frame rates; small steps retain collision/turn checks.
            for (let remaining = dt; remaining > 1e-9;) {
                const step = Math.min(remaining, 0.05);
                this.advance(step); remaining -= step;
            }
        }
        advance(dt) {
            this.elapsed += dt;
            for (const job of this.jobs) {
                if (job.done) continue;
                if (!job.steps) {
                    const plan = this.prepare(job, this);
                    if (!plan || plan.error) { job.status = plan?.error || '설비·목적지 대기'; continue; }
                    if (!this.reserve(job, plan.reservations)) { job.status = '목적지 대기'; continue; }
                    job.steps = plan.steps; job.reservations = plan.reservations;
                    job.cargo = { ...plan.cargo, id: job.id, position: point(plan.cargo.position) };
                    job.transportRecords = new Map();
                    (plan.transports || []).forEach(transport => {
                        const carrier = this.actors.get(transport.actor);
                        if (!carrier) return;
                        const record = { ...transport, jobCode: job.id, status: '배정 대기',
                            assignedAt: this.recordTime(), loadedAt: null, unloadedAt: null };
                        carrier.transportHistory.unshift(record);
                        job.transportRecords.set(transport.actor, record);
                    });
                    this.onEvent('started', job);
                }
                const step = job.steps[job.stage];
                if (!step) {
                    job.done = true; job.status = '완료';
                    this.release(job, [...this.locks.keys()]);
                    this.reservationWaiters.delete(job.id);
                    this.actors.forEach(a => { if (a.job === job.id) { a.job = null; a.status = '대기'; } });
                    this.onEvent('complete', job); continue;
                }
                const actor = step.actor ? this.actors.get(step.actor) : null;
                const record = job.transportRecords?.get(step.actor);
                // A failure while carrying retains both ownership and reservations until recovery.
                if (step.actor && (!actor || !actor.enabled || actor.online !== true || !(actor.speed > 0))) {
                    this.reservationWaiters.delete(job.id);
                    job.status = '설비 사용·통신·속도 확인'; if (actor) actor.status = '작업 보류';
                    if (record && !record.unloadedAt) record.status = '작업 보류';
                    continue;
                }
                if (!step.started) {
                    if (step.waitForJobs?.length && this.jobs.some(other => step.waitForJobs.includes(other.id)
                        && !Number.isFinite(other.conveyorEnteredAt))) {
                        job.status = '위쪽 팔레트 반출 대기'; continue;
                    }
                    if (step.entryQueue && this.jobs.some(other => other !== job && !other.done
                        && other.steps?.[other.stage]?.entryQueue === step.entryQueue
                        && other.steps[other.stage].entryOrder < step.entryOrder)) {
                        job.status = '컨베이어 진입 순서 대기'; continue;
                    }
                    if (step.entryQueue && step.entryInterval > 0
                        && this.elapsed - (this.conveyorEntryTimes.get(step.entryQueue) ?? -Infinity) < step.entryInterval - 1e-9) {
                        job.status = '컨베이어 투입 간격 대기'; continue;
                    }
                    if (step.conveyor && job.cargo.owner !== 'conveyor' && this.jobs.some(other => other !== job
                        && other.cargo?.owner === 'conveyor'
                        && opposingConveyorPaths(step.lanePath, other.steps?.[other.stage]?.lanePath))) {
                        job.status = '컨베이어 반대 방향 대기'; continue;
                    }
                    if (actor && actor.job && actor.job !== job.id) { job.status = '설비 대기'; continue; }
                    if (!this.reserveStep(job, step)) {
                        job.status = step.acquire?.some(key => key.startsWith('station:')) ? '스테이션 인계 대기'
                            : step.acquire?.some(key => key.startsWith('buffer:')) ? '버퍼 인계 대기'
                            : '합류·리프트 대기';
                        if (actor && (!actor.job || actor.job === job.id)) actor.status = job.status;
                        if (record && !record.unloadedAt) record.status = job.status;
                        continue;
                    }
                    if (step.conveyor && step.startOwner && !this.moveConveyor(job, step, job.cargo.position)) {
                        this.release(job, step.acquire); continue;
                    }
                    if (actor) { actor.job = job.id; actor.status = step.label; }
                    step.started = true; job.elapsed = 0; step.index = 0;
                    if (step.startOwner) job.cargo.owner = step.startOwner;
                    if (step.entryQueue && step.entryInterval > 0) this.conveyorEntryTimes.set(step.entryQueue, this.elapsed);
                    if (step.startOwner === 'conveyor') job.conveyorEnteredAt = this.elapsed;
                }
                job.status = step.label;
                if (record && !record.unloadedAt) record.status = step.label;
                let finished = true;
                if (step.path?.length) {
                    const moving = actor || job.cargo;
                    const goal = step.path[step.index];
                    const dx = goal.x - moving.position.x, dz = goal.z - moving.position.z;
                    const gap = distance(moving.position, goal);
                    const movingHorizontally = Math.hypot(dx, dz) > 0.001;
                    if (actor && movingHorizontally) {
                        const wanted = Math.atan2(dx, dz);
                        const turn = Math.atan2(Math.sin(wanted - actor.yaw), Math.cos(wanted - actor.yaw));
                        actor.yaw += Math.sign(turn) * Math.min(Math.abs(turn), dt * 2.4);
                        if (Math.abs(turn) > 0.03) {
                            actor.status = '회전';
                            if (record && !record.unloadedAt) record.status = '회전';
                            continue;
                        }
                    }
                    const amount = Math.min(gap, (step.speed || actor?.speed || 0.5) * dt);
                    const proposed = gap < 0.0001 ? point(goal) : {
                        x: moving.position.x + (goal.x - moving.position.x) * amount / gap,
                        y: moving.position.y + (goal.y - moving.position.y) * amount / gap,
                        z: moving.position.z + (goal.z - moving.position.z) * amount / gap
                    };
                    if (step.conveyor && !this.moveConveyor(job, step, proposed)) continue;
                    if (actor && [...this.actors.values()].some(other => other !== actor && other.kind === actor.kind
                        && Math.abs(other.position.y - proposed.y) < 0.4
                        && Math.hypot(other.position.x - proposed.x, other.position.z - proposed.z) < (actor.radius + other.radius) * 0.9)) {
                        job.status = '안전 거리 대기'; actor.status = '대기';
                        if (record && !record.unloadedAt) record.status = job.status;
                        continue;
                    }
                    moving.position = proposed;
                    if (actor) actor.status = step.label;
                    if (gap <= amount + 0.0001) step.index++;
                    finished = step.index >= step.path.length;
                } else if (step.pose && actor) {
                    for (const [key, goal] of Object.entries(step.pose)) {
                        const current = actor[key] || 0;
                        const offset = key === 'yaw' ? Math.atan2(Math.sin(goal - current), Math.cos(goal - current)) : goal - current;
                        const change = Math.min(Math.abs(offset), dt * (key === 'yaw' ? 2.4 : 0.7));
                        actor[key] = current + Math.sign(offset) * change;
                        if (Math.abs(offset) > change + 0.0001) finished = false;
                    }
                } else {
                    job.elapsed += dt; finished = job.elapsed >= (step.duration || 0);
                }
                if (!finished) continue;
                if (step.owner) job.cargo.owner = step.owner;
                if (step.conveyor && step.owner && step.owner !== 'conveyor') {
                    this.release(job, [...this.locks.keys()].filter(key => key.startsWith('CV:junction:')));
                }
                if (record && step.owner && !record.unloadedAt) {
                    if (step.owner === actor.code && !record.loadedAt) {
                        record.loadedAt = this.recordTime(); record.status = '운반 중';
                    } else if (step.owner !== actor.code && record.loadedAt) {
                        record.unloadedAt = this.recordTime(); record.status = '완료';
                    }
                }
                if (step.position) job.cargo.position = point(step.position);
                if (step.effect) this.onEvent(step.effect, job);
                this.release(job, step.release);
                if (step.releaseActor && actor) { actor.job = null; actor.status = '대기'; }
                job.stage++; job.elapsed = 0;
            }
        }
        recordTime() {
            return new Date(this.startedAt + this.elapsed * 1000).toISOString();
        }
        moveConveyor(job, step, proposed) {
            const dimensions = job.cargo.dimensions || [1, 1, 1];
            const gap = step.clearance ?? 0.3;
            const radius = Math.max(dimensions[0], dimensions[2]) + gap + 0.5;
            const junctions = step.junctions || [];
            const keys = junctions.filter(p => Math.hypot(p.x - proposed.x, p.z - proposed.z) < radius)
                .map(p => `CV:junction:${p.x.toFixed(4)}:${p.z.toFixed(4)}`);
            if (keys.some(key => this.locks.has(key) && this.locks.get(key) !== job.id)) {
                job.status = '컨베이어 합류 대기'; return false;
            }
            if (this.jobs.some(other => {
                if (other === job || other.cargo?.owner !== 'conveyor') return false;
                const size = other.cargo.dimensions || [1, 1, 1], p = other.cargo.position;
                return Math.abs(p.y - proposed.y) < 0.4
                    && Math.abs(p.x - proposed.x) < (dimensions[0] + size[0]) / 2 + gap
                    && Math.abs(p.z - proposed.z) < (dimensions[2] + size[2]) / 2 + gap;
            })) { job.status = '컨베이어 간격 대기'; return false; }
            this.reserve(job, keys);
            this.release(job, junctions.filter(p => Math.hypot(p.x - proposed.x, p.z - proposed.z) >= radius)
                .map(p => `CV:junction:${p.x.toFixed(4)}:${p.z.toFixed(4)}`));
            return true;
        }
        snapshot() {
            return this.jobs.map(j => ({ id: j.id, route: j.route.code, direction: j.route.direction,
                amr: j.route.amr, from: j.route.direction === '입고' ? j.route.buffer : j.route.station,
                to: j.route.direction === '입고' ? j.route.station : j.route.buffer,
                status: j.status, stage: j.stage, total: j.steps?.length || 0, done: j.done,
                cargoOwner: j.cargo?.owner || '', cargoPosition: j.cargo ? point(j.cargo.position) : null,
                cargoDimensions: j.cargo?.dimensions, conveyorEnteredAt: j.conveyorEnteredAt,
                dockLayer: j.dockPlace?.layer, dockEntryOrder: j.dockEntryOrder,
                itemCode: j.itemCode, quantity: j.quantity }));
        }
    }
    function truckProgress(jobs, dock, direction) {
        const action = direction === '출고' ? '상차' : '하차';
        const effect = direction === '출고' ? 'truck-load' : 'truck-unload';
        const related = jobs.filter(job => job.route.dock === dock && job.route.direction === direction);
        if (related.length && related.every(job => job.truckTransferComplete)) return `${action} 완료`;
        if (related.some(job => job.truckTransferComplete || job.steps?.some(step => step.effect === effect && step.started))) return `${action} 중`;
        return `${action} 대기`;
    }
    const api = { parseRoutes, regions, arrangeRegionQueue, topFirstQueueOrder, accessNode, pathBetween, compileRoute, truckProgress,
        expandSimulationOrders, conveyorJunctions, opposingConveyorPaths, shuttleRouteResources, Simulation };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.WmsWarehouseOperations = api;
}(typeof window !== 'undefined' ? window : globalThis));
