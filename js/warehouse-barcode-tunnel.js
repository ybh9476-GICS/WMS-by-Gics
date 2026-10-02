(function () {
    'use strict';
    // Coordinates in the sheet are millimetres; model and cargo positions are metres.
    function buildLayout(cells = [], conveyorCells = [], cellSize = 500) {
        const size = Math.max(1, Number(cellSize) || 500);
        const key = (x, z) => `${x}:${z}`;
        const track = new Set(conveyorCells.map(c => key(Math.round(c.x / size), Math.round(c.y / size))));
        const rows = new Map();
        cells.forEach(c => {
            const x = Math.round(c.x / size), z = Math.round(c.y / size);
            if (!rows.has(z)) rows.set(z, new Set());
            rows.get(z).add(x);
        });
        const rectangles = [];
        let previous = new Map(), previousZ = -Infinity;
        [...rows.keys()].sort((a, b) => a - b).forEach(z => {
            const columns = [...rows.get(z)].sort((a, b) => a - b), current = new Map();
            let start = 0;
            columns.forEach((x, i) => {
                if (columns[i + 1] === x + 1) return;
                const left = columns[start], right = x + 1, id = `${left}:${right}`;
                let rect = previousZ === z - 1 ? previous.get(id) : null;
                if (rect) rect.z1 = z + 1;
                else { rect = { x0: left, x1: right, z0: z, z1: z + 1 }; rectangles.push(rect); }
                current.set(id, rect); start = i + 1;
            });
            previous = current; previousZ = z;
        });
        return rectangles.map((r, index) => {
            let xPorts = 0, zPorts = 0;
            for (let x = r.x0; x < r.x1; x++) zPorts += Number(track.has(key(x, r.z0 - 1))) + Number(track.has(key(x, r.z1)));
            for (let z = r.z0; z < r.z1; z++) xPorts += Number(track.has(key(r.x0 - 1, z))) + Number(track.has(key(r.x1, z)));
            const axis = xPorts === zPorts ? (r.x1 - r.x0 > r.z1 - r.z0 ? 'x' : 'z') : xPorts > zPorts ? 'x' : 'z';
            const minX = r.x0 * size / 1000, maxX = r.x1 * size / 1000;
            const minZ = r.z0 * size / 1000, maxZ = r.z1 * size / 1000;
            return { code: `BT${String(index + 1).padStart(2, '0')}`, axis, minX, maxX, minZ, maxZ,
                x: (minX + maxX) / 2, z: (minZ + maxZ) / 2,
                width: axis === 'z' ? maxX - minX : maxZ - minZ,
                length: axis === 'z' ? maxZ - minZ : maxX - minX };
        });
    }

    function createPassDetector(layout, conveyorY) {
        const inside = layout.map(() => new Set()), previous = new Map();
        return (cargo) => {
            const entries = [], seen = new Set();
            cargo.forEach(p => {
                seen.add(p.id);
                const old = previous.get(p.id);
                layout.forEach((r, i) => {
                    const atHeight = Math.abs(p.y - conveyorY) < 0.18;
                    const within = atHeight && p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
                    // A fast, straight crossing between frames must also count once.
                    const along = r.axis === 'z' ? 'z' : 'x', across = along === 'z' ? 'x' : 'z';
                    const low = along === 'z' ? r.minZ : r.minX, high = along === 'z' ? r.maxZ : r.maxX;
                    const aLow = across === 'x' ? r.minX : r.minZ, aHigh = across === 'x' ? r.maxX : r.maxZ;
                    const crossed = old && atHeight && Math.abs(old.y - conveyorY) < 0.18
                        && old[across] >= aLow && old[across] <= aHigh && p[across] >= aLow && p[across] <= aHigh
                        && ((old[along] < low && p[along] > high) || (old[along] > high && p[along] < low));
                    if ((within || crossed) && !inside[i].has(p.id)) entries.push({ index: i, cargoId: p.id });
                    if (within) inside[i].add(p.id); else inside[i].delete(p.id);
                });
                previous.set(p.id, { x: p.x, y: p.y, z: p.z });
            });
            previous.forEach((_, id) => { if (!seen.has(id)) { previous.delete(id); inside.forEach(set => set.delete(id)); } });
            return entries;
        };
    }

    function createScanRecord(cargoId, metadata = {}, now = new Date()) {
        const date = now instanceof Date ? now : new Date(now);
        const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
        return {
            id: `${cargoId || 'UNKNOWN'}-${safeDate.getTime()}`,
            passedAt: safeDate.toISOString(),
            passedAtText: safeDate.toLocaleString('ko-KR', { hour12: false }),
            result: String(metadata.result || '정상 인식'),
            itemInfo: String(metadata.itemInfo || '품목 정보 미설정'),
            destination: String(metadata.destination || '도착지 미설정'),
            barcode: String(metadata.barcode || `HU-${cargoId || 'UNKNOWN'}`),
            cargoId: String(cargoId || '')
        };
    }

    function createModel(THREE, layout, floorY) {
        const group = new THREE.Group(), resources = [];
        group.name = 'WAREHOUSE-BT-SCAN-TUNNELS';
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const steel = new THREE.MeshStandardMaterial({ color: '#a6afb8', metalness: 0.55, roughness: 0.42 });
        const dark = new THREE.MeshStandardMaterial({ color: '#202b35', roughness: 0.75 });
        const display = new THREE.MeshBasicMaterial({ color: '#2b8bd9' });
        const green = new THREE.MeshBasicMaterial({ color: '#38c875' });
        const amber = new THREE.MeshBasicMaterial({ color: '#e9b949' });
        resources.push(geometry, steel, dark, display, green, amber);
        const add = (parent, material, x, y, z, w, h, d) => {
            const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.scale.set(w, h, d);
            mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
        };
        const entries = layout.map(r => {
            const tunnel = new THREE.Group(); tunnel.name = r.code;
            tunnel.position.set(r.x, floorY + 1, r.z); tunnel.rotation.y = r.axis === 'x' ? Math.PI / 2 : 0;
            tunnel.userData = { kind: 'barcode-tunnel', source: 'floorPlan-BT', code: r.code, width: r.width, length: r.length };
            group.add(tunnel);
            const w = r.width, d = r.length, h = Math.max(1.2, w * 0.95), t = Math.min(0.04, w * 0.025);
            tunnel.userData.height = h;
            const red = new THREE.MeshBasicMaterial({ color: '#ff172b', toneMapped: false }); resources.push(red);
            const glow = new THREE.Group(); glow.visible = false; tunnel.add(glow);
            [-1, 1].forEach(side => {
                add(tunnel, steel, side * (w - t) / 2, h / 2, 0, t, h, d);
                [-1, 1].forEach(end => {
                    add(tunnel, dark, side * (w - t) / 2, h / 2, end * (d - t) / 2, t * 1.15, h, t);
                    add(tunnel, steel, side * (w - t) / 2, -0.51, end * (d - t) / 2, t, 0.98, t);
                });
                add(glow, red, side * (w / 2 - t - 0.015), h / 2, 0, 0.025, h * 0.84, Math.min(0.08, d * 0.12));
            });
            add(tunnel, steel, 0, h + t / 2, 0, w, t, d);
            [-1, 1].forEach(end => add(tunnel, dark, 0, h - t, end * (d - t) / 2, w, t * 2, t));
            add(glow, red, 0, h - 0.025, 0, w - t * 2, 0.025, Math.min(0.08, d * 0.12));
            // Simple side operator screen and stack light; no branding or heavy detail.
            add(tunnel, dark, w / 2 + 0.018, h * 0.64, 0, 0.04, h * 0.24, d * 0.27);
            add(tunnel, display, w / 2 + 0.041, h * 0.64, 0, 0.008, h * 0.2, d * 0.23);
            add(tunnel, dark, w * 0.3, h + 0.12, 0, 0.07, 0.18, 0.07);
            [green, amber, red].forEach((m, i) => add(tunnel, m, w * 0.3, h + 0.24 + i * 0.08, 0, 0.09, 0.075, 0.09));
            const light = new THREE.PointLight('#ff1226', 0, Math.max(w, d, h) * 1.3, 2);
            light.position.set(0, h * 0.65, 0); tunnel.add(light);
            const washMaterial = new THREE.MeshBasicMaterial({ color: '#ff1226', transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false });
            resources.push(washMaterial);
            add(glow, washMaterial, 0, 0.018, 0, w - t * 2, 0.006, d - t * 2);
            return {
                tunnel, glow, light, until: -Infinity, started: -Infinity,
                scans: 0, cargoId: '', history: [], communicationStatus: 'ONLINE', equipmentStatus: '대기'
            };
        });
        const detect = createPassDetector(layout, floorY + 1);
        return { group, resources, entries,
            update(timestamp, palletGroups, resolveCargoMetadata) {
                const cargo = palletGroups.filter(p => p.visible).map(p => ({ id: p.userData.jobCode, ...p.position }));
                detect(cargo).forEach(event => {
                    const e = entries[event.index]; e.started = timestamp; e.until = timestamp + 1200;
                    e.scans++; e.cargoId = event.cargoId;
                    e.equipmentStatus = '스캔 중';
                    const metadata = typeof resolveCargoMetadata === 'function'
                        ? resolveCargoMetadata(event.cargoId, e) || {}
                        : {};
                    e.history.unshift(createScanRecord(event.cargoId, metadata));
                    if (e.history.length > 100) e.history.length = 100;
                });
                entries.forEach(e => {
                    const on = timestamp < e.until && Math.floor((timestamp - e.started) / 180) % 2 === 0;
                    e.glow.visible = on; e.light.intensity = on ? 15 : 0;
                    e.equipmentStatus = timestamp < e.until ? '스캔 중' : '대기';
                    e.tunnel.userData.scanning = on; e.tunnel.userData.scanCount = e.scans;
                });
                return entries.some(e => timestamp < e.until);
            }
        };
    }
    window.WmsBarcodeTunnel = { buildLayout, createPassDetector, createScanRecord, createModel };
})();
