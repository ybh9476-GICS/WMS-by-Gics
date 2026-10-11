(function () {
    const mountedControllers = new WeakMap();
    const worldUiResolutionScale = 2;
    const billboardRenderOrder = 10000;
    function loadThree() {
        if (!window.THREE) return Promise.reject(new Error('로컬 Three.js 파일을 불러오지 못했습니다.'));
        return Promise.resolve(window.THREE);
    }
    function loadOperations() { return Promise.resolve(); }
    function loadBarcodeTunnels() { return Promise.resolve(); }

    const googleSheetDefinitions = Object.freeze({
        // 3행의 연속된 X 좌표와 A열의 연속된 Y 좌표를 먼저 읽고 실제 평면도 범위를 계산한다.
        floorPlan: { sheetName: '평면도', xAxisRange: 'A3:3', yAxisRange: 'A3:A', headers: ['Y\\X'] },
        rackTypes: { sheetName: '랙타입 마스터', range: 'A4:H', headers: ['랙타입코드', '랙타입명', '베이폭(m)', '깊이(m)', '전체높이(m)', '단수', '단당높이(m)'] },
        zones: { sheetName: '구역설정', range: 'A4:D', headers: ['구역코드', '구역명', '용도', '기본랙타입코드'] },
        racks: { sheetName: '랙배치', range: 'A4:I', headers: ['랙코드', '구역코드', '랙타입코드', '방향', '베이 수(가로 칸 수)', '평면도 랙 전체 길이(m)', '평면도 랙 깊이(m)'] },
        locations: { sheetName: '로케이션 마스터', range: 'A4:F', headers: ['로케이션코드', '랙코드', '베이번호', '단번호', '깊이번호', '최대수량'] },
        items: { sheetName: '품목 마스터', range: 'A4:C', headers: ['품목코드', '품목명', '표시색상'] },
        inventory: { sheetName: '재고 현황', range: 'A4:D', headers: ['로케이션코드', '품목코드', '재고수량', '재고상태'] },
        workOrders: { sheetName: '작업지시', range: 'A1:R', headers: ['작업 코드', '작업 구분', '품목코드', '수량(개)'] }
    });

    function parseCsv(csvText) {
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        const text = String(csvText || '').replace(/^\uFEFF/, '');
        for (let index = 0; index < text.length; index += 1) {
            const character = text[index];
            if (quoted) {
                if (character === '"' && text[index + 1] === '"') {
                    cell += '"';
                    index += 1;
                } else if (character === '"') quoted = false;
                else cell += character;
                continue;
            }
            if (character === '"') quoted = true;
            else if (character === ',') {
                row.push(cell.trim());
                cell = '';
            } else if (character === '\n' || character === '\r') {
                if (character === '\r' && text[index + 1] === '\n') index += 1;
                row.push(cell.trim());
                if (row.some((value) => value !== '')) rows.push(row);
                row = [];
                cell = '';
            } else cell += character;
        }
        row.push(cell.trim());
        if (row.some((value) => value !== '')) rows.push(row);
        return rows;
    }

    function csvToRecords(csvText, requiredHeaders, sheetName) {
        const rows = parseCsv(csvText);
        const headerIndex = rows.findIndex((row) => requiredHeaders.every((header) => row.includes(header)));
        if (headerIndex < 0) throw new Error(`${sheetName}: 필수 헤더를 찾지 못했습니다. (${requiredHeaders.join(', ')})`);
        const headers = rows[headerIndex].map((header) => String(header || '').trim());
        return rows.slice(headerIndex + 1)
            .filter((row) => row.some((value) => value !== ''))
            .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
    }

    function columnNumberToName(columnNumber) {
        let remaining = Math.floor(Number(columnNumber));
        if (!(remaining > 0)) throw new Error('평면도 열 번호가 올바르지 않습니다.');
        let name = '';
        while (remaining > 0) {
            remaining -= 1;
            name = String.fromCharCode(65 + (remaining % 26)) + name;
            remaining = Math.floor(remaining / 26);
        }
        return name;
    }

    function getSequentialAxisLength(values, axisName) {
        let length = 0;
        let reachedBlank = false;
        values.forEach((value) => {
            const text = String(value ?? '').trim();
            if (!text) {
                reachedBlank = true;
                return;
            }
            const number = Number(text);
            const expected = length + 1;
            if (reachedBlank || !Number.isInteger(number) || number !== expected) {
                throw new Error(`평면도 ${axisName}축은 1부터 빈칸 없이 연속된 숫자여야 합니다. (${expected} 확인)`);
            }
            length = expected;
        });
        return length;
    }

    function getFloorPlanAxisRange(xAxisCsv, yAxisCsv) {
        const xRows = parseCsv(xAxisCsv);
        const yRows = parseCsv(yAxisCsv);
        const xCount = getSequentialAxisLength((xRows[0] || []).slice(1), 'X');
        const yCount = getSequentialAxisLength(yRows.slice(1).map((row) => row[0]), 'Y');
        if (!xCount || !yCount) throw new Error('평면도 X·Y 좌표축을 확인해 주세요.');
        const lastColumn = columnNumberToName(xCount + 1);
        const lastRow = yCount + 3;
        return {
            range: `A3:${lastColumn}${lastRow}`,
            dataRange: `B4:${lastColumn}${lastRow}`,
            xCount,
            yCount
        };
    }

    function toNumber(value, fallback = 0) {
        const text = String(value ?? '').replace(/,/g, '').trim();
        if (!text) return fallback;
        const number = Number(text);
        return Number.isFinite(number) ? number : fallback;
    }

    function isEnabled(value) {
        return !['N', 'NO', 'FALSE', '0', '미사용'].includes(String(value ?? '').trim().toUpperCase());
    }

    function convertGoogleSheetCsv(csvByKey, options = {}) {
        const records = {};
        Object.entries(googleSheetDefinitions).forEach(([key, definition]) => {
            const sheetName = options.sheets?.[key] || definition.sheetName;
            records[key] = csvToRecords(csvByKey[key], definition.headers, sheetName);
        });

        const floorPlanCellSize = Math.max(1, toNumber(options.floorPlanCellSizeMeters, 0.5) * 1000);
        const rackCodesFromMaster = new Set(records.racks.map((row) => String(row['랙코드'] || '').trim()).filter(Boolean));
        const floorPlanByRack = new Map();
        const floorPlanCells = [];
        const passageCells = [];
        const shuttlePassageCells = [];
        const conveyorCells = [];
        const barcodeTunnelCells = [];
        const dockCells = [];
        const bufferCells = [];
        const stationCells = [];
        const unmappedFloorRackCodes = new Set();
        records.floorPlan.forEach((row) => {
            const y = Number(row['Y\\X']);
            if (!Number.isFinite(y)) return;
            Object.entries(row).forEach(([header, value]) => {
                if (header === 'Y\\X') return;
                const x = Number(header);
                const cellValue = String(value || '').trim();
                if (!Number.isFinite(x) || !cellValue) return;
                floorPlanCells.push({ x, y, value: cellValue });
                const normalizedValue = cellValue.toUpperCase();
                if (normalizedValue === 'T') passageCells.push({ x, y });
                if (normalizedValue === 'GR' || normalizedValue === 'ST') shuttlePassageCells.push({ x, y });
                if (normalizedValue === 'CV') conveyorCells.push({ x, y });
                if (normalizedValue === 'BT') {
                    conveyorCells.push({ x, y });
                    barcodeTunnelCells.push({ x, y });
                }
                const stationCodeMatch = /^S(\d+)$/.exec(normalizedValue);
                if (normalizedValue === 'S' || stationCodeMatch) stationCells.push({
                    x,
                    y,
                    code: stationCodeMatch ? `S${stationCodeMatch[1].padStart(2, '0')}` : ''
                });
                const dockCodeMatch = /^D(\d+)$/.exec(normalizedValue);
                if (dockCodeMatch) dockCells.push({ x, y, code: `D${dockCodeMatch[1]}` });
                const bufferCodeMatch = /^B(\d+)$/.exec(normalizedValue);
                if (bufferCodeMatch) bufferCells.push({
                    x,
                    y,
                    code: `B${bufferCodeMatch[1].padStart(2, '0')}`
                });
                if (normalizedValue === 'F' || normalizedValue === 'T' || normalizedValue === 'GR' || normalizedValue === 'ST' || normalizedValue === 'CV' || normalizedValue === 'BT'
                    || normalizedValue === 'S' || stationCodeMatch || dockCodeMatch || bufferCodeMatch) return;
                const rackCode = rackCodesFromMaster.has(cellValue) ? cellValue : '';
                if (!rackCode) {
                    unmappedFloorRackCodes.add(cellValue);
                    return;
                }
                const placement = floorPlanByRack.get(rackCode) || { minX: x, maxX: x, minY: y, maxY: y, cellCount: 0 };
                placement.minX = Math.min(placement.minX, x);
                placement.maxX = Math.max(placement.maxX, x);
                placement.minY = Math.min(placement.minY, y);
                placement.maxY = Math.max(placement.maxY, y);
                placement.cellCount += 1;
                floorPlanByRack.set(rackCode, placement);
            });
        });

        const metersToMillimeters = (value, fallback = 0) => toNumber(value, fallback) * 1000;
        const zones = records.zones
            .filter((row) => row['구역코드'])
            .map((row) => ({
                code: row['구역코드'],
                name: row['구역명'],
                purpose: row['용도'],
                defaultRackTypeCode: row['기본랙타입코드']
            }));
        const rackTypes = records.rackTypes
            .filter((row) => row['랙타입코드'])
            .map((row) => ({
                code: row['랙타입코드'],
                name: row['랙타입명'],
                bayWidth: metersToMillimeters(row['베이폭(m)']),
                depth: metersToMillimeters(row['깊이(m)']),
                height: metersToMillimeters(row['전체높이(m)']),
                levels: toNumber(row['단수']),
                levelHeight: metersToMillimeters(row['단당높이(m)']),
                depthCount: toNumber(row['깊이수'], 1)
            }));
        const rackTypeByCode = new Map(rackTypes.map((type) => [type.code, type]));
        const layoutErrors = [];
        let floorPlanAppliedCount = 0;
        const enabledRackRows = records.racks.filter((row) => row['랙코드']);
        const usesFloorPlan = floorPlanByRack.size > 0;
        const unplacedRackCodes = usesFloorPlan
            ? enabledRackRows.map((row) => String(row['랙코드']).trim()).filter((code) => !floorPlanByRack.has(code))
            : [];
        const racks = enabledRackRows
            .filter((row) => !usesFloorPlan || floorPlanByRack.has(String(row['랙코드']).trim()))
            .map((row) => {
                const code = String(row['랙코드']).trim();
                const placement = floorPlanByRack.get(code);
                const type = rackTypeByCode.get(row['랙타입코드']);
                const storedDirection = ['세로', 'VERTICAL', 'V'].includes(String(row['방향'] || '').trim().toUpperCase()) ? 'vertical' : 'horizontal';
                const direction = storedDirection;
                const bayCount = toNumber(row['베이 수(가로 칸 수)']);
                let rackRowCount = 1;
                let floorPlan = null;
                if (placement) {
                    const columns = placement.maxX - placement.minX + 1;
                    const rows = placement.maxY - placement.minY + 1;
                    const planLength = (direction === 'vertical' ? rows : columns) * floorPlanCellSize;
                    const planWidth = (direction === 'vertical' ? columns : rows) * floorPlanCellSize;
                    if (!type) {
                        layoutErrors.push({ code, message: '랙타입을 찾을 수 없습니다.' });
                        return null;
                    }
                    const actualLength = type.bayWidth * bayCount;
                    const actualWidth = metersToMillimeters(row['랙깊이(m)'], type.depth / 1000);
                    const expectedPlanLength = metersToMillimeters(row['평면도 랙 전체 길이(m)']);
                    const expectedPlanWidth = metersToMillimeters(row['평면도 랙 깊이(m)']);
                    rackRowCount = Math.max(1, Math.round(actualWidth / type.depth));
                    floorPlan = {
                        columns,
                        rows,
                        cellCount: placement.cellCount,
                        planLength,
                        planWidth,
                        actualLength,
                        actualWidth,
                        remainingLength: planLength - actualLength,
                        remainingWidth: planWidth - actualWidth
                    };
                    if (placement.cellCount !== columns * rows) {
                        layoutErrors.push({ code, message: '평면도 마킹이 직사각형 범위가 아닙니다.' });
                        return null;
                    }
                    if (!(bayCount > 0) || actualLength > planLength + 0.001 || actualWidth > planWidth + 0.001) {
                        layoutErrors.push({ code, message: '평면도 범위보다 실제 랙 크기가 큽니다.' });
                        return null;
                    }
                    if ((expectedPlanLength > 0 && Math.abs(expectedPlanLength - planLength) > 0.001)
                        || (expectedPlanWidth > 0 && Math.abs(expectedPlanWidth - planWidth) > 0.001)) {
                        layoutErrors.push({ code, message: '랙배치의 평면도 크기와 실제 마킹 범위가 다릅니다.' });
                        return null;
                    }
                    floorPlanAppliedCount += 1;
                }
                const xPlanGap = floorPlan ? (direction === 'vertical' ? floorPlan.remainingWidth : floorPlan.remainingLength) : 0;
                const yPlanGap = floorPlan ? (direction === 'vertical' ? floorPlan.remainingLength : floorPlan.remainingWidth) : 0;
                return {
                    code,
                    zoneCode: row['구역코드'],
                    rackTypeCode: row['랙타입코드'],
                    startX: placement ? (placement.minX - 1) * floorPlanCellSize + Math.max(0, xPlanGap) / 2 : 0,
                    startY: placement ? (placement.minY - 1) * floorPlanCellSize + Math.max(0, yPlanGap) / 2 : 0,
                    direction,
                    bayCount,
                    rackRowCount,
                    layoutSource: placement ? 'floorPlan' : 'rackPlacement',
                    floorPlan
                };
            })
            .filter(Boolean);
        const items = records.items
            .filter((row) => row['품목코드'])
            .map((row) => ({
                code: row['품목코드'],
                name: row['품목명'],
                color: row['표시색상'] || '#ef4444'
            }));
        const itemByCodeForSchedule = new Map(items.map((item) => [item.code, item]));
        const truckSchedules = records.workOrders
            .filter((row) => /^(입고|출고)$/.test(String(row['작업 구분'] || '').trim()))
            .map((row) => {
                const workType = String(row['작업 구분'] || '').trim();
                const itemCode = String(row['품목코드'] || '').trim();
                const rawDockCode = String(row['도크 코드'] || '').trim().toUpperCase();
                const dockCodeMatch = /^D(\d+)$/.exec(rawDockCode);
                return {
                    scheduleCode: String(row['작업 코드'] || '').trim(),
                    routeCode: String(row['경로 코드'] || '').trim(),
                    workType,
                    dockCode: dockCodeMatch ? `D${dockCodeMatch[1].padStart(2, '0')}` : '',
                    vehicleNumber: String(row['차량 번호'] || '').trim(),
                    senderCompanyName: String(row['보낸 회사명'] || '').trim(),
                    receiverCompanyName: String(row['받을 회사명'] || '').trim(),
                    itemCode,
                    itemName: itemByCodeForSchedule.get(itemCode)?.name || itemCode,
                    quantity: Math.max(0, toNumber(row['수량(개)']))
                };
            });
        const locations = records.locations
            .filter((row) => row['로케이션코드'])
            .map((row) => ({
                locationCode: row['로케이션코드'],
                rackCode: row['랙코드'],
                rackRow: toNumber(row['랙열번호'], 1),
                bay: toNumber(row['베이번호']),
                level: toNumber(row['단번호']),
                depth: toNumber(row['깊이번호'], 1),
                capacity: toNumber(row['최대수량'])
            }));
        const locationsByCode = new Map(locations.map((location) => [location.locationCode, location]));
        const rackByCode = new Map(racks.map((rack) => [rack.code, rack]));
        const isLocationWithinRack = (location) => {
            const rack = rackByCode.get(location?.rackCode);
            const type = rack && rackTypeByCode.get(rack.rackTypeCode);
            return Boolean(rack && location.bay >= 1 && location.bay <= rack.bayCount
                && location.rackRow >= 1 && location.rackRow <= rack.rackRowCount
                && location.level >= 1 && location.level <= type?.levels
                && location.depth >= 1 && location.depth <= type?.depthCount);
        };
        const statusMap = { 정상: 'normal', 주의: 'warning', 보류: 'hold', 불량: 'defect' };
        const visibleRackCodes = new Set(racks.map((rack) => rack.code));
        const inventory = records.inventory
            .filter((row) => {
                const location = locationsByCode.get(row['로케이션코드']);
                return row['로케이션코드'] && row['품목코드'] && toNumber(row['재고수량']) > 0
                    && (!usesFloorPlan || (visibleRackCodes.has(location?.rackCode) && isLocationWithinRack(location)));
            })
            .map((row) => {
                const location = locationsByCode.get(row['로케이션코드']) || {};
                const rawStatus = String(row['재고상태'] || '').trim();
                return {
                    locationCode: row['로케이션코드'],
                    rackCode: location.rackCode || '',
                    rackRow: location.rackRow || 1,
                    bay: location.bay || 0,
                    level: location.level || 0,
                    depth: location.depth || 1,
                    itemCode: row['품목코드'],
                    quantity: toNumber(row['재고수량']),
                    capacity: location.capacity || 0,
                    status: statusMap[rawStatus] || rawStatus.toLowerCase() || 'normal'
                };
            });

        const outOfRangeLocationCodes = locations
            .filter((location) => rackByCode.has(location.rackCode) && !isLocationWithinRack(location))
            .map((location) => location.locationCode);
        const configuredFloorPlanX = toNumber(options.floorPlanAxis?.xCount);
        const configuredFloorPlanY = toNumber(options.floorPlanAxis?.yCount);
        const floorPlanMaxX = configuredFloorPlanX > 0 ? configuredFloorPlanX : Math.max(0, ...floorPlanCells.map((cell) => cell.x));
        const floorPlanMaxY = configuredFloorPlanY > 0 ? configuredFloorPlanY : Math.max(0, ...floorPlanCells.map((cell) => cell.y));
        const floorWidth = floorPlanMaxX * floorPlanCellSize;
        const floorDepth = floorPlanMaxY * floorPlanCellSize;
        const warehouseGapCount = Math.max(0, floorPlanMaxX * floorPlanMaxY - floorPlanCells.length);
        return {
            schemaVersion: 1,
            meta: {
                name: options.name || '로컬 기준정보 창고',
                unit: 'mm',
                floorWidth,
                floorDepth,
                floorPlanCellSize,
                warehouseCellCount: floorPlanCells.length,
                warehouseGapCount,
                passageCells: passageCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize
                })),
                shuttlePassageCells: shuttlePassageCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize
                })),
                conveyorCells: conveyorCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize
                })),
                barcodeTunnelCells: barcodeTunnelCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize
                })),
                dockCells: dockCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize,
                    code: cell.code
                })),
                bufferCells: bufferCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize,
                    code: cell.code
                })),
                stationCells: stationCells.map((cell) => ({
                    x: (cell.x - 1) * floorPlanCellSize,
                    y: (cell.y - 1) * floorPlanCellSize,
                    code: cell.code
                })),
                truckSchedules,
                source: 'localReference',
                floorPlanRange: options.floorPlanAxis?.range || '',
                floorPlanAppliedCount,
                layoutErrors,
                outOfRangeLocationCodes,
                unplacedRackCodes,
                unmappedFloorRackCodes: [...unmappedFloorRackCodes]
            },
            zones, rackTypes, racks, locations, items, inventory,
            workOrders: records.workOrders.map(row => ({
                code: row['작업 코드'], direction: row['작업 구분'], status: row['작업 상태'],
                equipmentCode: row['배정 설비'], itemCode: row['품목코드'], quantity: toNumber(row['수량(개)']),
                routeCode: row['경로 코드'] || '', pickup: row['상차 지점'], dropoff: row['하차 지점'],
                barcode: String(row['바코드'] || row['팔레트 바코드'] || '').trim()
            }))
        };
    }

    function googleTableToCsv(table) {
        const escapeCell = (value) => {
            const text = String(value ?? '');
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const headers = (table?.cols || []).map((column) => escapeCell(column?.label ?? ''));
        const rows = (table?.rows || []).map((row) => (table?.cols || []).map((_, index) => {
            const cell = row?.c?.[index];
            return escapeCell(cell?.v ?? '');
        }).join(','));
        return [headers.join(','), ...rows].join('\n');
    }

    function parseEquipmentMaster(csv) {
        const records = csvToRecords(csv, ['설비 코드', '설비명', '사용 여부'], '설비 마스터');
        const seen = new Set();
        return records.filter(row => String(row['설비 코드'] || '').trim()).map(row => {
            const code = String(row['설비 코드']).trim();
            if (seen.has(code)) throw new Error(`설비 코드가 중복되었습니다: ${code}`);
            seen.add(code);
            return {
                code,
                modelName: String(row['모델명'] || '').trim(),
                name: String(row['설비명'] || '').trim() || code,
                type: String(row['타입'] || '').trim().toUpperCase(),
                enabled: String(row['사용 여부'] || '').trim().toUpperCase() === 'Y',
                configuredSpeed: Math.max(0, toNumber(row['설정 이동 속도(m/s)']))
            };
        });
    }

    function parseEquipmentStatus(csv) {
        const records = csvToRecords(csv, ['설비 코드', '통신 연결', '설비 상태'], '설비 상태 정보');
        const seen = new Set();
        const optionalNumber = (value) => String(value ?? '').trim() === '' ? null : toNumber(value);
        return records.filter(row => String(row['설비 코드'] || '').trim()).map(row => {
            const equipmentCode = String(row['설비 코드']).trim();
            if (seen.has(equipmentCode)) throw new Error(`설비 상태 정보의 설비 코드가 중복되었습니다: ${equipmentCode}`);
            seen.add(equipmentCode);
            return {
                equipmentCode,
                communicationStatus: String(row['통신 연결'] || '').trim().toUpperCase(),
                equipmentStatus: String(row['설비 상태'] || '').trim(),
                positionX: optionalNumber(row['위치 X(m)']),
                positionY: optionalNumber(row['위치 Y(m)']),
                direction: optionalNumber(row['방향(도)']),
                currentSpeed: optionalNumber(row['현재 이동 속도(m/s)']),
                battery: optionalNumber(row['배터리(%)']),
                taskCode: String(row['현재 작업 코드'] || '').trim(),
                workType: String(row['작업 구분'] || '').trim(),
                pickupLocation: String(row['상차 지점'] || '').trim(),
                pickupArrivalTime: String(row['상차 지점 실제 도착 시간'] || '').trim(),
                dropoffLocation: String(row['하차 지점'] || '').trim(),
                dropoffArrivalTime: String(row['하차 지점 실제 도착 시간'] || '').trim(),
                taskStatus: String(row['작업 상태'] || '').trim()
            };
        });
    }

    function validateWarehouseData(data) {
        const errors = [];
        if (!data || typeof data !== 'object') return ['기준정보 파일이 비어 있습니다.'];
        ['zones', 'rackTypes', 'racks', 'items', 'inventory'].forEach((key) => {
            if (!Array.isArray(data[key])) errors.push(`${key} 목록이 없습니다.`);
        });
        if (errors.length) return errors;
        const zoneCodes = new Set(data.zones.map((zone) => zone.code));
        const rackTypeCodes = new Set(data.rackTypes.map((type) => type.code));
        const itemCodes = new Set(data.items.map((item) => item.code));
        const rackCodes = new Set();
        data.racks.forEach((rack) => {
            if (!rack.code) errors.push('랙코드가 비어 있습니다.');
            else if (rackCodes.has(rack.code)) errors.push(`중복 랙코드: ${rack.code}`);
            else rackCodes.add(rack.code);
            if (!zoneCodes.has(rack.zoneCode)) errors.push(`${rack.code}: 존재하지 않는 구역 ${rack.zoneCode}`);
            if (!rackTypeCodes.has(rack.rackTypeCode)) errors.push(`${rack.code}: 존재하지 않는 랙타입 ${rack.rackTypeCode}`);
            if (!(Number(rack.bayCount) > 0)) errors.push(`${rack.code}: 베이수가 올바르지 않습니다.`);
        });
        data.inventory.forEach((stock) => {
            if (!rackCodes.has(stock.rackCode)) errors.push(`${stock.locationCode}: 존재하지 않는 랙 ${stock.rackCode}`);
            if (!itemCodes.has(stock.itemCode)) errors.push(`${stock.locationCode}: 존재하지 않는 품목 ${stock.itemCode}`);
        });
        return errors;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[character]);
    }

    const slotColorPalette = Object.freeze({
        empty: '#94a3b8',
        low: '#22c55e',
        medium: '#f59e0b',
        high: '#ef4444',
        normal: '#22c55e',
        warning: '#f59e0b',
        hold: '#a855f7',
        defect: '#ef4444',
        unknown: '#475569'
    });

    function getCartonStackLayout(width, height, depth) {
        const gap = Math.min(0.012, Math.min(width, height, depth) * 0.025);
        const cartonSize = [(width - gap) / 2, (height - gap) / 2, (depth - gap) / 2];
        const positions = [];
        for (let level = 0; level < 2; level++) for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
            positions.push({ x: (column - 0.5) * (cartonSize[0] + gap),
                y: cartonSize[1] / 2 + level * (cartonSize[1] + gap),
                z: (row - 0.5) * (cartonSize[2] + gap) });
        }
        return { cartonSize, positions, gap };
    }

    function setUnitLoadStoredAppearance(load, stored, color) {
        const cargo = load.getObjectByName('forklift-carried-load-box');
        const cartons = load.getObjectByName('transport-carton-stack');
        if (!cargo || !cartons) return;
        cargo.visible = Boolean(stored); cartons.visible = !stored;
        if (stored && color && load.userData.rackCargoColor !== color) {
            cargo.material.color.set(color); load.userData.rackCargoColor = color;
        }
        load.userData.cargoAppearance = stored ? 'rack-inventory-color' : 'kraft-carton-stack';
    }

    function getSlotVisualKey(slot, mode = 'utilization') {
        if (!slot?.occupied) return 'empty';
        if (mode === 'status') {
            const status = String(slot.stock?.status || '').trim().toLowerCase();
            return ['normal', 'warning', 'hold', 'defect'].includes(status) ? status : 'unknown';
        }
        const capacity = Number(slot.stock?.capacity || slot.location?.capacity || 0);
        if (!(capacity > 0)) return 'unknown';
        const rate = Math.max(0, Number(slot.stock?.quantity || 0) / capacity);
        if (rate < 0.5) return 'low';
        if (rate < 0.8) return 'medium';
        return 'high';
    }

    function createShell(container) {
        container.className = 'warehouse-3d-shell';
        container.innerHTML = `
            <div class="warehouse-3d-toolbar">
                <div class="warehouse-3d-brand" aria-label="TEST, WMS Test Monitoring">
                    <span class="warehouse-3d-brand-symbol" aria-hidden="true"></span>
                    <span class="warehouse-3d-brand-copy">
                        <strong>TEST</strong>
                        <small>WMS Test Monitoring</small>
                    </span>
                </div>
                <div class="warehouse-3d-kpi-list" role="list" aria-label="창고 운영 현황">
                    <div class="warehouse-3d-kpi-card is-cyan" role="listitem" data-warehouse-kpi="utilization">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z"/><path d="m4 12 8 4.5 8-4.5M4 16.5l8 4.5 8-4.5"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">전체 적재율</span>
                            <strong class="warehouse-3d-kpi-value">78.6%</strong>
                            <span class="warehouse-3d-kpi-progress" role="progressbar" aria-label="전체 적재율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="78.6"><i style="--warehouse-kpi-progress:78.6%"></i></span>
                            <small>15,720 / 20,000 셀</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-teal" role="listitem" data-warehouse-kpi="available">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="m4 6 8-4 8 4v12l-8 4-8-4V6Z"/><path d="m4 6 8 4 8-4M12 10v12"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">가용 셀</span>
                            <strong class="warehouse-3d-kpi-value">4,280</strong>
                            <small class="warehouse-3d-kpi-state">21.4%</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-blue" role="listitem" data-warehouse-kpi="inbound-progress">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6v11m0 0-4-4m4 4 4-4"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">입고 진행</span>
                            <strong class="warehouse-3d-kpi-value">12 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">진행 중</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-green" role="listitem" data-warehouse-kpi="inbound-complete">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">입고 완료</span>
                            <strong class="warehouse-3d-kpi-value">0 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">완료</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-amber" role="listitem" data-warehouse-kpi="inbound-request">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M9 2h6v4H9zM8 10h8M8 14h5"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">입고 배정/요청</span>
                            <strong class="warehouse-3d-kpi-value">0 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">배정 대기</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-blue" role="listitem" data-warehouse-kpi="outbound-progress">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 18V7m0 0-4 4m4-4 4 4"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">출고 진행</span>
                            <strong class="warehouse-3d-kpi-value">18 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">진행 중</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-green" role="listitem" data-warehouse-kpi="outbound-complete">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">출고 완료</span>
                            <strong class="warehouse-3d-kpi-value">0 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">완료</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-amber" role="listitem" data-warehouse-kpi="outbound-request">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M9 2h6v4H9zM8 10h8M8 14h5"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">출고 배정/요청</span>
                            <strong class="warehouse-3d-kpi-value">0 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">배정 대기</small>
                        </span>
                    </div>
                    <div class="warehouse-3d-kpi-card is-red" role="listitem" data-warehouse-kpi="alerts">
                        <span class="warehouse-3d-kpi-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>
                        </span>
                        <span class="warehouse-3d-kpi-content">
                            <span class="warehouse-3d-kpi-label">미처리 알람</span>
                            <strong class="warehouse-3d-kpi-value">3 <em>건</em></strong>
                            <small class="warehouse-3d-kpi-state">확인 필요</small>
                        </span>
                    </div>
                </div>
                <div class="warehouse-3d-toolbar-actions">
                    <time class="warehouse-3d-current-time" aria-label="현재 시간"></time>
                    <button class="warehouse-3d-reload" type="button" aria-label="기준정보 새로고침" title="기준정보 새로고침" hidden>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/></svg>
                    </button>
                    <button class="warehouse-3d-fullscreen" type="button" aria-label="전체화면" title="전체화면" aria-pressed="false">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path class="warehouse-3d-fullscreen-enter" d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>
                            <path class="warehouse-3d-fullscreen-exit" d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="warehouse-3d-main">
                <aside class="warehouse-3d-side-panel warehouse-3d-side-panel-left" aria-label="객체 선택 패널">
                    <div class="warehouse-3d-object-tools">
                        <label class="warehouse-3d-object-search-label">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
                            <input class="warehouse-3d-object-search" type="search" placeholder="검색" aria-label="구역·랙·설비 통합 검색" autocomplete="off"/>
                        </label>
                    </div>
                    <nav class="warehouse-3d-zone-buttons warehouse-3d-object-list" aria-label="창고 객체 탐색">
                        <button class="warehouse-3d-object-heading warehouse-3d-object-overview" type="button" aria-pressed="true" title="선택과 필터를 해제하고 전체 창고 보기">
                            <svg class="warehouse-3d-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-7v3h4v2H6v-2h4v-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/></svg><span>통합 관제</span>
                        </button>
                        <details class="warehouse-3d-object-section" data-warehouse-object-section="zone" open>
                            <summary class="warehouse-3d-object-heading"><svg class="warehouse-3d-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m2 5 6-3 8 3 6-3v17l-6 3-8-3-6 3V5Zm7 .3v11.9l6 2.3V7.6L9 5.3Z"/></svg><span>구역</span><svg class="warehouse-3d-section-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 7 7-7 7"/></svg></summary>
                            <div class="warehouse-3d-object-children" role="group" aria-label="구역 선택"></div>
                        </details>
                        <details class="warehouse-3d-object-section" data-warehouse-object-section="rack" open>
                            <summary class="warehouse-3d-object-heading"><svg class="warehouse-3d-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2h3v3h12V2h3v20h-3v-3H6v3H3V2Zm3 6v3h12V8H6Zm0 6v2h12v-2H6Z"/><path d="M8 2h4v3H8zm5 6h3v3h-3zm-5 6h4v2H8z"/></svg><span>랙</span><svg class="warehouse-3d-section-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 7 7-7 7"/></svg></summary>
                            <div class="warehouse-3d-object-children" role="group" aria-label="랙 선택"></div>
                        </details>
                        <details class="warehouse-3d-object-section" data-warehouse-object-section="equipment" open>
                            <summary class="warehouse-3d-object-heading"><svg class="warehouse-3d-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 2h2v3h5a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h5V2ZM7 10v3h3v-3H7Zm7 0v3h3v-3h-3Zm-6 7v2h8v-2H8ZM0 9h2v8H0zm22 0h2v8h-2z"/></svg><span>설비</span><svg class="warehouse-3d-section-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 7 7-7 7"/></svg></summary>
                            <div class="warehouse-3d-object-children" role="group" aria-label="설비 선택"></div>
                        </details>
                        <p class="warehouse-3d-object-empty" hidden>표시할 항목이 없습니다.</p>
                    </nav>
                    <div class="warehouse-3d-object-total" role="status" aria-live="polite">0개</div>
                </aside>
                <div class="warehouse-3d-panel-resizer warehouse-3d-panel-resizer-left" data-panel-resizer="left"
                    role="separator" aria-label="좌측 패널 너비 조절" aria-orientation="vertical"
                    aria-valuemin="230" aria-valuenow="230" tabindex="0"></div>
                <div class="warehouse-3d-viewport" aria-label="3D 창고 화면">
                    <div class="warehouse-3d-loading" role="status">3D 창고 기준정보를 불러오는 중입니다.</div>
                    <div class="warehouse-3d-slot-tooltip" role="status" hidden></div>
                    <div class="warehouse-3d-camera-views" role="group" aria-label="카메라 투영 및 구도" hidden>
                        <button class="warehouse-3d-projection-toggle" type="button" data-warehouse-projection-toggle data-projection="perspective" aria-label="현재 Perspective. Orthographic으로 전환" aria-pressed="false" title="Orthographic으로 전환">
                            <svg class="warehouse-3d-projection-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path class="warehouse-3d-projection-half warehouse-3d-projection-half-primary" d="M3.5 3.5h17l-17 17Z"/>
                                <path class="warehouse-3d-projection-half warehouse-3d-projection-half-secondary" d="M20.5 3.5v17h-17Z"/>
                                <text class="warehouse-3d-projection-letter warehouse-3d-projection-letter-p" x="8" y="9.2">P</text>
                                <text class="warehouse-3d-projection-letter warehouse-3d-projection-letter-o" x="16" y="16.5">O</text>
                                <rect class="warehouse-3d-projection-outline" x="3.5" y="3.5" width="17" height="17"/>
                            </svg>
                        </button>
                            <button type="button" data-warehouse-camera-view="quarter" aria-label="쿼터 뷰: 30도 등각으로 보기" aria-pressed="true" title="쿼터 뷰">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3Z"/><path d="m4.5 7.3 7.5 4.3 7.5-4.3M12 11.6V21"/></svg>
                            </button>
                            <button type="button" data-warehouse-camera-view="top" aria-label="탑 뷰: 중앙 위에서 보기" aria-pressed="false" title="탑 뷰">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path class="warehouse-3d-view-face" d="m12 3 7.5 4.3L12 11.6 4.5 7.3 12 3Z"/><path d="m12 3 7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3Z"/><path d="m4.5 7.3 7.5 4.3 7.5-4.3M12 11.6V21"/></svg>
                            </button>
                            <button type="button" data-warehouse-camera-view="front" aria-label="프론트 뷰: 정면에서 보기" aria-pressed="false" title="프론트 뷰">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path class="warehouse-3d-view-face" d="M4.5 7.3 12 11.6V21l-7.5-4.3V7.3Z"/><path d="m12 3 7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3Z"/><path d="m4.5 7.3 7.5 4.3 7.5-4.3M12 11.6V21"/></svg>
                            </button>
                            <button type="button" data-warehouse-camera-view="side" aria-label="사이드 뷰: 측면에서 보기" aria-pressed="false" title="사이드 뷰">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path class="warehouse-3d-view-face" d="M12 11.6 19.5 7.3v9.4L12 21v-9.4Z"/><path d="m12 3 7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3Z"/><path d="m4.5 7.3 7.5 4.3 7.5-4.3M12 11.6V21"/></svg>
                            </button>
                            <button type="button" data-warehouse-grid-toggle aria-label="Grid 숨기기" aria-pressed="true" title="Grid 켜기/끄기">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM4 9h16M4 14h16M9 4v16M14 4v16"/></svg>
                            </button>
                    </div>
                    <div class="warehouse-3d-legend" aria-label="선택한 재고 보기의 색상 범례">
                        <div class="warehouse-3d-view-toggle" role="group" aria-label="재고 색상 보기 기준">
                            <button type="button" data-warehouse-view="utilization" aria-pressed="true">적재율</button>
                            <button type="button" data-warehouse-view="status" aria-pressed="false">재고 상태</button>
                        </div>
                        <div class="warehouse-3d-legend-items"></div>
                    </div>
                </div>
                <div class="warehouse-3d-panel-resizer warehouse-3d-panel-resizer-right" data-panel-resizer="right"
                    role="separator" aria-label="우측 패널 너비 조절" aria-orientation="vertical"
                    aria-valuemin="230" aria-valuenow="230" tabindex="0"></div>
                <aside class="warehouse-3d-side-panel warehouse-3d-inspector" aria-live="polite">
                    <h5>선택 정보</h5>
                    <p>랙이나 적재 상자를 선택하면 상세 정보가 표시됩니다.</p>
                </aside>
                <div class="warehouse-3d-bottom-panel" aria-label="하단 패널"></div>
            </div>`;
        return {
            root: container,
            main: container.querySelector('.warehouse-3d-main'),
            viewport: container.querySelector('.warehouse-3d-viewport'),
            loading: container.querySelector('.warehouse-3d-loading'),
            hoverTooltip: container.querySelector('.warehouse-3d-slot-tooltip'),
            inspector: container.querySelector('.warehouse-3d-inspector'),
            reload: container.querySelector('.warehouse-3d-reload'),
            fullscreen: container.querySelector('.warehouse-3d-fullscreen'),
            viewButtons: [...container.querySelectorAll('[data-warehouse-view]')],
            projectionToggle: container.querySelector('[data-warehouse-projection-toggle]'),
            cameraViews: container.querySelector('.warehouse-3d-camera-views'),
            cameraViewButtons: [...container.querySelectorAll('[data-warehouse-camera-view]')],
            gridToggle: container.querySelector('[data-warehouse-grid-toggle]'),
            legendItems: container.querySelector('.warehouse-3d-legend-items'),
            legend: container.querySelector('.warehouse-3d-legend'),
            currentTime: container.querySelector('.warehouse-3d-current-time'),
            leftPanel: container.querySelector('.warehouse-3d-side-panel-left'),
            zoneButtons: container.querySelector('.warehouse-3d-zone-buttons'),
            objectSections: [...container.querySelectorAll('[data-warehouse-object-section]')],
            objectOverview: container.querySelector('.warehouse-3d-object-overview'),
            objectEmpty: container.querySelector('.warehouse-3d-object-empty'),
            objectSearch: container.querySelector('.warehouse-3d-object-search'),
            objectTotal: container.querySelector('.warehouse-3d-object-total'),
            rightPanel: container.querySelector('.warehouse-3d-inspector'),
            panelResizers: [...container.querySelectorAll('[data-panel-resizer]')]
        };
    }

    function setupPanelResizing(shell, signal) {
        const minimumPanelWidth = 230;
        const minimumViewportWidth = 320;
        const widths = { left: minimumPanelWidth, right: minimumPanelWidth };
        let activeResize = null;

        const getHandleWidth = () => shell.panelResizers.reduce((total, handle) => total + handle.offsetWidth, 0);
        const isStacked = () => shell.panelResizers.some(handle => getComputedStyle(handle).display === 'none');
        const getMaximumPanelWidth = side => {
            const mainWidth = shell.main.clientWidth;
            const otherWidth = widths[side === 'left' ? 'right' : 'left'];
            return Math.max(minimumPanelWidth, Math.min(
                mainWidth / 2,
                mainWidth - otherWidth - getHandleWidth() - minimumViewportWidth
            ));
        };
        const updatePanelLayout = () => {
            shell.main.style.setProperty('--warehouse-left-panel-width', widths.left + 'px');
            shell.main.style.setProperty('--warehouse-right-panel-width', widths.right + 'px');
            shell.panelResizers.forEach(handle => {
                const side = handle.dataset.panelResizer;
                handle.setAttribute('aria-valuenow', String(Math.round(widths[side])));
                handle.setAttribute('aria-valuemax', String(Math.floor(getMaximumPanelWidth(side))));
            });
        };
        const setPanelWidth = (side, value) => {
            widths[side] = Math.max(minimumPanelWidth, Math.min(getMaximumPanelWidth(side), value));
            updatePanelLayout();
        };
        const normalizePanelWidths = () => {
            if (!shell.main.clientWidth || isStacked()) return;
            const halfWidth = shell.main.clientWidth / 2;
            widths.left = Math.max(minimumPanelWidth, Math.min(halfWidth, widths.left));
            widths.right = Math.max(minimumPanelWidth, Math.min(halfWidth, widths.right));
            const combinedLimit = Math.max(
                minimumPanelWidth * 2,
                shell.main.clientWidth - getHandleWidth() - minimumViewportWidth
            );
            if (widths.left + widths.right > combinedLimit) {
                const availableExtra = Math.max(0, combinedLimit - minimumPanelWidth * 2);
                const leftExtra = widths.left - minimumPanelWidth;
                const rightExtra = widths.right - minimumPanelWidth;
                const totalExtra = leftExtra + rightExtra;
                const ratio = totalExtra > 0 ? availableExtra / totalExtra : 0;
                widths.left = minimumPanelWidth + leftExtra * ratio;
                widths.right = minimumPanelWidth + rightExtra * ratio;
            }
            updatePanelLayout();
        };
        const finishResize = (handle, pointerId) => {
            if (!activeResize) return;
            if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            activeResize = null;
            shell.root.classList.remove('is-resizing-panels');
        };

        shell.panelResizers.forEach(handle => {
            const side = handle.dataset.panelResizer;
            handle.addEventListener('pointerdown', event => {
                if (event.button !== 0 || isStacked()) return;
                event.preventDefault();
                activeResize = { side, startX: event.clientX, startWidth: widths[side], pointerId: event.pointerId };
                shell.root.classList.add('is-resizing-panels');
                handle.setPointerCapture(event.pointerId);
            }, { signal });
            handle.addEventListener('pointermove', event => {
                if (!activeResize || activeResize.pointerId !== event.pointerId) return;
                const direction = activeResize.side === 'left' ? 1 : -1;
                setPanelWidth(activeResize.side, activeResize.startWidth + (event.clientX - activeResize.startX) * direction);
            }, { signal });
            handle.addEventListener('pointerup', event => finishResize(handle, event.pointerId), { signal });
            handle.addEventListener('pointercancel', event => finishResize(handle, event.pointerId), { signal });
            handle.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || isStacked()) return;
                event.preventDefault();
                const direction = side === 'left'
                    ? (event.key === 'ArrowRight' ? 1 : -1)
                    : (event.key === 'ArrowLeft' ? 1 : -1);
                setPanelWidth(side, widths[side] + direction * 16);
            }, { signal });
        });
        const panelResizeObserver = new ResizeObserver(normalizePanelWidths);
        panelResizeObserver.observe(shell.main);
        updatePanelLayout();
        return () => {
            activeResize = null;
            shell.root.classList.remove('is-resizing-panels');
            panelResizeObserver.disconnect();
        };
    }

    function showError(shell, messages) {
        if (!shell.loading.isConnected) shell.viewport.append(shell.loading);
        shell.loading.className = 'warehouse-3d-error';
        shell.loading.innerHTML = `<strong>3D 창고를 표시하지 못했습니다.</strong><ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
    }

    function createLabelSprite(THREE, text, { sizeScale = 1, fontWeight = 700, border = true } = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = 256 * worldUiResolutionScale;
        canvas.height = 72 * worldUiResolutionScale;
        const context = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
        const sprite = new THREE.Sprite(material);
        const visuals = {
            normal: { fill: '#050f1e', stroke: '#3b82f6', text: '#ffffff', scale: 1 },
            hover: { fill: '#0f3460', stroke: '#78ABFF', text: '#ffffff', scale: 1.06 },
            selected: { fill: '#2563EB', stroke: '#BFDBFE', text: '#ffffff', scale: 1.1 }
        };
        const baseOpacity = 1;
        // Scale the entire sprite (including text), keeping the canvas resolution sharp.
        const applyScale = (scale) => sprite.scale.set(3.2 * sizeScale * scale, 0.9 * sizeScale * scale, 1);
        let displayedScale = 1;

        const drawLabel = (state = 'normal') => {
            const visual = visuals[state] || visuals.normal;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = visual.fill;
            context.fillRect(6, 6, 500, 132);
            if (border) {
                context.strokeStyle = visual.stroke;
                context.lineWidth = 6;
                context.strokeRect(6, 6, 500, 132);
            }
            context.fillStyle = visual.text;
            context.font = `${fontWeight} 64px sans-serif`;
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(text, 256, 72, 460);
            texture.needsUpdate = true;
        };
        sprite.setInteractionState = (state = 'normal') => {
            const visual = visuals[state] || visuals.normal;
            drawLabel(state);
            const startScale = displayedScale;
            const targetScale = visual.scale;
            material.opacity = baseOpacity;
            return (progress) => {
                displayedScale = startScale + (targetScale - startScale) * progress;
                applyScale(displayedScale);
                material.opacity = baseOpacity;
            };
        };
        drawLabel('normal');
        applyScale(displayedScale);
        material.opacity = baseOpacity;
        sprite.renderOrder = billboardRenderOrder;
        return sprite;
    }

    function createTruckInfoBillboardSprite(THREE, info = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = 520 * worldUiResolutionScale;
        canvas.height = 300 * worldUiResolutionScale;
        const context = canvas.getContext('2d');
        context.scale(worldUiResolutionScale, worldUiResolutionScale);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
        const sprite = new THREE.Sprite(material);
        const workType = String(info.workType || '').trim() || '입고';
        const companyLabel = workType === '출고' ? '공급처' : '납품처';
        const vehicleNumber = String(info.vehicleNumber || '').trim() || '부산12가3456';
        const companyName = String((workType === '출고' ? info.receiverCompanyName : info.senderCompanyName) || '').trim() || '미설정';
        const itemName = String(info.itemName || info.itemCode || '').trim();
        const itemQuantity = Number(info.quantity);
        const itemSummary = itemName
            ? `${itemName} · ${Number.isFinite(itemQuantity) ? itemQuantity.toLocaleString('ko-KR') : 0}개`
            : '미설정';
        const operationColor = workType === '출고' ? '#fb923c' : '#22d3ee';
        const invoiceButtonLabel = '송장보기';
        let progressStatus = workType === '출고' ? '상차 대기' : '하차 대기';

        const draw = () => {
            context.clearRect(0, 0, 520, 300);
            context.fillStyle = 'rgba(5, 15, 30, 0.96)';
            context.beginPath();
            context.roundRect(8, 8, 504, 284, 20);
            context.fill();
            context.strokeStyle = '#38bdf8';
            context.lineWidth = 5;
            context.stroke();

            // Match the rendered text size of the transport-equipment billboard.
            context.fillStyle = operationColor;
            context.font = '700 32px sans-serif';
            context.textAlign = 'left';
            context.textBaseline = 'middle';
            context.fillText(workType, 28, 44);
            context.fillStyle = '#ffffff';
            context.font = '600 32px sans-serif';
            context.fillText(vehicleNumber, 104, 44, 392);

            context.strokeStyle = 'rgba(125, 211, 252, 0.35)';
            context.lineWidth = 2;
            context.beginPath();
            context.moveTo(24, 78);
            context.lineTo(496, 78);
            context.stroke();

            const rows = [[companyLabel, companyName], [`${workType} 예정`, itemSummary], ['진행상태', progressStatus]];
            rows.forEach(([label, value], index) => {
                const y = 116 + index * 50;
                context.fillStyle = '#94a3b8';
                context.font = '600 25px sans-serif';
                context.textAlign = 'left';
                context.fillText(label, 28, y);
                context.fillStyle = index === 2 ? (progressStatus.endsWith('완료') ? '#4ade80' : operationColor) : '#ffffff';
                context.font = '600 32px sans-serif';
                context.fillText(value, 136, y, 360);
            });
            context.fillStyle = 'rgba(56, 189, 248, 0.12)';
            context.strokeStyle = '#38bdf8';
            context.lineWidth = 3;
            context.beginPath();
            context.roundRect(24, 242, 472, 40, 10);
            context.fill();
            context.stroke();
            context.fillStyle = '#ffffff';
            context.font = '600 25px sans-serif';
            context.textAlign = 'center';
            context.fillText(invoiceButtonLabel, 260, 262, 440);
            texture.needsUpdate = true;
        };
        draw();
        sprite.scale.set(3.96, 3.96 * 300 / 520, 1);
        sprite.renderOrder = billboardRenderOrder;
        sprite.userData = {
            kind: 'truck-info-billboard',
            fields: ['vehicleNumber', 'companyName', 'scheduledItemQuantity'],
            workType,
            vehicleNumber,
            companyLabel,
            companyName,
            itemSummary,
            invoiceButtonLabel,
            progressStatus,
            invoicePlacement: 'bottom-full-width',
            spacing: 'compact',
            fontReference: 'transport-equipment-billboard'
        };
        sprite.setProgressStatus = status => {
            if (progressStatus === status) return;
            progressStatus = status;
            sprite.userData.progressStatus = status;
            draw();
        };
        return sprite;
    }

    function getTruckInvoiceHtml(info, dockCode, warehouseName, order = {}, viewedAt = new Date()) {
        const workType = info.workType === '출고' ? '출고' : '입고';
        const field = value => escapeHtml(String(value || '미등록'));
        const quantity = Math.max(0, Number(info.quantity) || 0).toLocaleString('ko-KR');
        const sender = workType === '입고' ? info.senderCompanyName : warehouseName;
        const receiver = workType === '출고' ? info.receiverCompanyName : warehouseName;
        return `<article class="warehouse-invoice-paper">
            <header class="warehouse-invoice-heading"><div><p>DELIVERY NOTE</p><h2>${workType} 운송 송장</h2></div><span class="warehouse-invoice-type">${workType}</span></header>
            <dl class="warehouse-invoice-meta"><div><dt>작업 참조번호</dt><dd>${field(info.scheduleCode)}</dd></div><div><dt>조회 시간</dt><dd>${escapeHtml(formatLocalDateTime(viewedAt))}</dd></div><div><dt>차량 번호</dt><dd>${field(info.vehicleNumber || '부산12가3456')}</dd></div><div><dt>하역 도크 / 운영 경로</dt><dd>${field(dockCode)} / ${field(info.routeCode)}</dd></div><div><dt>진행 상태</dt><dd>${field(info.progressStatus)}</dd></div></dl>
            <div class="warehouse-invoice-parties"><section><h3>발송 정보 · ${workType === '입고' ? '납품처' : '출고처'}</h3><p>${field(sender)}</p></section><section><h3>수령 정보 · ${workType === '입고' ? '입고처' : '공급처'}</h3><p>${field(receiver)}</p></section></div>
            <h3 class="warehouse-invoice-section-title">${workType} 예정 물품</h3><div class="warehouse-invoice-table-scroll"><table><thead><tr><th scope="col">품목 코드</th><th scope="col">품명</th><th scope="col">바코드 정보</th><th scope="col">예정 수량</th><th scope="col">단위</th></tr></thead><tbody><tr><td>${field(info.itemCode)}</td><td>${field(info.itemName || info.itemCode)}</td><td>${field(order.barcode)}</td><td class="warehouse-invoice-quantity">${quantity}</td><td>개</td></tr></tbody><tfoot><tr><th colspan="3" scope="row">합계</th><td class="warehouse-invoice-quantity">${quantity}</td><td>개</td></tr></tfoot></table></div>
            <section class="warehouse-invoice-notes"><h3>인계 사항</h3><p>품목과 수량은 차량에 연결된 작업지시를 기준으로 표시합니다.</p></section>
            <div class="warehouse-invoice-signatures"><section><h3>인계자 확인</h3><p>성명 / 서명</p></section><section><h3>운송 담당 확인</h3><p>성명 / 서명</p></section><section><h3>인수자 확인</h3><p>성명 / 서명</p></section></div>
        </article>`;
    }

    function createLevelBadgeSprite(THREE, level) {
        const canvas = document.createElement('canvas');
        canvas.width = 128 * worldUiResolutionScale;
        canvas.height = 128 * worldUiResolutionScale;
        const context = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
        const sprite = new THREE.Sprite(material);
        const visuals = {
            normal: { fill: '#071a2e', stroke: '#F5B942', text: '#ffffff', scale: 1 },
            hover: { fill: '#0f3460', stroke: '#FFE082', text: '#ffffff', scale: 1.08 },
            selected: { fill: '#2563EB', stroke: '#ffffff', text: '#ffffff', scale: 1.12 }
        };
        const baseOpacity = 1;
        const applyScale = scale => sprite.scale.set(0.72 * scale, 0.72 * scale, 1);
        let displayedScale = 1;

        const drawBadge = (state = 'normal') => {
            const visual = visuals[state] || visuals.normal;
            const center = canvas.width / 2;
            const radius = 45 * worldUiResolutionScale;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.beginPath();
            context.arc(center, center, radius, 0, Math.PI * 2);
            context.fillStyle = visual.fill;
            context.fill();
            context.strokeStyle = visual.stroke;
            context.lineWidth = 5 * worldUiResolutionScale;
            context.stroke();
            context.fillStyle = visual.text;
            context.font = `700 ${32 * worldUiResolutionScale}px sans-serif`;
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(`L${level}`, center, center + worldUiResolutionScale, 82 * worldUiResolutionScale);
            texture.needsUpdate = true;
        };
        sprite.setInteractionState = (state = 'normal') => {
            const visual = visuals[state] || visuals.normal;
            drawBadge(state);
            const startScale = displayedScale;
            const targetScale = visual.scale;
            material.opacity = baseOpacity;
            return (progress) => {
                displayedScale = startScale + (targetScale - startScale) * progress;
                applyScale(displayedScale);
                material.opacity = baseOpacity;
            };
        };
        drawBadge('normal');
        applyScale(displayedScale);
        material.opacity = baseOpacity;
        sprite.renderOrder = billboardRenderOrder;
        sprite.userData = sprite.userData || {};
        sprite.userData.badgeShape = 'circle';
        return sprite;
    }

    function getAmrInspectorHtml(amr) {
        const code = amr.equipmentCode || '미설정';
        const name = amr.equipmentName || code;
        const communication = String(amr.communicationStatus || '').trim().toUpperCase();
        const communicationText = communication === 'ONLINE' ? '온라인 (ONLINE)'
            : communication === 'OFFLINE' ? '오프라인 (OFFLINE)' : '미설정';
        const equipmentType = amr.equipmentType || amr.kindLabel || '미설정';
        const configuredSpeed = Number.isFinite(amr.configuredSpeed) && amr.configuredSpeed > 0
            ? `${amr.configuredSpeed.toFixed(2)} m/s` : '미설정';
        const currentSpeed = Number.isFinite(amr.currentSpeed) ? `${amr.currentSpeed.toFixed(2)} m/s` : '미설정';
        const battery = Number.isFinite(amr.battery) ? `${Math.round(amr.battery)}%` : '미설정';
        return `<h5>${escapeHtml(name)}</h5><dl class="warehouse-3d-amr-details"><dt>설비 코드</dt><dd>${escapeHtml(code)}</dd><dt>설비명</dt><dd>${escapeHtml(name)}</dd><dt>타입</dt><dd>${escapeHtml(equipmentType)}</dd><dt>통신 연결 상태</dt><dd>${escapeHtml(communicationText)}</dd><dt>설비 상태</dt><dd>${escapeHtml(amr.equipmentStatus || '미설정')}</dd><dt>설정 속도</dt><dd>${escapeHtml(configuredSpeed)}</dd><dt>현재 속도</dt><dd>${escapeHtml(currentSpeed)}</dd><dt>배터리</dt><dd>${escapeHtml(battery)}</dd></dl><button type="button" class="warehouse-3d-history-button" data-warehouse-history="transport">작업 이력 보기</button>`;
    }

    function getTransportHistoryHtml(equipment) {
        const history = [...(equipment.transportHistory || [])].sort((a, b) =>
            Number(a.status === '배정 대기') - Number(b.status === '배정 대기')
            || String(b.unloadedAt || b.loadedAt || b.assignedAt).localeCompare(String(a.unloadedAt || a.loadedAt || a.assignedAt)));
        return history.map(record => `<tr data-transport-job="${escapeHtml(record.jobCode)}"><td class="warehouse-history-item">${escapeHtml(record.itemInfo)}</td><td>${escapeHtml(record.barcode)}</td><td>${getHistoryStatusHtml(record.status)}</td><td>${getHistoryTimeHtml(record.assignedAt)}</td><td>${escapeHtml(record.from)}</td><td>${getHistoryTimeHtml(record.loadedAt)}</td><td>${escapeHtml(record.to)}</td><td>${getHistoryTimeHtml(record.unloadedAt)}</td></tr>`).join('')
            || '<tr><td colspan="8" class="warehouse-history-empty">아직 배정된 운반 작업이 없습니다.</td></tr>';
    }

    function getHistoryTimeHtml(value) {
        return value ? `<time datetime="${escapeHtml(value)}">${escapeHtml(formatLocalDateTime(new Date(value)))}</time>` : '—';
    }

    function formatLocalDateTime(value) {
        const pad = part => String(part).padStart(2, '0');
        const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
        const hours = value.getHours();
        return `${date} ${hours < 12 ? '오전' : '오후'} ${hours % 12 || 12}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    }

    function getHistoryStatusHtml(status) {
        const color = /(보류|오류|실패)/.test(status) ? '#dc2626'
            : /(운반|이동)/.test(status) ? '#2563eb'
            : status === '정상 인식' ? '#15803d' : getAmrEquipmentStatusColor(status);
        return `<span class="warehouse-history-status" style="background:${color}">${escapeHtml(status)}</span>`;
    }

    function getScanHistoryHtml(entry) {
        return (entry.history || []).map(record => `<tr><td>${getHistoryTimeHtml(record.passedAt)}</td><td class="warehouse-history-item">${escapeHtml(record.itemInfo)}</td><td>${escapeHtml(record.barcode)}</td><td>${getHistoryStatusHtml(record.result)}</td><td>${escapeHtml(record.destination)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="warehouse-history-empty">아직 통과한 물품이 없습니다.</td></tr>';
    }

    function getAmrEquipmentStatusColor(status) {
        const value = String(status || '').trim().toUpperCase();
        if (/(오류|고장|비상|ERROR|FAULT|ALARM)/.test(value)) return '#dc2626';
        if (/(충전|CHARG)/.test(value)) return '#7c3aed';
        if (/(이동|주행|운송|DRIV|MOV|TRANSPORT)/.test(value)) return '#2563eb';
        if (/(작업|상차|하차|피킹|적치|WORK|PICK|LOAD|UNLOAD)/.test(value)) return '#d97706';
        if (/(완료|COMPLETE|DONE)/.test(value)) return '#15803d';
        return '#475569';
    }

    function createAmrLabelSprite(THREE, { name, communicationStatus, equipmentStatus, parentScale = 1 }) {
        const canvas = document.createElement('canvas');
        canvas.width = 320 * worldUiResolutionScale;
        canvas.height = 180 * worldUiResolutionScale;
        const context = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
        const sprite = new THREE.Sprite(material);
        let statusText = String(equipmentStatus || '').trim() || '미설정';
        const isOnline = String(communicationStatus || '').trim().toUpperCase() === 'ONLINE';
        const communicationColor = isOnline ? '#00FF00' : '#9ca3af';
        let equipmentStatusColor = getAmrEquipmentStatusColor(statusText);
        const visuals = {
            normal: { fill: '#050f1e', scale: 1 },
            hover: { fill: '#0f3460', scale: 1.06 },
            selected: { fill: '#2563EB', scale: 1.1 }
        };
        const baseOpacity = 1;
        const applyScale = scale => sprite.scale.set(1.84 * scale / parentScale, 1.035 * scale / parentScale, 1);
        let displayedScale = 1;
        const drawLabel = (state = 'normal') => {
            const visual = visuals[state] || visuals.normal;
            context.clearRect(0, 0, canvas.width, canvas.height);

            // The upper status row has no shared frame: only the wireless icon and status label are drawn.
            context.strokeStyle = communicationColor;
            context.lineWidth = 14;
            context.lineCap = 'round';
            [[36, 0.78], [62, 0.72]].forEach(([radius, angle]) => {
                context.beginPath();
                context.arc(110, 106, radius, -angle, angle);
                context.stroke();
                context.beginPath();
                context.arc(110, 106, radius, Math.PI - angle, Math.PI + angle);
                context.stroke();
            });
            context.beginPath();
            context.fillStyle = communicationColor;
            context.arc(110, 106, 17, 0, Math.PI * 2);
            context.fill();

            context.fillStyle = equipmentStatusColor;
            context.beginPath();
            context.roundRect(230, 48, 378, 116, 28);
            context.fill();
            context.fillStyle = '#ffffff';
            context.font = '600 50px sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(statusText, 419, 106, 330);

            // Keep the AMR name as a visually separate lower UI panel.
            context.fillStyle = visual.fill;
            context.beginPath();
            context.roundRect(8, 188, 624, 164, 28);
            context.fill();
            context.fillStyle = '#ffffff';
            context.font = '400 64px sans-serif';
            context.fillText(String(name || ''), 320, 270, 560);
            texture.needsUpdate = true;
        };
        sprite.setInteractionState = (state = 'normal') => {
            const visual = visuals[state] || visuals.normal;
            drawLabel(state);
            const startScale = displayedScale;
            const targetScale = visual.scale;
            material.opacity = baseOpacity;
            return progress => {
                displayedScale = startScale + (targetScale - startScale) * progress;
                applyScale(displayedScale);
                material.opacity = baseOpacity;
            };
        };
        drawLabel('normal');
        applyScale(displayedScale);
        material.opacity = baseOpacity;
        sprite.renderOrder = billboardRenderOrder;
        sprite.userData = { communicationStatus: isOnline ? 'ONLINE' : 'OFFLINE', equipmentStatus: statusText, communicationColor, equipmentStatusColor };
        sprite.setOperationStatus = (status) => {
            if (statusText === status) return;
            statusText = status; equipmentStatusColor = getAmrEquipmentStatusColor(status);
            sprite.userData.equipmentStatus = status;
            sprite.userData.equipmentStatusColor = equipmentStatusColor;
            drawLabel('normal');
        };
        return sprite;
    }

    function calculateZoneFloorBounds(racks, rackTypes, clearance = 500, boundaryWidth = 0) {
        const typeByCode = new Map((rackTypes || []).map((type) => [type.code, type]));
        const boundsByZone = new Map();
        (racks || []).forEach((rack) => {
            const zoneCode = String(rack?.zoneCode || '').trim();
            const type = typeByCode.get(rack?.rackTypeCode);
            if (!zoneCode || !type) return;
            const length = Math.max(0, toNumber(type.bayWidth) * Math.max(0, toNumber(rack.bayCount)));
            const width = Math.max(0, toNumber(type.depth) * Math.max(1, toNumber(rack.rackRowCount, 1)));
            if (!(length > 0) || !(width > 0)) return;
            const startX = toNumber(rack.startX);
            const startY = toNumber(rack.startY);
            const vertical = rack.direction === 'vertical';
            const footprint = rack.footprint || (vertical
                ? { minX: startX, maxX: startX + width, minY: startY, maxY: startY + length }
                : { minX: startX, maxX: startX + length, minY: startY, maxY: startY + width });
            const bounds = boundsByZone.get(zoneCode) || { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            bounds.minX = Math.min(bounds.minX, footprint.minX);
            bounds.maxX = Math.max(bounds.maxX, footprint.maxX);
            bounds.minY = Math.min(bounds.minY, footprint.minY);
            bounds.maxY = Math.max(bounds.maxY, footprint.maxY);
            boundsByZone.set(zoneCode, bounds);
        });
        const expansion = clearance + boundaryWidth / 2;
        return [...boundsByZone.entries()].map(([zoneCode, bounds]) => ({
            zoneCode,
            minX: bounds.minX - expansion,
            maxX: bounds.maxX + expansion,
            minY: bounds.minY - expansion,
            maxY: bounds.maxY + expansion
        }));
    }
    function getWarehouseStructureOcclusion(cameraPosition, floorWidth, floorDepth, warehouseHeight) {
        const width = Math.max(0.001, toNumber(floorWidth, 1));
        const depth = Math.max(0.001, toNumber(floorDepth, 1));
        const height = Math.max(0.001, toNumber(warehouseHeight, 1));
        const relativeX = (toNumber(cameraPosition?.x, width / 2) - width / 2) / (width / 2);
        const relativeZ = (toNumber(cameraPosition?.z, depth / 2) - depth / 2) / (depth / 2);
        const wallScores = {
            back: -relativeZ,
            front: relativeZ,
            left: -relativeX,
            right: relativeX
        };
        return {
            wallScores,
            hiddenWalls: Object.entries(wallScores)
                .filter(([, score]) => score > 0.18)
                .map(([side]) => side),
            ceilingHidden: toNumber(cameraPosition?.y) > height + 0.25
        };
    }
    function calculateLoadingDockLayouts(
        racks,
        rackTypes,
        floorWidth,
        floorDepth,
        rackCode = 'W04',
        dockCells = [],
        floorPlanCellSize = 500,
        dockRegions = null
    ) {
        const width = Math.max(0, toNumber(floorWidth));
        const depth = Math.max(0, toNumber(floorDepth));
        if (!width || !depth) return [];

        const buildLayout = (bounds, candidateSides, source, sourceCode, cellCount = 0) => {
            const distances = {
                back: Math.max(0, bounds.minZ),
                front: Math.max(0, depth - bounds.maxZ),
                left: Math.max(0, bounds.minX),
                right: Math.max(0, width - bounds.maxX)
            };
            const side = candidateSides.reduce((nearest, candidate) =>
                distances[candidate] < distances[nearest] ? candidate : nearest
            );
            const halfTruckWidth = 1100;
            const edgeClearance = 250;
            const clampAlongWall = (value, maximum) => Math.min(
                Math.max(halfTruckWidth + edgeClearance, value),
                Math.max(halfTruckWidth + edgeClearance, maximum - halfTruckWidth - edgeClearance)
            );
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const centerZ = (bounds.minZ + bounds.maxZ) / 2;
            const sideSettings = {
                back: { anchorX: clampAlongWall(centerX, width), anchorZ: 0, outwardX: 0, outwardZ: -1, yaw: Math.PI },
                front: { anchorX: clampAlongWall(centerX, width), anchorZ: depth, outwardX: 0, outwardZ: 1, yaw: 0 },
                left: { anchorX: 0, anchorZ: clampAlongWall(centerZ, depth), outwardX: -1, outwardZ: 0, yaw: -Math.PI / 2 },
                right: { anchorX: width, anchorZ: clampAlongWall(centerZ, depth), outwardX: 1, outwardZ: 0, yaw: Math.PI / 2 }
            };
            return { rackCode: sourceCode, source, cellCount, side, bounds, distances, ...sideSettings[side] };
        };

        if (Array.isArray(dockRegions)) return dockRegions.map(region => buildLayout(region.bounds, ['front','back','left','right'], 'drawingDock', region.code));
        const size = Math.max(1, toNumber(floorPlanCellSize, 500));
        const markedDockCells = (Array.isArray(dockCells) ? dockCells : [])
            .map((cell) => ({
                x: toNumber(cell?.x, NaN),
                y: toNumber(cell?.y, NaN),
                code: /^D\d+$/.test(String(cell?.code || '').toUpperCase()) ? String(cell.code).toUpperCase() : 'D01'
            }))
            .filter((cell) => Number.isFinite(cell.x) && Number.isFinite(cell.y));
        if (markedDockCells.length) {
            return [...new Set(markedDockCells.map((cell) => cell.code))].sort().map((dockCode) => {
                const cellsForDock = markedDockCells.filter((cell) => cell.code === dockCode);
                const bounds = {
                    minX: Math.min(...cellsForDock.map((cell) => cell.x)),
                    maxX: Math.max(...cellsForDock.map((cell) => cell.x)) + size,
                    minZ: Math.min(...cellsForDock.map((cell) => cell.y)),
                    maxZ: Math.max(...cellsForDock.map((cell) => cell.y)) + size
                };
                return buildLayout(bounds, ['front', 'back', 'left', 'right'], 'floorPlanDock', dockCode, cellsForDock.length);
            });
        }

        const rack = (Array.isArray(racks) ? racks : []).find((item) => String(item?.code || '').trim() === rackCode);
        const type = (Array.isArray(rackTypes) ? rackTypes : []).find((item) => item?.code === rack?.rackTypeCode);
        if (!rack || !type) return [];
        const rackLength = Math.max(0, toNumber(type.bayWidth) * Math.max(1, Math.round(toNumber(rack.bayCount, 1))));
        const rackWidth = Math.max(0, toNumber(type.depth) * Math.max(1, Math.round(toNumber(rack.rackRowCount, 1))));
        const startX = toNumber(rack.startX);
        const startZ = toNumber(rack.startY);
        const bounds = rack.direction === 'vertical'
            ? { minX: startX, maxX: startX + rackWidth, minZ: startZ, maxZ: startZ + rackLength }
            : { minX: startX, maxX: startX + rackLength, minZ: startZ, maxZ: startZ + rackWidth };
        const candidateSides = rack.direction === 'vertical' ? ['right', 'left'] : ['front', 'back'];
        return [buildLayout(bounds, candidateSides, 'rack', rackCode)];
    }

    function calculateLoadingDockLayout(...args) {
        return calculateLoadingDockLayouts(...args)[0] || null;
    }

    function calculateLoadingYardLayout(loadingDockLayout, floorWidth, floorDepth, yardDepth = 15000, shoulder = 2000) {
        if (!loadingDockLayout) return null;
        const width = Math.max(0, toNumber(floorWidth));
        const depth = Math.max(0, toNumber(floorDepth));
        const approachDepth = Math.max(1000, toNumber(yardDepth, 15000));
        const sideShoulder = Math.max(0, toNumber(shoulder, 2000));
        if (!width || !depth) return null;
        const layouts = {
            back: {
                centerX: width / 2,
                centerZ: -approachDepth / 2,
                sizeX: width + sideShoulder * 2,
                sizeZ: approachDepth
            },
            front: {
                centerX: width / 2,
                centerZ: depth + approachDepth / 2,
                sizeX: width + sideShoulder * 2,
                sizeZ: approachDepth
            },
            left: {
                centerX: -approachDepth / 2,
                centerZ: depth / 2,
                sizeX: approachDepth,
                sizeZ: depth + sideShoulder * 2
            },
            right: {
                centerX: width + approachDepth / 2,
                centerZ: depth / 2,
                sizeX: approachDepth,
                sizeZ: depth + sideShoulder * 2
            }
        };
        return { side: loadingDockLayout.side, approachDepth, ...layouts[loadingDockLayout.side] };
    }

    function calculateTruckYardPlacement(dock, yard, footprint) {
        if (!dock || !yard || !footprint) return null;
        const yaw = { front: 0, back: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 }[yard.side];
        if (!Number.isFinite(yaw)) return null;
        const corners = [footprint.minX, footprint.maxX].flatMap((x) =>
            [footprint.minZ, footprint.maxZ].map((z) => ({
                x: x * Math.cos(yaw) + z * Math.sin(yaw),
                z: -x * Math.sin(yaw) + z * Math.cos(yaw)
            }))
        );
        const minX = Math.min(...corners.map((point) => point.x));
        const maxX = Math.max(...corners.map((point) => point.x));
        const minZ = Math.min(...corners.map((point) => point.z));
        const maxZ = Math.max(...corners.map((point) => point.z));
        const margin = 250;
        const bounds = {
            minX: yard.centerX - yard.sizeX / 2,
            maxX: yard.centerX + yard.sizeX / 2,
            minZ: yard.centerZ - yard.sizeZ / 2,
            maxZ: yard.centerZ + yard.sizeZ / 2
        };
        const lowX = bounds.minX + margin - minX;
        const highX = bounds.maxX - margin - maxX;
        const lowZ = bounds.minZ + margin - minZ;
        const highZ = bounds.maxZ - margin - maxZ;
        if (![lowX, highX, lowZ, highZ].every(Number.isFinite) || lowX > highX || lowZ > highZ) return null;
        const centerX = dock.bounds ? (dock.bounds.minX + dock.bounds.maxX) / 2 : dock.anchorX;
        const centerZ = dock.bounds ? (dock.bounds.minZ + dock.bounds.maxZ) / 2 : dock.anchorZ;
        const anchorX = yard.side === 'left' ? highX : yard.side === 'right' ? lowX : Math.min(highX, Math.max(lowX, centerX));
        const anchorZ = yard.side === 'back' ? highZ : yard.side === 'front' ? lowZ : Math.min(highZ, Math.max(lowZ, centerZ));
        return {
            anchorX, anchorZ, yaw, side: yard.side,
            bounds: { minX: anchorX + minX, maxX: anchorX + maxX, minZ: anchorZ + minZ, maxZ: anchorZ + maxZ }
        };
    }

    function buildPassageBoundarySegments(passageCells, cellSize = 500, boundaryWidth = 100, boundaryInset = 100) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const thickness = Math.min(size, Math.max(1, toNumber(boundaryWidth, 100)));
        const inset = Math.min((size - thickness) / 2, Math.max(0, toNumber(boundaryInset, 100)));
        const cells = [];
        const occupied = new Set();
        (Array.isArray(passageCells) ? passageCells : []).forEach((cell) => {
            const x = toNumber(cell?.x);
            const y = toNumber(cell?.y);
            const key = `${x}:${y}`;
            if (occupied.has(key)) return;
            occupied.add(key);
            cells.push({ x, y });
        });
        const hasCell = (x, y) => occupied.has(`${x}:${y}`);
        const segments = [];
        cells.forEach(({ x, y }) => {
            const leftInset = hasCell(x - size, y) ? 0 : inset;
            const rightInset = hasCell(x + size, y) ? 0 : inset;
            const topInset = hasCell(x, y - size) ? 0 : inset;
            const bottomInset = hasCell(x, y + size) ? 0 : inset;
            const horizontalWidth = size - leftInset - rightInset;
            const verticalDepth = size - topInset - bottomInset;
            if (!hasCell(x, y - size)) {
                segments.push({ side: 'top', x: x + leftInset + horizontalWidth / 2, y: y + inset + thickness / 2, width: horizontalWidth, depth: thickness });
            }
            if (!hasCell(x, y + size)) {
                segments.push({ side: 'bottom', x: x + leftInset + horizontalWidth / 2, y: y + size - inset - thickness / 2, width: horizontalWidth, depth: thickness });
            }
            if (!hasCell(x - size, y)) {
                segments.push({ side: 'left', x: x + inset + thickness / 2, y: y + topInset + verticalDepth / 2, width: thickness, depth: verticalDepth });
            }
            if (!hasCell(x + size, y)) {
                segments.push({ side: 'right', x: x + size - inset - thickness / 2, y: y + topInset + verticalDepth / 2, width: thickness, depth: verticalDepth });
            }
        });
        return segments;
    }

    // Work in grid coordinates: local run bands preserve branch widths rather than
    // using the bounding box of an entire connected conveyor network.
    function buildConveyorLayout(cells, cellSize = 500) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const occupied = new Map();
        (Array.isArray(cells) ? cells : []).forEach((cell) => {
            if (!Number.isFinite(Number(cell?.x)) || !Number.isFinite(Number(cell?.y))) return;
            const x = Math.round(Number(cell.x) / size);
            const y = Math.round(Number(cell.y) / size);
            occupied.set(`${x}:${y}`, { x, y });
        });
        const makeRuns = (axis) => {
            const rows = new Map();
            occupied.forEach((cell) => {
                const row = axis === 'x' ? cell.y : cell.x;
                const value = axis === 'x' ? cell.x : cell.y;
                if (!rows.has(row)) rows.set(row, []);
                rows.get(row).push(value);
            });
            const runs = [];
            const lookup = new Map();
            rows.forEach((values, row) => {
                values.sort((a, b) => a - b);
                let start = values[0];
                values.forEach((value, i) => {
                    if (values[i + 1] === value + 1) return;
                    const run = { start, end: value + 1, row };
                    runs.push(run);
                    for (let p = start; p <= value; p += 1) {
                        lookup.set(axis === 'x' ? `${p}:${row}` : `${row}:${p}`, run);
                    }
                    start = values[i + 1];
                });
            });
            const bands = new Map();
            runs.forEach((run) => {
                const key = `${run.start}:${run.end}`;
                if (!bands.has(key)) bands.set(key, []);
                bands.get(key).push(run);
            });
            bands.forEach((band) => {
                band.sort((a, b) => a.row - b.row);
                let first = 0;
                band.forEach((run, i) => {
                    if (band[i + 1]?.row === run.row + 1) return;
                    for (let j = first; j <= i; j += 1) band[j].thickness = i - first + 1;
                    first = i + 1;
                });
            });
            return lookup;
        };
        const horizontal = makeRuns('x');
        const vertical = makeRuns('z');
        occupied.forEach((cell, key) => {
            const h = horizontal.get(key);
            const v = vertical.get(key);
            const alongX = h.end - h.start > h.thickness;
            const alongZ = v.end - v.start > v.thickness;
            cell.axis = alongX && alongZ ? 'transfer'
                : alongX ? 'x' : alongZ ? 'z'
                    : h.end - h.start > v.end - v.start ? 'x'
                        : v.end - v.start > h.end - h.start ? 'z' : 'transfer';
        });
        // Merge adjacent equal runs. Every occupied cell belongs to exactly one module.
        const modules = [];
        ['x', 'z', 'transfer'].forEach((axis) => {
            const rows = new Map();
            occupied.forEach((cell) => {
                if (cell.axis !== axis) return;
                const along = axis === 'x' ? cell.x : cell.y;
                const across = axis === 'x' ? cell.y : cell.x;
                if (!rows.has(along)) rows.set(along, []);
                rows.get(along).push(across);
            });
            let previous = new Map();
            let previousAlong = -Infinity;
            [...rows.keys()].sort((a, b) => a - b).forEach((along) => {
                const row = rows.get(along).sort((a, b) => a - b);
                const current = new Map();
                let first = 0;
                row.forEach((across, i) => {
                    if (row[i + 1] === across + 1) return;
                    const min = row[first];
                    const max = across + 1;
                    const key = `${min}:${max}`;
                    let module = previousAlong === along - 1 ? previous.get(key) : null;
                    if (module) module[axis === 'x' ? 'maxX' : 'maxY'] = (along + 1) * size;
                    else {
                        module = axis === 'x'
                            ? { axis, minX: along * size, maxX: (along + 1) * size, minY: min * size, maxY: max * size }
                            : { axis, minX: min * size, maxX: max * size, minY: along * size, maxY: (along + 1) * size };
                        modules.push(module);
                    }
                    current.set(key, module);
                    first = i + 1;
                });
                previous = current;
                previousAlong = along;
            });
        });
        const rails = [];
        occupied.forEach((cell) => {
            const { x, y, axis } = cell;
            // No rails across an open transfer port or a straight-run endpoint.
            [[0, -1, 'x'], [0, 1, 'x'], [-1, 0, 'z'], [1, 0, 'z']].forEach(([dx, dy, railAxis]) => {
                if (occupied.has(`${x + dx}:${y + dy}`) || (axis !== 'transfer' && axis !== railAxis)) return;
                rails.push({ axis: railAxis, x: (x + 0.5 + dx * 0.5) * size, y: (y + 0.5 + dy * 0.5) * size, length: size, dx, dy });
            });
        });
        modules.forEach((module) => {
            module.width = module.axis === 'z' ? module.maxX - module.minX : module.maxY - module.minY;
            module.length = module.axis === 'z' ? module.maxY - module.minY : module.maxX - module.minX;
        });
        return { modules, rails, cellCount: occupied.size, cellSize: size };
    }

    function createConveyorModel(THREE, layout, floorElevation) {
        const group = new THREE.Group();
        group.name = 'WAREHOUSE-CV-ROLLER-CONVEYORS';
        group.position.y = floorElevation;
        group.userData = { kind: 'conveyor', source: 'floorPlan-CV', height: 1, motion: 'static' };
        const resources = [];
        const box = new THREE.BoxGeometry(1, 1, 1);
        const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
        const steel = new THREE.MeshStandardMaterial({ color: '#aab6c2', metalness: 0.65, roughness: 0.32 });
        const roller = new THREE.MeshStandardMaterial({ color: '#dde4eb', metalness: 0.72, roughness: 0.24 });
        const yellow = new THREE.MeshStandardMaterial({ color: '#facc15', metalness: 0.28, roughness: 0.42 });
        const rubber = new THREE.MeshStandardMaterial({ color: '#263441', roughness: 0.85 });
        resources.push(box, cylinder, steel, roller, yellow, rubber);
        const parts = layout.parts || { steel: [], roller: [], yellow: [], rubber: [] };
        const add = (kind, x, y, z, sx, sy, sz, rx = 0, rz = 0) => parts[kind].push({ x, y, z, sx, sy, sz, rx, rz });
        const legKeys = new Set();
        const addLeg = (x, z) => {
            const key = `${x.toFixed(3)}:${z.toFixed(3)}`;
            if (legKeys.has(key)) return;
            legKeys.add(key);
            add('steel', x, 0.445, z, 0.065, 0.83, 0.065);
            add('rubber', x, 0.015, z, 0.12, 0.03, 0.12);
        };
        layout.modules.forEach((module) => {
            const acrossZ = module.axis !== 'z';
            const min = (acrossZ ? module.minX : module.minY) / 1000;
            const length = module.length / 1000;
            const width = module.width / 1000;
            const cross = (acrossZ ? module.minY + module.maxY : module.minX + module.maxX) / 2000;
            const inset = Math.min(0.055, width * 0.12);
            const radius = Math.min(0.035, length / 8, width / 8);
            const count = Math.max(1, Math.floor(length / (radius * 3.2)));
            for (let i = 0; i < count; i += 1) {
                const along = min + (i + 0.5) * length / count;
                add('roller', acrossZ ? along : cross, 1 - radius, acrossZ ? cross : along,
                    radius, Math.max(0.01, width - inset * 2), radius, acrossZ ? Math.PI / 2 : 0, acrossZ ? 0 : Math.PI / 2);
            }
            // Simplified pop-up transfer belts cross the rollers at corners/junctions.
            if (module.axis === 'transfer') {
                [-0.22, 0.22].forEach((fraction) => {
                    add('rubber', min + length / 2, 0.99, cross + width * fraction,
                        Math.max(0.01, length - inset * 2), 0.02, Math.min(0.055, width * 0.1));
                });
            }
            const supportCount = Math.max(2, Math.ceil(length / 1.5) + 1);
            const endInset = Math.min(0.12, length / 4);
            for (let i = 0; i < supportCount; i += 1) {
                const along = min + endInset + (length - endInset * 2) * i / (supportCount - 1);
                [-1, 1].forEach((sign) => {
                    const side = cross + sign * (width / 2 - inset);
                    addLeg(acrossZ ? along : side, acrossZ ? side : along);
                });
                [0.3, 0.85].forEach((height) => {
                    add('steel', acrossZ ? along : cross, height, acrossZ ? cross : along,
                        acrossZ ? 0.05 : width - inset, 0.045, acrossZ ? width - inset : 0.05);
                });
            }
        });
        layout.rails.forEach((rail) => {
            const thickness = Math.min(0.045, layout.cellSize / 10000);
            const x = rail.x / 1000 - rail.dx * thickness / 2;
            const z = rail.y / 1000 - rail.dy * thickness / 2;
            const length = rail.length / 1000;
            add('steel', x, 0.90, z, rail.axis === 'x' ? length : thickness, 0.16, rail.axis === 'z' ? length : thickness);
            add('yellow', x, 0.99, z, rail.axis === 'x' ? length : thickness, 0.04, rail.axis === 'z' ? length : thickness);
        });
        const transform = new THREE.Object3D();
        Object.entries({ steel, roller, yellow, rubber }).forEach(([kind, material]) => {
            if (!parts[kind].length) return;
            const mesh = new THREE.InstancedMesh(kind === 'roller' ? cylinder : box, material, parts[kind].length);
            mesh.name = `CONVEYOR-${kind.toUpperCase()}`;
            parts[kind].forEach((part, i) => {
                transform.position.set(part.x, part.y, part.z);
                transform.rotation.order = part.ry === undefined ? 'XYZ' : 'YXZ';
                transform.rotation.set(part.rx, part.ry || 0, part.rz);
                transform.scale.set(part.sx, part.sy, part.sz);
                transform.updateMatrix();
                mesh.setMatrixAt(i, transform.matrix);
            });
            mesh.instanceMatrix.needsUpdate = true;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            group.add(mesh);
            resources.push(mesh);
        });
        return { group, resources, rollerCount: parts.roller.length, supportCount: layout.supportCount ?? legKeys.size };
    }

    function groupConnectedFloorCells(cells, cellSize = 500) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const byKey = new Map();
        (Array.isArray(cells) ? cells : []).forEach((cell) => {
            const x = Math.round(toNumber(cell?.x) / size) * size;
            const y = Math.round(toNumber(cell?.y) / size) * size;
            byKey.set(`${x}:${y}`, { x, y });
        });
        const visited = new Set();
        const groups = [];
        byKey.forEach((cell, key) => {
            if (visited.has(key)) return;
            const queue = [cell];
            const group = [];
            visited.add(key);
            for (let index = 0; index < queue.length; index += 1) {
                const current = queue[index];
                group.push(current);
                [[size, 0], [-size, 0], [0, size], [0, -size]].forEach(([dx, dy]) => {
                    const neighborKey = `${current.x + dx}:${current.y + dy}`;
                    const neighbor = byKey.get(neighborKey);
                    if (!neighbor || visited.has(neighborKey)) return;
                    visited.add(neighborKey);
                    queue.push(neighbor);
                });
            }
            const minX = Math.min(...group.map((item) => item.x));
            const maxX = Math.max(...group.map((item) => item.x)) + size;
            const minY = Math.min(...group.map((item) => item.y));
            const maxY = Math.max(...group.map((item) => item.y)) + size;
            groups.push({
                cells: group,
                minX,
                maxX,
                minY,
                maxY,
                centerX: (minX + maxX) / 2,
                centerY: (minY + maxY) / 2
            });
        });
        return groups.sort((left, right) => left.minY - right.minY || left.minX - right.minX);
    }

    function calculateAmrPassageClearanceMm(passageCells, cellSize = 500, requestedClearance = 1950) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const requested = Math.max(1, toNumber(requestedClearance, 1950));
        const corridorWidths = groupConnectedFloorCells(passageCells, size)
            .map((group) => Math.min(group.maxX - group.minX, group.maxY - group.minY))
            .filter((width) => width >= size);
        if (!corridorWidths.length) return requested;
        const narrowestWidth = Math.min(...corridorWidths);
        return Math.min(requested, Math.max(size * 0.8, narrowestWidth - 100));
    }

    function buildAmrCorridorAssignments(graph, stations, equipmentCount) {
        const nodesByKey = graph?.nodesByKey;
        if (!(nodesByKey instanceof Map)) return [];
        const stationEntries = (Array.isArray(stations) ? stations : []).slice();
        const components = (Array.isArray(graph?.components) ? graph.components : [])
            .filter((component) => component.length >= 2)
            .map((component) => component.map((key) => nodesByKey.get(key)).filter(Boolean))
            .filter((nodes) => nodes.length >= 2)
            .sort((left, right) => (
                Math.min(...left.map((node) => node.y)) - Math.min(...right.map((node) => node.y))
                || Math.min(...left.map((node) => node.x)) - Math.min(...right.map((node) => node.x))
            ));
        const count = Math.max(0, Math.floor(toNumber(equipmentCount)));
        if (!components.length || !count) return [];
        return Array.from({ length: count }, (_, index) => {
            const componentNodes = components[index % components.length];
            const minX = Math.min(...componentNodes.map((node) => node.x));
            const maxX = Math.max(...componentNodes.map((node) => node.x));
            const minY = Math.min(...componentNodes.map((node) => node.y));
            const maxY = Math.max(...componentNodes.map((node) => node.y));
            const horizontal = (maxX - minX) >= (maxY - minY);
            const orderedNodes = componentNodes.slice().sort((left, right) => (
                horizontal ? left.x - right.x || left.y - right.y : left.y - right.y || left.x - right.x
            ));
            const corridorCenterX = (minX + maxX) / 2;
            const corridorCenterY = (minY + maxY) / 2;
            const station = stationEntries.reduce((nearest, candidate) => {
                const candidateDistance = Math.hypot(
                    toNumber(candidate?.passageX) - corridorCenterX,
                    toNumber(candidate?.passageY) - corridorCenterY
                );
                if (!nearest || candidateDistance < nearest.distance) return { station: candidate, distance: candidateDistance };
                return nearest;
            }, null)?.station;
            const endpoints = [orderedNodes[0], orderedNodes[orderedNodes.length - 1]];
            const stationX = toNumber(station?.passageX, corridorCenterX);
            const stationY = toNumber(station?.passageY, corridorCenterY);
            const firstDistance = Math.hypot(endpoints[0].x - stationX, endpoints[0].y - stationY);
            const lastDistance = Math.hypot(endpoints[1].x - stationX, endpoints[1].y - stationY);
            const nearNode = firstDistance <= lastDistance ? endpoints[0] : endpoints[1];
            const farNode = nearNode === endpoints[0] ? endpoints[1] : endpoints[0];
            return {
                code: station?.code || `T${String(index + 1).padStart(2, '0')}`,
                componentKeys: componentNodes.map((node) => node.key),
                nearKey: nearNode.key,
                farKey: farNode.key
            };
        });
    }

    function buildShuttleRailLayout(passageCells, stationCells, cellSize = 500) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const passageByKey = new Map();
        (Array.isArray(passageCells) ? passageCells : []).forEach((cell) => {
            const x = Math.round(toNumber(cell?.x) / size) * size;
            const y = Math.round(toNumber(cell?.y) / size) * size;
            passageByKey.set(`${x}:${y}`, { x, y, centerX: x + size / 2, centerY: y + size / 2 });
        });
        const segments = [];
        passageByKey.forEach((cell) => {
            [[size, 0], [0, size]].forEach(([dx, dy]) => {
                const neighbor = passageByKey.get(`${cell.x + dx}:${cell.y + dy}`);
                if (!neighbor) return;
                segments.push({
                    x1: cell.centerX,
                    y1: cell.centerY,
                    x2: neighbor.centerX,
                    y2: neighbor.centerY
                });
            });
        });
        const explicitStationCells = new Map();
        const unnumberedStationCells = [];
        (Array.isArray(stationCells) ? stationCells : []).forEach((cell) => {
            const codeMatch = /^S(\d+)$/.exec(String(cell?.code || '').toUpperCase());
            const code = codeMatch ? `S${codeMatch[1].padStart(2, '0')}` : '';
            if (!code) {
                unnumberedStationCells.push(cell);
                return;
            }
            if (!explicitStationCells.has(code)) explicitStationCells.set(code, []);
            explicitStationCells.get(code).push(cell);
        });
        const createStationGroup = (cells, code = '') => {
            const normalizedCells = cells.map((cell) => ({
                x: Math.round(toNumber(cell?.x) / size) * size,
                y: Math.round(toNumber(cell?.y) / size) * size
            }));
            const minX = Math.min(...normalizedCells.map((cell) => cell.x));
            const maxX = Math.max(...normalizedCells.map((cell) => cell.x)) + size;
            const minY = Math.min(...normalizedCells.map((cell) => cell.y));
            const maxY = Math.max(...normalizedCells.map((cell) => cell.y)) + size;
            return {
                cells: normalizedCells,
                code,
                minX,
                maxX,
                minY,
                maxY,
                centerX: (minX + maxX) / 2,
                centerY: (minY + maxY) / 2
            };
        };
        const stationGroups = [
            ...groupConnectedFloorCells(unnumberedStationCells, size).map((group) => ({ ...group, code: '' })),
            ...[...explicitStationCells.entries()].map(([code, cells]) => createStationGroup(cells, code))
        ].sort((left, right) => left.minY - right.minY || left.minX - right.minX);
        const usedStationCodes = new Set(stationGroups.map((group) => group.code).filter(Boolean));
        let nextStationNumber = 1;
        stationGroups.forEach((group) => {
            if (group.code) return;
            while (usedStationCodes.has(`S${String(nextStationNumber).padStart(2, '0')}`)) nextStationNumber += 1;
            group.code = `S${String(nextStationNumber).padStart(2, '0')}`;
            usedStationCodes.add(group.code);
            nextStationNumber += 1;
        });
        const stations = stationGroups
            .sort((left, right) => Number(left.code.slice(1)) - Number(right.code.slice(1)))
            .map((group) => {
                let nearestPassage = null;
                let nearestDistance = Infinity;
                passageByKey.forEach((cell) => {
                    const distance = Math.hypot(cell.centerX - group.centerX, cell.centerY - group.centerY);
                    if (distance >= nearestDistance) return;
                    nearestDistance = distance;
                    nearestPassage = cell;
                });
                if (nearestPassage) segments.push({
                    x1: nearestPassage.centerX,
                    y1: nearestPassage.centerY,
                    x2: group.centerX,
                    y2: group.centerY,
                    stationConnector: true
                });
                return {
                    ...group,
                    passageX: nearestPassage?.centerX ?? group.centerX,
                    passageY: nearestPassage?.centerY ?? group.centerY,
                    passageDistance: nearestDistance
                };
            });
        return { segments, stations };
    }

    function calculateShuttleFootprintMm(stations, cellSize = 500) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const stationShortSides = (Array.isArray(stations) ? stations : [])
            .map((station) => Math.min(
                Math.max(0, toNumber(station?.maxX) - toNumber(station?.minX)),
                Math.max(0, toNumber(station?.maxY) - toNumber(station?.minY))
            ))
            .filter((side) => side >= size);
        return stationShortSides.length ? Math.min(...stationShortSides) : size;
    }

    function calculateShuttleLoadDimensions(rackSlots, floorPlanCellSize = 500) {
        const rackSlot = (Array.isArray(rackSlots) ? rackSlots : []).find((slot) => (
            Array.isArray(slot?.boxSize)
            && slot.boxSize.length >= 3
            && slot.boxSize.every((value) => toNumber(value) > 0)
        ));
        if (rackSlot) {
            return {
                width: toNumber(rackSlot.boxSize[0]),
                height: toNumber(rackSlot.boxSize[1]),
                depth: toNumber(rackSlot.boxSize[2]),
                source: 'rack-slot'
            };
        }
        const cellSizeMeters = Math.max(0.001, toNumber(floorPlanCellSize, 500) / 1000);
        return {
            width: cellSizeMeters,
            height: cellSizeMeters,
            depth: cellSizeMeters,
            source: 'floorPlan-cell-fallback'
        };
    }

    function calculateLiftFrameDimensions(width, depth, postThickness = 0.09) {
        const thickness = Math.max(0.01, toNumber(postThickness, 0.09));
        const outerWidth = Math.max(thickness * 2 + 0.02, toNumber(width, 1));
        const outerDepth = Math.max(thickness * 2 + 0.02, toNumber(depth, 1));
        return {
            postThickness: thickness,
            halfPostX: outerWidth / 2 - thickness / 2,
            halfPostZ: outerDepth / 2 - thickness / 2,
            innerWidth: outerWidth - thickness * 2,
            innerDepth: outerDepth - thickness * 2
        };
    }

    function buildOrthogonalConnectorPath(start, end) {
        const from = { x: toNumber(start?.x), z: toNumber(start?.z) };
        const to = { x: toNumber(end?.x), z: toNumber(end?.z) };
        if (Math.abs(to.x - from.x) < 0.001 || Math.abs(to.z - from.z) < 0.001) return [from, to];
        return [from, { x: to.x, z: from.z }, to];
    }

    function calculateShuttleLevelElevations(racks, rackTypes) {
        const typeByCode = new Map((Array.isArray(rackTypes) ? rackTypes : []).map((type) => [type?.code, type]));
        const elevations = new Set();
        (Array.isArray(racks) ? racks : []).forEach((rack) => {
            const type = typeByCode.get(rack?.rackTypeCode);
            if (!type) return;
            const levelCount = Math.max(1, Math.round(toNumber(type.levels, 1)));
            const height = Math.max(0, toNumber(type.height));
            const levelHeight = Math.max(1, toNumber(type.levelHeight, height / levelCount));
            for (let level = 0; level < levelCount; level += 1) {
                elevations.add(Math.round(level * levelHeight));
            }
        });
        return [...elevations].sort((left, right) => left - right);
    }

    function buildShuttleFrameLayout(passageCells, levelElevations, cellSize = 500) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const cellsByKey = new Map();
        (Array.isArray(passageCells) ? passageCells : []).forEach((cell) => {
            const x = Math.round(toNumber(cell?.x) / size) * size;
            const y = Math.round(toNumber(cell?.y) / size) * size;
            cellsByKey.set(`${x}:${y}`, { x, y });
        });
        const levels = [...new Set((Array.isArray(levelElevations) ? levelElevations : [])
            .map((level) => Math.max(0, Math.round(toNumber(level)))))]
            .sort((left, right) => left - right);
        const cells = [...cellsByKey.values()];
        const boundarySegments = buildPassageBoundarySegments(cells, size, Math.min(70, size * 0.14), 0);
        return {
            levels,
            tiles: levels.flatMap((levelY) => cells.map((cell) => ({
                x: cell.x + size / 2,
                y: cell.y + size / 2,
                levelY,
                width: size,
                depth: size
            }))),
            boundaries: levels.flatMap((levelY) => boundarySegments.map((segment) => ({ ...segment, levelY })))
        };
    }

    function buildPassageNavigationGraph(passageCells, cellSize = 500, vehicleDiameter = 1600) {
        const size = Math.max(1, toNumber(cellSize, 500));
        const diameter = Math.max(1, toNumber(vehicleDiameter, 1600));
        const radius = diameter / 2;
        const halfStep = size / 2;
        const occupied = new Set();
        let minCellX = Infinity;
        let maxCellX = -Infinity;
        let minCellY = Infinity;
        let maxCellY = -Infinity;
        (Array.isArray(passageCells) ? passageCells : []).forEach((cell) => {
            const cellX = Math.round(toNumber(cell?.x) / size);
            const cellY = Math.round(toNumber(cell?.y) / size);
            occupied.add(`${cellX}:${cellY}`);
            minCellX = Math.min(minCellX, cellX);
            maxCellX = Math.max(maxCellX, cellX);
            minCellY = Math.min(minCellY, cellY);
            maxCellY = Math.max(maxCellY, cellY);
        });
        const nodes = [];
        const nodesByKey = new Map();
        if (!occupied.size) return { nodes, nodesByKey, components: [], step: halfStep, vehicleDiameter: diameter };

        const pointIsInPassage = (x, y) => {
            const cellX = Math.floor((x + 0.0001) / size);
            const cellY = Math.floor((y + 0.0001) / size);
            return occupied.has(`${cellX}:${cellY}`);
        };
        const clearanceAngles = Array.from({ length: 16 }, (_, index) => index * Math.PI / 8);
        const hasVehicleClearance = (x, y) => pointIsInPassage(x, y) && clearanceAngles.every((angle) => (
            pointIsInPassage(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)
        ));
        for (let gridY = minCellY * 2; gridY <= (maxCellY + 1) * 2; gridY += 1) {
            for (let gridX = minCellX * 2; gridX <= (maxCellX + 1) * 2; gridX += 1) {
                const x = gridX * halfStep;
                const y = gridY * halfStep;
                if (!hasVehicleClearance(x, y)) continue;
                const key = `${gridX}:${gridY}`;
                const node = { key, gridX, gridY, x, y, neighbors: [] };
                nodes.push(node);
                nodesByKey.set(key, node);
            }
        }
        nodes.forEach((node) => {
            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([offsetX, offsetY]) => {
                const neighborKey = `${node.gridX + offsetX}:${node.gridY + offsetY}`;
                if (nodesByKey.has(neighborKey)) node.neighbors.push(neighborKey);
            });
        });
        const components = [];
        const visited = new Set();
        nodes.forEach((node) => {
            if (visited.has(node.key)) return;
            const component = [];
            const queue = [node.key];
            visited.add(node.key);
            for (let index = 0; index < queue.length; index += 1) {
                const key = queue[index];
                component.push(key);
                nodesByKey.get(key).neighbors.forEach((neighborKey) => {
                    if (visited.has(neighborKey)) return;
                    visited.add(neighborKey);
                    queue.push(neighborKey);
                });
            }
            components.push(component);
        });
        components.sort((left, right) => right.length - left.length);
        return { nodes, nodesByKey, components, step: halfStep, vehicleDiameter: diameter };
    }

    function findPassagePath(graph, startKey, goalKey) {
        const nodesByKey = graph?.nodesByKey;
        if (!(nodesByKey instanceof Map) || !nodesByKey.has(startKey) || !nodesByKey.has(goalKey)) return [];
        if (startKey === goalKey) return [nodesByKey.get(startKey)];
        const goal = nodesByKey.get(goalKey);
        const turnWeight = nodesByKey.size + 1;
        const heuristic = (key) => {
            const node = nodesByKey.get(key);
            return Math.abs(node.gridX - goal.gridX) + Math.abs(node.gridY - goal.gridY);
        };
        const startStateKey = `${startKey}|start`;
        const open = [{ stateKey: startStateKey, key: startKey, direction: '', score: heuristic(startKey) * turnWeight }];
        const openScores = new Map([[startStateKey, heuristic(startKey) * turnWeight]]);
        const distance = new Map([[startStateKey, 0]]);
        const cameFrom = new Map();
        const push = (entry) => {
            open.push(entry);
            let index = open.length - 1;
            while (index > 0) {
                const parent = Math.floor((index - 1) / 2);
                if (open[parent].score <= entry.score) break;
                open[index] = open[parent];
                index = parent;
            }
            open[index] = entry;
        };
        const pop = () => {
            const first = open[0];
            const last = open.pop();
            if (open.length && last) {
                let index = 0;
                while (true) {
                    const left = index * 2 + 1;
                    const right = left + 1;
                    if (left >= open.length) break;
                    const child = right < open.length && open[right].score < open[left].score ? right : left;
                    if (open[child].score >= last.score) break;
                    open[index] = open[child];
                    index = child;
                }
                open[index] = last;
            }
            return first;
        };
        while (open.length) {
            const currentEntry = pop();
            if (openScores.get(currentEntry.stateKey) !== currentEntry.score) continue;
            openScores.delete(currentEntry.stateKey);
            if (currentEntry.key === goalKey) {
                const pathStates = [currentEntry.stateKey];
                while (cameFrom.has(pathStates[0])) pathStates.unshift(cameFrom.get(pathStates[0]));
                return pathStates.map((stateKey) => nodesByKey.get(stateKey.slice(0, stateKey.lastIndexOf('|'))));
            }
            const currentDistance = distance.get(currentEntry.stateKey);
            const currentNode = nodesByKey.get(currentEntry.key);
            currentNode.neighbors.forEach((neighborKey) => {
                const neighbor = nodesByKey.get(neighborKey);
                const nextDirection = `${Math.sign(neighbor.gridX - currentNode.gridX)}:${Math.sign(neighbor.gridY - currentNode.gridY)}`;
                const turnCost = currentEntry.direction && currentEntry.direction !== nextDirection ? 1 : 0;
                const nextDistance = currentDistance + turnWeight + turnCost;
                const nextStateKey = `${neighborKey}|${nextDirection}`;
                if (nextDistance >= (distance.get(nextStateKey) ?? Infinity)) return;
                cameFrom.set(nextStateKey, currentEntry.stateKey);
                distance.set(nextStateKey, nextDistance);
                const score = nextDistance + heuristic(neighborKey) * turnWeight;
                openScores.set(nextStateKey, score);
                push({ stateKey: nextStateKey, key: neighborKey, direction: nextDirection, score });
            });
        }
        return [];
    }
    function findNearestPassageNode(graph, x, y, maxDistance = 1500) {
        const nodesByKey = graph?.nodesByKey;
        const step = Math.max(1, toNumber(graph?.step, 250));
        if (!(nodesByKey instanceof Map) || !nodesByKey.size) return null;
        const centerGridX = Math.round(toNumber(x) / step);
        const centerGridY = Math.round(toNumber(y) / step);
        const searchRadius = Math.max(1, Math.ceil(toNumber(maxDistance, 1500) / step));
        let nearest = null;
        let nearestDistance = Infinity;
        for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY += 1) {
            for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX += 1) {
                const node = nodesByKey.get(`${centerGridX + offsetX}:${centerGridY + offsetY}`);
                if (!node) continue;
                const distance = Math.hypot(node.x - x, node.y - y);
                if (distance <= maxDistance && distance < nearestDistance) {
                    nearest = node;
                    nearestDistance = distance;
                }
            }
        }
        return nearest;
    }

    function getForkTargetHeight(slot, forkThickness = 0.055) {
        const centerHeight = toNumber(slot?.position?.[1]);
        const boxHeight = Math.max(0, toNumber(slot?.boxSize?.[1]));
        const thickness = Math.max(0, toNumber(forkThickness, 0.055));
        return Math.max(0.06, centerHeight - boxHeight / 2 - thickness / 2);
    }

    function getForkliftTaskSequence(mode) {
        const action = mode === 'putaway' ? 'placing' : 'picking';
        return ['driving', 'aligning', 'lifting', 'extending', action, 'retracting', 'lowering', 'waiting'];
    }
    function calculateRackFocusView(bounds, options = {}) {
        const min = {
            x: Number(bounds?.min?.x),
            y: Number(bounds?.min?.y),
            z: Number(bounds?.min?.z)
        };
        const max = {
            x: Number(bounds?.max?.x),
            y: Number(bounds?.max?.y),
            z: Number(bounds?.max?.z)
        };
        if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)
            || max.x < min.x || max.y < min.y || max.z < min.z) return null;
        const yaw = toNumber(options.yaw, Math.PI / 4);
        const pitch = toNumber(options.pitch, Math.PI / 6);
        const aspect = Math.max(0.01, toNumber(options.aspect, 1));
        const verticalHalfFov = Math.max(0.01, Math.min(Math.PI / 2 - 0.01, toNumber(options.verticalFovDegrees, 45) * Math.PI / 360));
        const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
        const padding = Math.max(1, toNumber(options.padding, 1.12));
        const nearPadding = Math.max(0.01, toNumber(options.nearPadding, 0.25));
        const center = {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2,
            z: (min.z + max.z) / 2
        };
        const cosPitch = Math.cos(pitch);
        const sinPitch = Math.sin(pitch);
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);
        const cameraBack = { x: cosPitch * sinYaw, y: sinPitch, z: cosPitch * cosYaw };
        const cameraRight = { x: cosYaw, y: 0, z: -sinYaw };
        const cameraUp = { x: -sinPitch * sinYaw, y: cosPitch, z: -sinPitch * cosYaw };
        let perspectiveDistance = nearPadding;
        let orthographicHalfHeight = 0.05;
        let depthExtent = 0;
        [min.x, max.x].forEach((x) => {
            [min.y, max.y].forEach((y) => {
                [min.z, max.z].forEach((z) => {
                    const offset = { x: x - center.x, y: y - center.y, z: z - center.z };
                    const horizontal = Math.abs(offset.x * cameraRight.x + offset.y * cameraRight.y + offset.z * cameraRight.z);
                    const vertical = Math.abs(offset.x * cameraUp.x + offset.y * cameraUp.y + offset.z * cameraUp.z);
                    const towardCamera = offset.x * cameraBack.x + offset.y * cameraBack.y + offset.z * cameraBack.z;
                    perspectiveDistance = Math.max(
                        perspectiveDistance,
                        towardCamera + horizontal * padding / Math.tan(horizontalHalfFov),
                        towardCamera + vertical * padding / Math.tan(verticalHalfFov),
                        towardCamera + nearPadding
                    );
                    orthographicHalfHeight = Math.max(orthographicHalfHeight, vertical * padding, horizontal * padding / aspect);
                    depthExtent = Math.max(depthExtent, Math.abs(towardCamera));
                });
            });
        });
        return {
            center,
            perspectiveDistance,
            orthographicViewHeight: orthographicHalfHeight * 2,
            depthExtent
        };
    }
    function getRackDepthFramePositions(rackRowCount, depthCount, rackDepth) {
        const rows = Math.max(1, Math.round(Number(rackRowCount) || 1));
        const depths = Math.max(1, Math.round(Number(depthCount) || 1));
        const depth = Math.max(0, Number(rackDepth) || 0);
        const spacing = depth / depths;
        return Array.from({ length: rows * depths + 1 }, (_, index) => index * spacing);
    }
    function startWarehouseScene(THREE, shell, data, signal) {
        const mm = (value) => Number(value || 0) / 1000;
        const floorWidth = mm(data.meta?.floorWidth || 52000);
        const floorDepth = mm(data.meta?.floorDepth || 58000);
        const warehouseFloorElevation = 1.2;
        const loadingDockLayoutEntries = calculateLoadingDockLayouts(
            data.racks, data.rackTypes,
            data.meta?.floorWidth || 52000,
            data.meta?.floorDepth || 58000,
            'W04',
            data.meta?.dockCells,
            data.meta?.floorPlanCellSize || 500,
            data.meta?.dockRegions || null
        );
        const loadingDockLayout = loadingDockLayoutEntries[0] || null;
        const openWallSide = loadingDockLayout?.side || '';
        const loadingYardLayout = calculateLoadingYardLayout(
            loadingDockLayout,
            data.meta?.floorWidth || 52000,
            data.meta?.floorDepth || 58000
        );
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#07111f');

        const perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 250);
        const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 250);
        let camera = perspectiveCamera;
        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        renderer.sortObjects = true;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.12;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.domElement.tabIndex = 0;
        renderer.domElement.setAttribute('aria-label', '기준정보 기반 3D 창고');
        shell.viewport.replaceChildren(renderer.domElement, shell.hoverTooltip, shell.cameraViews, shell.legend);
        shell.cameraViews.hidden = false;

        const maximumRackHeight = Math.max(0, ...data.rackTypes.map((type) => mm(type.height)));
        const warehouseHeight = Math.max(8, maximumRackHeight + 3.2);
        const sceneSpan = Math.max(floorWidth, floorDepth) + mm(loadingYardLayout?.approachDepth || 0);
        scene.add(new THREE.HemisphereLight('#dbeafe', '#101923', 1.65));
        const sun = new THREE.DirectionalLight('#fff7e8', 2.65);
        sun.position.set(floorWidth * 0.28, warehouseFloorElevation + warehouseHeight + 28, floorDepth * 0.22);
        sun.target.position.set(floorWidth / 2, warehouseFloorElevation + 1.5, floorDepth / 2);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.camera.left = -sceneSpan * 0.62;
        sun.shadow.camera.right = sceneSpan * 0.62;
        sun.shadow.camera.top = sceneSpan * 0.62;
        sun.shadow.camera.bottom = -sceneSpan * 0.62;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = warehouseHeight + 80;
        sun.shadow.bias = -0.00015;
        sun.shadow.normalBias = 0.035;
        scene.add(sun, sun.target);
        const fillLight = new THREE.DirectionalLight('#dbeafe', 1.35);
        fillLight.position.set(floorWidth * 0.85, 28, floorDepth * 0.85);
        fillLight.target.position.set(floorWidth / 2, warehouseFloorElevation + 2.5, floorDepth / 2);
        fillLight.castShadow = false;
        scene.add(fillLight, fillLight.target);

        const reflectionRoom = new THREE.Scene();
        reflectionRoom.background = new THREE.Color('#0b2138');
        const reflectionShell = new THREE.Mesh(new THREE.SphereGeometry(12, 24, 16), new THREE.MeshBasicMaterial({ color: '#12324c', side: THREE.BackSide }));
        reflectionRoom.add(reflectionShell);
        const addReflectionPanel = (color, position, rotation, size) => {
            const panel = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ color }));
            panel.position.set(...position);
            panel.rotation.set(...rotation);
            reflectionRoom.add(panel);
        };
        addReflectionPanel('#e0f2fe', [0, 7, 0], [-Math.PI / 2, 0, 0], [18, 4]);
        addReflectionPanel('#93c5fd', [0, 3, -8], [0, 0, 0], [18, 3]);
        addReflectionPanel('#bbf7d0', [-8, 3, 0], [0, Math.PI / 2, 0], [16, 3]);
        const reflectionPmrem = new THREE.PMREMGenerator(renderer);
        const floorReflectionEnvironment = reflectionPmrem.fromScene(reflectionRoom, 0.04).texture;
        reflectionPmrem.dispose();
        reflectionRoom.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) object.material.dispose();
        });
        scene.environment = floorReflectionEnvironment;

        const enclosureResources = [];
        const enclosure = new THREE.Group();
        enclosure.name = 'WAREHOUSE-ENCLOSURE';
        enclosure.userData.kind = 'warehouse-enclosure';
        enclosure.position.y = warehouseFloorElevation;
        const createPanelTexture = (kind) => {
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 512;
            const context = canvas.getContext('2d');
            const ceiling = kind === 'ceiling';
            context.fillStyle = ceiling ? '#c3cad1' : '#b8c1ca';
            context.fillRect(0, 0, canvas.width, canvas.height);
            if (ceiling) {
                context.strokeStyle = '#7f8b96';
                context.lineWidth = 5;
                for (let value = 0; value <= 512; value += 128) {
                    context.beginPath();
                    context.moveTo(value, 0);
                    context.lineTo(value, 512);
                    context.stroke();
                    context.beginPath();
                    context.moveTo(0, value);
                    context.lineTo(512, value);
                    context.stroke();
                }
            } else {
                for (let x = 0; x < 512; x += 16) {
                    context.fillStyle = (x / 16) % 2 ? '#a7b2bc' : '#c4ccd3';
                    context.fillRect(x, 0, 8, 512);
                    context.fillStyle = 'rgba(46, 58, 69, 0.28)';
                    context.fillRect(x + 15, 0, 1, 512);
                }
                context.fillStyle = 'rgba(38, 50, 61, 0.42)';
                for (let y = 0; y <= 512; y += 128) context.fillRect(0, y, 512, 3);
            }
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.repeat.set(ceiling ? Math.max(2, enclosureWidth / 8) : Math.max(3, enclosureWidth / 3.2), ceiling ? Math.max(2, enclosureDepth / 8) : Math.max(2, warehouseHeight / 2.4));
            texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            return texture;
        };
        const enclosureWidth = floorWidth;
        const enclosureDepth = floorDepth;
        const wallTexture = createPanelTexture('wall');
        const wallMaterial = new THREE.MeshPhysicalMaterial({
            color: '#607080',
            map: wallTexture,
            roughness: 0.72,
            metalness: 0.16,
            clearcoat: 0.12,
            clearcoatRoughness: 0.72,
            envMapIntensity: 0.7,
            side: THREE.FrontSide
        });
        const ceilingMaterial = wallMaterial.clone();
        ceilingMaterial.side = THREE.BackSide;
        const lightPanelMaterial = new THREE.MeshBasicMaterial({ color: '#dbeafe', side: THREE.FrontSide });
        const structuralSteelMaterial = new THREE.MeshPhysicalMaterial({
            color: '#556371',
            roughness: 0.48,
            metalness: 0.72,
            clearcoat: 0.18,
            clearcoatRoughness: 0.42,
            envMapIntensity: 1.05
        });
        const lightHousingMaterial = new THREE.MeshStandardMaterial({
            color: '#526171',
            roughness: 0.5,
            metalness: 0.64
        });
        const wallStructureGroups = {};
        ['back', 'front', 'left', 'right'].forEach((side) => {
            const group = new THREE.Group();
            group.name = `WAREHOUSE-WALL-STRUCTURE-${side.toUpperCase()}`;
            group.userData = { kind: 'warehouse-wall-structure', side };
            wallStructureGroups[side] = group;
            enclosure.add(group);
        });
        const ceilingStructureGroup = new THREE.Group();
        ceilingStructureGroup.name = 'WAREHOUSE-CEILING-STRUCTURE';
        ceilingStructureGroup.userData.kind = 'warehouse-ceiling-structure';
        enclosure.add(ceilingStructureGroup);
        const cornerColumnEntries = [];
        enclosureResources.push(
            wallTexture,
            wallMaterial,
            ceilingMaterial,
            lightPanelMaterial,
            structuralSteelMaterial,
            lightHousingMaterial
        );
        const addEnclosurePlane = (name, size, position, rotation, material) => {
            const geometry = new THREE.PlaneGeometry(size[0], size[1]);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(...position);
            mesh.rotation.set(...rotation);
            mesh.receiveShadow = true;
            enclosure.add(mesh);
            enclosureResources.push(geometry);
            return mesh;
        };
        const addEnclosureBox = (name, size, position, material = structuralSteelMaterial, parent = enclosure) => {
            const geometry = new THREE.BoxGeometry(...size);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(...position);
            mesh.castShadow = false;
            mesh.receiveShadow = true;
            parent.add(mesh);
            enclosureResources.push(geometry);
            return mesh;
        };
        const wallDefinitions = {
            back: ['WAREHOUSE-WALL-BACK', [enclosureWidth, warehouseHeight], [floorWidth / 2, warehouseHeight / 2, 0], [0, 0, 0]],
            front: ['WAREHOUSE-WALL-FRONT', [enclosureWidth, warehouseHeight], [floorWidth / 2, warehouseHeight / 2, floorDepth], [0, Math.PI, 0]],
            left: ['WAREHOUSE-WALL-LEFT', [enclosureDepth, warehouseHeight], [0, warehouseHeight / 2, floorDepth / 2], [0, Math.PI / 2, 0]],
            right: ['WAREHOUSE-WALL-RIGHT', [enclosureDepth, warehouseHeight], [floorWidth, warehouseHeight / 2, floorDepth / 2], [0, -Math.PI / 2, 0]]
        };
        Object.entries(wallDefinitions).forEach(([side, [name, size, position, rotation]]) => {
            if (side !== openWallSide) addEnclosurePlane(name, size, position, rotation, wallMaterial);
        });

        const wallColumnSpacing = 4;
        const wallColumnPositions = new Map();
        const addWallColumns = (side, startX, startZ, endX, endZ) => {
            const edgeLength = Math.hypot(endX - startX, endZ - startZ);
            const divisions = Math.max(1, Math.ceil(edgeLength / wallColumnSpacing));
            for (let index = 0; index <= divisions; index += 1) {
                const ratio = index / divisions;
                const x = startX + (endX - startX) * ratio;
                const z = startZ + (endZ - startZ) * ratio;
                const key = `${x.toFixed(3)}:${z.toFixed(3)}`;
                const column = wallColumnPositions.get(key) || { x, z, sides: new Set() };
                column.sides.add(side);
                wallColumnPositions.set(key, column);
            }
        };
        if (openWallSide !== 'back') addWallColumns('back', 0, 0, floorWidth, 0);
        if (openWallSide !== 'right') addWallColumns('right', floorWidth, 0, floorWidth, floorDepth);
        if (openWallSide !== 'front') addWallColumns('front', floorWidth, floorDepth, 0, floorDepth);
        if (openWallSide !== 'left') addWallColumns('left', 0, floorDepth, 0, 0);
        wallColumnPositions.forEach(({ x, z, sides }) => {
            const columnSides = [...sides];
            const parent = columnSides.length === 1 ? wallStructureGroups[columnSides[0]] : enclosure;
            const mesh = addEnclosureBox(
                'WAREHOUSE-WALL-COLUMN',
                [0.28, warehouseHeight, 0.28],
                [x, warehouseHeight / 2, z],
                structuralSteelMaterial,
                parent
            );
            if (columnSides.length > 1) cornerColumnEntries.push({ mesh, sides: columnSides });
        });

        let wallGirtCount = 0;
        for (let height = 2.2; height < warehouseHeight - 0.6; height += 2.2) {
            if (openWallSide !== 'back') { addEnclosureBox('WAREHOUSE-WALL-GIRT', [floorWidth, 0.12, 0.14], [floorWidth / 2, height, 0.04], structuralSteelMaterial, wallStructureGroups.back); wallGirtCount += 1; }
            if (openWallSide !== 'front') { addEnclosureBox('WAREHOUSE-WALL-GIRT', [floorWidth, 0.12, 0.14], [floorWidth / 2, height, floorDepth - 0.04], structuralSteelMaterial, wallStructureGroups.front); wallGirtCount += 1; }
            if (openWallSide !== 'left') { addEnclosureBox('WAREHOUSE-WALL-GIRT', [0.14, 0.12, floorDepth], [0.04, height, floorDepth / 2], structuralSteelMaterial, wallStructureGroups.left); wallGirtCount += 1; }
            if (openWallSide !== 'right') { addEnclosureBox('WAREHOUSE-WALL-GIRT', [0.14, 0.12, floorDepth], [floorWidth - 0.04, height, floorDepth / 2], structuralSteelMaterial, wallStructureGroups.right); wallGirtCount += 1; }
        }
        if (openWallSide !== 'back') addEnclosureBox('WAREHOUSE-WALL-TOP-BEAM', [floorWidth, 0.24, 0.22], [floorWidth / 2, warehouseHeight - 0.12, 0], structuralSteelMaterial, wallStructureGroups.back);
        if (openWallSide !== 'front') addEnclosureBox('WAREHOUSE-WALL-TOP-BEAM', [floorWidth, 0.24, 0.22], [floorWidth / 2, warehouseHeight - 0.12, floorDepth], structuralSteelMaterial, wallStructureGroups.front);
        if (openWallSide !== 'left') addEnclosureBox('WAREHOUSE-WALL-TOP-BEAM', [0.22, 0.24, floorDepth], [0, warehouseHeight - 0.12, floorDepth / 2], structuralSteelMaterial, wallStructureGroups.left);
        if (openWallSide !== 'right') addEnclosureBox('WAREHOUSE-WALL-TOP-BEAM', [0.22, 0.24, floorDepth], [floorWidth, warehouseHeight - 0.12, floorDepth / 2], structuralSteelMaterial, wallStructureGroups.right);

        addEnclosurePlane('WAREHOUSE-CEILING', [enclosureWidth, enclosureDepth], [floorWidth / 2, warehouseHeight, floorDepth / 2], [-Math.PI / 2, 0, 0], ceilingMaterial);
        const ceilingBeamSpacing = 4;
        let ceilingBeamCount = 0;
        const depthBeamDivisions = Math.max(1, Math.ceil(floorDepth / ceilingBeamSpacing));
        for (let index = 0; index <= depthBeamDivisions; index += 1) {
            const z = floorDepth * index / depthBeamDivisions;
            addEnclosureBox('WAREHOUSE-CEILING-BEAM-X', [floorWidth, 0.22, 0.18], [floorWidth / 2, warehouseHeight - 0.2, z], structuralSteelMaterial, ceilingStructureGroup);
            ceilingBeamCount += 1;
        }
        const widthBeamDivisions = Math.max(1, Math.ceil(floorWidth / ceilingBeamSpacing));
        for (let index = 0; index <= widthBeamDivisions; index += 1) {
            const x = floorWidth * index / widthBeamDivisions;
            addEnclosureBox('WAREHOUSE-CEILING-BEAM-Z', [0.14, 0.16, floorDepth], [x, warehouseHeight - 0.34, floorDepth / 2], structuralSteelMaterial, ceilingStructureGroup);
            ceilingBeamCount += 1;
        }

        const lightPanelLength = Math.max(2.4, Math.min(4.2, floorWidth * 0.16));
        const lightPanelGeometry = new THREE.PlaneGeometry(lightPanelLength, 0.42);
        enclosureResources.push(lightPanelGeometry);
        [0.18, 0.4, 0.62, 0.84].forEach((depthRatio) => {
            [0.28, 0.72].forEach((widthRatio) => {
                addEnclosureBox(
                    'WAREHOUSE-CEILING-LIGHT-HOUSING',
                    [lightPanelLength + 0.16, 0.1, 0.58],
                    [floorWidth * widthRatio, warehouseHeight - 0.42, floorDepth * depthRatio],
                    lightHousingMaterial,
                    ceilingStructureGroup
                );
                const panel = new THREE.Mesh(lightPanelGeometry, lightPanelMaterial);
                panel.name = 'WAREHOUSE-CEILING-LIGHT';
                panel.position.set(floorWidth * widthRatio, warehouseHeight - 0.476, floorDepth * depthRatio);
                panel.rotation.x = Math.PI / 2;
                ceilingStructureGroup.add(panel);
            });
            const ceilingLight = new THREE.PointLight('#dbeafe', 5.5, sceneSpan * 0.78, 1.65);
            ceilingLight.name = 'WAREHOUSE-AMBIENT-LIGHT';
            ceilingLight.position.set(floorWidth / 2, warehouseHeight - 0.72, floorDepth * depthRatio);
            enclosure.add(ceilingLight);
        });
        scene.add(new THREE.AmbientLight('#c7dcef', 0.48));
        scene.add(enclosure);
        let hiddenWallStructures = new Set();
        let ceilingStructureHidden = false;
        const updateWarehouseStructureVisibility = () => {
            const occlusion = getWarehouseStructureOcclusion(camera.position, floorWidth, floorDepth, warehouseFloorElevation + warehouseHeight);
            const nextHiddenWalls = new Set();
            Object.entries(occlusion.wallScores).forEach(([side, score]) => {
                const threshold = hiddenWallStructures.has(side) ? 0.12 : 0.22;
                const hidden = score > threshold;
                wallStructureGroups[side].visible = !hidden;
                if (hidden) nextHiddenWalls.add(side);
            });
            hiddenWallStructures = nextHiddenWalls;
            cornerColumnEntries.forEach(({ mesh, sides }) => {
                mesh.visible = sides.every(side => !hiddenWallStructures.has(side));
            });
            const ceilingHeight = warehouseFloorElevation + warehouseHeight;
            const ceilingThreshold = ceilingStructureHidden ? ceilingHeight - 0.15 : ceilingHeight + 0.25;
            ceilingStructureHidden = camera.position.y > ceilingThreshold;
            ceilingStructureGroup.visible = !ceilingStructureHidden;
            shell.viewport.dataset.warehouseHiddenStructures = [...hiddenWallStructures].sort().join(',');
            shell.viewport.dataset.warehouseCeilingStructureHidden = String(ceilingStructureHidden);
        };
        shell.viewport.dataset.warehouseWallCount = String(openWallSide ? 3 : 4);
        shell.viewport.dataset.warehouseOpenWall = openWallSide || 'none';
        shell.viewport.dataset.warehouseColumnCount = String(wallColumnPositions.size);
        shell.viewport.dataset.warehouseWallGirtCount = String(wallGirtCount);
        shell.viewport.dataset.warehouseCeilingBeamCount = String(ceilingBeamCount);
        shell.viewport.dataset.warehouseFloorAligned = 'true';
        shell.viewport.dataset.warehouseOcclusionMode = 'camera-aware';
        shell.viewport.dataset.warehouseStructureShadows = 'false';
        shell.viewport.dataset.warehouseCeiling = 'true';
        shell.viewport.dataset.warehouseSafetyLines = 'true';

        shell.viewport.dataset.warehouseFloorElevation = String(warehouseFloorElevation);
        const floor = new THREE.Mesh(
            new THREE.BoxGeometry(floorWidth, warehouseFloorElevation, floorDepth),
            new THREE.MeshPhysicalMaterial({
                color: '#17603f',
                roughness: 0.18,
                metalness: 0.04,
                clearcoat: 0.7,
                clearcoatRoughness: 0.1,
                envMapIntensity: 1.6
            })
        );
        floor.name = 'WAREHOUSE-RAISED-FLOOR';
        floor.position.set(floorWidth / 2, warehouseFloorElevation / 2, floorDepth / 2);
        floor.receiveShadow = true;
        scene.add(floor);

        const dockCells = Array.isArray(data.meta?.dockCells) ? data.meta.dockCells : [];
        shell.viewport.dataset.warehouseDockCellCount = String(dockCells.length);
        shell.viewport.dataset.warehouseDockCodes = [...new Set(dockCells.map((cell) => cell.code).filter(Boolean))].sort().join(',');
        const bufferCells = Array.isArray(data.meta?.bufferCells) ? data.meta.bufferCells : [];
        shell.viewport.dataset.warehouseBufferCellCount = String(bufferCells.length);
        shell.viewport.dataset.warehouseBufferCodes = [...new Set(bufferCells.map((cell) => cell.code).filter(Boolean))].sort().join(',');
        shell.viewport.dataset.warehouseBufferSource = 'floorPlan-B';
        shell.viewport.dataset.warehouseBufferColor = '#ffffff';
        const conveyorCells = Array.isArray(data.meta?.conveyorCells) ? data.meta.conveyorCells : [];
        shell.viewport.dataset.warehouseConveyorCellCount = String(conveyorCells.length);
        shell.viewport.dataset.warehouseConveyorSource = 'floorPlan-CV';
        shell.viewport.dataset.warehouseConveyorColor = '#facc15';
        const stationCells = Array.isArray(data.meta?.stationCells) ? data.meta.stationCells : [];
        shell.viewport.dataset.warehouseStationCellCount = String(stationCells.length);
        shell.viewport.dataset.warehouseDockDisplay = 'line';
        shell.viewport.dataset.warehouseDockColor = '#ffffff';

        let loadingYard = null;
        if (loadingYardLayout) {
            loadingYard = new THREE.Mesh(
                new THREE.BoxGeometry(mm(loadingYardLayout.sizeX), 0.12, mm(loadingYardLayout.sizeZ)),
                new THREE.MeshPhysicalMaterial({
                    color: '#39434c',
                    roughness: 0.92,
                    metalness: 0.02,
                    clearcoat: 0.05,
                    clearcoatRoughness: 0.9
                })
            );
            loadingYard.name = 'WAREHOUSE-LOADING-YARD';
            loadingYard.userData = { kind: 'loading-yard', side: loadingYardLayout.side };
            loadingYard.position.set(mm(loadingYardLayout.centerX), -0.06, mm(loadingYardLayout.centerZ));
            loadingYard.receiveShadow = true;
            scene.add(loadingYard);
        }
        shell.viewport.dataset.warehouseLoadingYard = loadingYard ? 'true' : 'false';
        shell.viewport.dataset.warehouseLoadingYardSide = loadingYardLayout?.side || 'none';
        shell.viewport.dataset.warehouseLoadingYardDepth = loadingYardLayout ? String(mm(loadingYardLayout.approachDepth)) : '0';

        const truckResources = [];
        const truckSchedules = Array.isArray(data.meta?.truckSchedules) ? data.meta.truckSchedules : [];
        const claimedTruckSchedules = new Set();
        const schedulesByDock = new Map();
        loadingDockLayoutEntries.forEach((layout) => {
            const exactIndex = truckSchedules.findIndex((schedule, index) =>
                !claimedTruckSchedules.has(index) && schedule?.dockCode === layout.rackCode
            );
            const fallbackIndex = truckSchedules.findIndex((_, index) => !claimedTruckSchedules.has(index));
            const scheduleIndex = exactIndex >= 0 ? exactIndex : data.meta?.source === 'drawing' ? -1 : fallbackIndex;
            if (scheduleIndex < 0) return;
            claimedTruckSchedules.add(scheduleIndex);
            schedulesByDock.set(layout.rackCode, truckSchedules[scheduleIndex]);
        });
        const createStaticTruck = (layout) => {
            if (!layout) return null;
            const truck = new THREE.Group();
            const truckInfo = schedulesByDock.get(layout.rackCode) || {};
            truck.name = `WAREHOUSE-STATIC-5T-TRUCK-${layout.rackCode}`;
            truck.userData = {
                kind: 'static-5t-truck',
                dockCode: layout.rackCode,
                rackCode: layout.rackCode,
                loadingSide: layout.side,
                modelStyle: 'reference-low-poly-cab-over',
                cargoDimensions: { length: 6.2, width: 2.2, height: 2.3 },
                cargoFloorHeight: warehouseFloorElevation,
                scheduleCode: truckInfo.scheduleCode || ''
            };
            const materials = {
                cargo: new THREE.MeshPhysicalMaterial({ color: '#d8cec7', roughness: 0.62, metalness: 0.04, clearcoat: 0.2 }),
                cargoTrim: new THREE.MeshStandardMaterial({ color: '#bca9a2', roughness: 0.56, metalness: 0.16 }),
                cab: new THREE.MeshPhysicalMaterial({ color: '#d4c7c3', roughness: 0.55, metalness: 0.05, clearcoat: 0.24 }),
                glass: new THREE.MeshPhysicalMaterial({ color: '#245d6b', roughness: 0.16, metalness: 0.12, transparent: true, opacity: 0.94, depthWrite: false }),
                dark: new THREE.MeshStandardMaterial({ color: '#39343e', roughness: 0.68, metalness: 0.22 }),
                rubber: new THREE.MeshStandardMaterial({ color: '#151219', roughness: 0.9, metalness: 0.01 }),
                hub: new THREE.MeshStandardMaterial({ color: '#b9adae', roughness: 0.48, metalness: 0.32 }),
                light: new THREE.MeshStandardMaterial({ color: '#eee8d9', emissive: '#bcb69f', emissiveIntensity: 0.18 }),
                tail: new THREE.MeshStandardMaterial({ color: '#9d5662', emissive: '#4d2730', emissiveIntensity: 0.14 }),
                shadow: new THREE.MeshBasicMaterial({ color: '#020617', transparent: true, opacity: 0.34, depthWrite: false })
            };
            truckResources.push(...Object.values(materials));
            const addPart = (name, geometry, material, position, rotation = null) => {
                const mesh = new THREE.Mesh(geometry, material);
                mesh.name = name;
                mesh.position.set(...position);
                if (rotation) mesh.rotation.set(...rotation);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                truck.add(mesh);
                truckResources.push(geometry);
                return mesh;
            };
            const box = (name, size, position, material = materials.dark) =>
                addPart(name, new THREE.BoxGeometry(...size), material, position);
            const createCabGeometry = () => {
                const halfWidth = 1.06;
                const profile = [
                    [0.58, 6.15],
                    [3.08, 6.15],
                    [3.08, 7.24],
                    [2.82, 7.62],
                    [2.58, 8.12],
                    [0.58, 8.12]
                ];
                const vertices = [];
                [-halfWidth, halfWidth].forEach((x) => {
                    profile.forEach(([y, z]) => vertices.push(x, y, z));
                });
                const indices = [
                    0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4,
                    6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11
                ];
                for (let index = 0; index < profile.length; index += 1) {
                    const next = (index + 1) % profile.length;
                    indices.push(index, next, profile.length + next, index, profile.length + next, profile.length + index);
                }
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
                geometry.setIndex(indices);
                geometry.computeVertexNormals();
                return geometry;
            };
            const cargoLength = 6.2;
            const cargoWidth = 2.2;
            const cargoHeight = 2.3;
            box('truck-cargo-box', [cargoWidth, cargoHeight, cargoLength], [0, warehouseFloorElevation + cargoHeight / 2, cargoLength / 2], materials.cargo);
            box('truck-cargo-top-trim', [cargoWidth + 0.05, 0.055, cargoLength + 0.04], [0, warehouseFloorElevation + cargoHeight + 0.015, cargoLength / 2], materials.cargoTrim);
            box('truck-cargo-lower-trim', [cargoWidth + 0.05, 0.065, cargoLength + 0.04], [0, warehouseFloorElevation + 0.035, cargoLength / 2], materials.cargoTrim);
            [-1, 1].forEach((side) => {
                [0.02, cargoLength - 0.02].forEach((z) => {
                    box('truck-cargo-corner-trim', [0.055, cargoHeight + 0.02, 0.055], [side * (cargoWidth / 2 + 0.015), warehouseFloorElevation + cargoHeight / 2, z], materials.cargoTrim);
                });
            });
            box('truck-rear-door-left', [cargoWidth / 2 - 0.05, cargoHeight - 0.16, 0.055], [-cargoWidth / 4, warehouseFloorElevation + cargoHeight / 2, -0.03], materials.cargo);
            box('truck-rear-door-right', [cargoWidth / 2 - 0.05, cargoHeight - 0.16, 0.055], [cargoWidth / 4, warehouseFloorElevation + cargoHeight / 2, -0.03], materials.cargo);
            box('truck-rear-door-seam', [0.035, cargoHeight - 0.1, 0.07], [0, warehouseFloorElevation + cargoHeight / 2, -0.065], materials.cargoTrim);
            box('truck-chassis', [2.06, 0.2, 7.48], [0, 0.78, 3.82], materials.dark);
            box('truck-side-skirt', [2.18, 0.42, 2.15], [0, 0.7, 3.82], materials.dark);
            box('truck-rear-bumper', [2.22, 0.18, 0.18], [0, 0.5, -0.12], materials.cargoTrim);
            addPart('truck-cab-shell', createCabGeometry(), materials.cab, [0, 0, 0]);
            box('truck-cab-roof', [2.18, 0.08, 1.25], [0, 3.12, 6.82], materials.cargoTrim);
            // The cab front is vertical at z=8.12 below y=2.58; keep both panes parallel and outside it.
            box('truck-windshield-surround', [1.98, 0.95, 0.04], [0, 2.08, 8.142], materials.dark);
            box('truck-windshield', [1.82, 0.82, 0.012], [0, 2.08, 8.17], materials.glass);
            [-1, 1].forEach((side) => {
                const sideWindowShape = new THREE.Shape();
                sideWindowShape.moveTo(-0.58, -0.38);
                sideWindowShape.lineTo(0.42, -0.34);
                sideWindowShape.lineTo(0.3, 0.39);
                sideWindowShape.lineTo(-0.35, 0.43);
                sideWindowShape.closePath();
                addPart(
                    'truck-side-window',
                    new THREE.ShapeGeometry(sideWindowShape),
                    materials.glass,
                    [side * 1.068, 2.18, 7.25],
                    [0, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0]
                );
                box('truck-mirror-arm', [0.18, 0.035, 0.035], [side * 1.13, 2.28, 7.88], materials.dark);
                box('truck-side-mirror', [0.11, 0.34, 0.14], [side * 1.23, 2.2, 7.9], materials.dark);
                box('truck-door-handle', [0.035, 0.055, 0.22], [side * 1.073, 1.45, 6.82], materials.dark);
            });
            box('truck-front-grille', [1.7, 0.46, 0.06], [0, 1.12, 8.155], materials.dark);
            box('truck-front-bumper', [2.2, 0.22, 0.2], [0, 0.55, 8.12], materials.cargoTrim);
            box('truck-license-plate', [0.42, 0.14, 0.04], [0, 0.92, 8.19], materials.light);
            [-0.72, 0.72].forEach((x) => {
                box('truck-headlight', [0.28, 0.16, 0.055], [x, 1.38, 8.165], materials.light);
                box('truck-tail-light', [0.24, 0.2, 0.05], [x, 0.86, -0.13], materials.tail);
            });
            const addWheel = (x, z) => {
                const wheel = addPart('truck-wheel', new THREE.CylinderGeometry(0.49, 0.49, 0.25, 24), materials.rubber, [x, 0.49, z], [0, 0, Math.PI / 2]);
                const hub = addPart('truck-wheel-hub', new THREE.CylinderGeometry(0.22, 0.22, 0.26, 20), materials.hub, [x, 0.49, z], [0, 0, Math.PI / 2]);
                wheel.userData.axle = z;
                hub.userData.axle = z;
            };
            const truckAxlePositions = [1.08, 2.2, 7.15];
            [-1.02, 1.02].forEach((x) => truckAxlePositions.forEach((z) => addWheel(x, z)));
            const shadow = addPart('truck-shadow', new THREE.PlaneGeometry(2.5, 8.45), materials.shadow, [0, 0.012, 4], [-Math.PI / 2, 0, 0]);
            shadow.castShadow = false;
            // Measure physical meshes before adding the screen-facing billboard.
            const truckBounds = new THREE.Box3().setFromObject(truck);
            const placement = calculateTruckYardPlacement(layout, loadingYardLayout, {
                minX: truckBounds.min.x * 1000, maxX: truckBounds.max.x * 1000,
                minZ: truckBounds.min.z * 1000, maxZ: truckBounds.max.z * 1000
            });
            if (!placement) return null;
            truck.userData.loadingSide = placement.side;
            truck.userData.groundBounds = placement.bounds;
            const infoBillboard = createTruckInfoBillboardSprite(THREE, truckInfo);
            infoBillboard.name = `WAREHOUSE-TRUCK-INFO-BILLBOARD-${layout.rackCode}`;
            infoBillboard.position.set(0, warehouseFloorElevation + 3.55, cargoLength / 2);
            infoBillboard.userData.dockCode = layout.rackCode;
            truck.add(infoBillboard);
            truck.userData.infoBillboard = infoBillboard;
            truck.position.set(mm(placement.anchorX), 0, mm(placement.anchorZ));
            truck.rotation.y = placement.yaw;
            scene.add(truck);
            return truck;
        };
        const staticTrucks = loadingDockLayoutEntries.map(createStaticTruck).filter(Boolean);
        shell.viewport.dataset.warehouseTruck = staticTrucks.length ? 'static-5t-fleet' : 'none';
        shell.viewport.dataset.warehouseTruckCount = String(staticTrucks.length);
        shell.viewport.dataset.warehouseTruckLoadingSides = staticTrucks.map((truck) => truck.userData.loadingSide).join(',');
        shell.viewport.dataset.warehouseTruckGroundBounds = JSON.stringify(staticTrucks.map((truck) => ({ dock: truck.userData.dockCode, ...truck.userData.groundBounds })));
        shell.viewport.dataset.warehouseTruckDockCodes = staticTrucks.map((truck) => truck.userData.dockCode).join(',');
        shell.viewport.dataset.warehouseTruckRack = staticTrucks.map((truck) => truck.userData.rackCode).join(',');
        shell.viewport.dataset.warehouseTruckCargoSize = staticTrucks.length ? '6.2x2.2x2.3' : '';
        shell.viewport.dataset.warehouseTruckModel = staticTrucks.length ? 'reference-low-poly-cab-over' : 'none';
        shell.viewport.dataset.warehouseTruckAxleCount = staticTrucks.length ? '3' : '0';
        shell.viewport.dataset.warehouseTruckInfoBillboardCount = String(staticTrucks.filter((truck) => truck.userData.infoBillboard).length);
        shell.viewport.dataset.warehouseTruckInfoFields = 'vehicle-number,company-name,scheduled-item-quantity';
        shell.viewport.dataset.warehouseTruckInfoLayout = 'operation-vehicle-company-schedule-progress-bottom-invoice';
        shell.viewport.dataset.warehouseTruckInfoSpacing = 'compact';
        shell.viewport.dataset.warehouseTruckInfoCompanyLabels = '납품처,공급처';
        shell.viewport.dataset.warehouseTruckInfoInvoiceButton = '송장보기';
        shell.viewport.dataset.warehouseTruckInfoFontReference = 'transport-equipment-billboard';
        shell.viewport.dataset.warehouseTruckScheduleCodes = staticTrucks.map((truck) => truck.userData.scheduleCode || '').join(',');

        const loadingDockBillboardHeight = warehouseFloorElevation + 2.6;
        const loadingDockBillboards = loadingDockLayoutEntries.map((layout) => {
            if (!layout?.bounds || !layout.rackCode) return null;
            const label = createLabelSprite(THREE, layout.rackCode);
            label.name = `WAREHOUSE-LOADING-DOCK-BILLBOARD-${layout.rackCode}`;
            label.position.set(
                mm((layout.bounds.minX + layout.bounds.maxX) / 2),
                loadingDockBillboardHeight,
                mm((layout.bounds.minZ + layout.bounds.maxZ) / 2)
            );
            label.userData = {
                kind: 'loading-dock-label',
                dockCode: layout.rackCode,
                billboardStyle: 'rack-label'
            };
            scene.add(label);
            return label;
        }).filter(Boolean);
        shell.viewport.dataset.warehouseDockBillboardCount = String(loadingDockBillboards.length);
        shell.viewport.dataset.warehouseDockBillboardCodes = loadingDockBillboards.map((label) => label.userData.dockCode).join(',');
        shell.viewport.dataset.warehouseDockBillboardStyle = 'rack-label';
        shell.viewport.dataset.warehouseDockBillboardHeight = String(loadingDockBillboardHeight);

        const passageCellSize = mm(data.meta?.floorPlanCellSize || 500);
        const passageCells = Array.isArray(data.meta?.passageCells) ? data.meta.passageCells : [];
        const shuttlePassageCells = Array.isArray(data.meta?.shuttlePassageCells) ? data.meta.shuttlePassageCells : [];
        const passageBoundaryWidthMm = 100;
        const passageBoundaryInsetMm = 100;
        const passageBoundarySegments = buildPassageBoundarySegments(
            passageCells,
            data.meta?.floorPlanCellSize || 500,
            passageBoundaryWidthMm,
            passageBoundaryInsetMm
        );
        let passageBoundaryGeometry = null;
        let passageBoundaryMaterial = null;
        if (passageBoundarySegments.length) {
            passageBoundaryGeometry = new THREE.BoxGeometry(1, 0.012, 1);
            passageBoundaryMaterial = new THREE.MeshBasicMaterial({ color: '#facc15' });
            const passageBoundaries = new THREE.InstancedMesh(
                passageBoundaryGeometry,
                passageBoundaryMaterial,
                passageBoundarySegments.length
            );
            const passageMatrix = new THREE.Matrix4();
            passageBoundarySegments.forEach((segment, index) => {
                passageMatrix.makeScale(mm(segment.width), 1, mm(segment.depth));
                passageMatrix.setPosition(mm(segment.x), warehouseFloorElevation + 0.006, mm(segment.y));
                passageBoundaries.setMatrixAt(index, passageMatrix);
            });
            passageBoundaries.instanceMatrix.needsUpdate = true;
            passageBoundaries.renderOrder = 3;
            scene.add(passageBoundaries);
        }
        const conveyorBoundarySegments = buildPassageBoundarySegments(
            conveyorCells,
            data.meta?.floorPlanCellSize || 500,
            passageBoundaryWidthMm,
            passageBoundaryInsetMm
        );
        let conveyorBoundaryGeometry = null;
        let conveyorBoundaryMaterial = null;
        if (conveyorBoundarySegments.length) {
            conveyorBoundaryGeometry = new THREE.BoxGeometry(1, 0.012, 1);
            conveyorBoundaryMaterial = new THREE.MeshBasicMaterial({ color: '#facc15' });
            const conveyorBoundaries = new THREE.InstancedMesh(
                conveyorBoundaryGeometry,
                conveyorBoundaryMaterial,
                conveyorBoundarySegments.length
            );
            conveyorBoundaries.name = 'WAREHOUSE-CONVEYOR-TRACK-LINES';
            conveyorBoundaries.userData = { kind: 'conveyor-track-lines', source: 'floorPlan', code: 'CV' };
            const conveyorBoundaryMatrix = new THREE.Matrix4();
            conveyorBoundarySegments.forEach((segment, index) => {
                conveyorBoundaryMatrix.makeScale(mm(segment.width), 1, mm(segment.depth));
                conveyorBoundaryMatrix.setPosition(mm(segment.x), warehouseFloorElevation + 0.007, mm(segment.y));
                conveyorBoundaries.setMatrixAt(index, conveyorBoundaryMatrix);
            });
            conveyorBoundaries.instanceMatrix.needsUpdate = true;
            conveyorBoundaries.renderOrder = 4;
            scene.add(conveyorBoundaries);
        }
        shell.viewport.dataset.warehouseConveyorLineCount = String(conveyorBoundarySegments.length);
        const conveyorLayout = buildConveyorLayout(conveyorCells, data.meta?.floorPlanCellSize || 500);
        const conveyorModel = createConveyorModel(THREE, conveyorLayout, warehouseFloorElevation);
        scene.add(conveyorModel.group);
        const barcodeTunnelLayout = data.meta?.source === 'drawing' ? window.WmsWarehouseDrawingScene.tunnels(data.meta.plan) : window.WmsBarcodeTunnel.buildLayout(data.meta?.barcodeTunnelCells, conveyorCells, data.meta?.floorPlanCellSize);
        const barcodeTunnelModel = window.WmsBarcodeTunnel.createModel(THREE, barcodeTunnelLayout, warehouseFloorElevation);
        const barcodeTunnelTargets = [];
        const barcodeTunnelLabelTargets = [];
        let hoveredBarcodeTunnel = null;
        let selectedBarcodeTunnel = null;
        const workOrderByCode = new Map((data.workOrders || []).map(workOrder => [workOrder.code, workOrder]));
        const scanItemByCode = new Map((data.items || []).map(item => [item.code, item]));
        const scanRouteByCode = new Map((data.operationRoutes || []).map(route => [route.code, route]));
        const resolveBarcodeScanMetadata = cargoId => {
            const workOrder = workOrderByCode.get(cargoId) || data.workOrders?.find(order => order.code === cargoId);
            const item = scanItemByCode.get(workOrder?.itemCode);
            const route = scanRouteByCode.get(workOrder?.routeCode);
            const quantity = Number(workOrder?.quantity || 0);
            const itemName = item?.name || workOrder?.itemCode || '미설정 품목';
            const itemInfo = `${workOrder?.itemCode || '미설정'} · ${itemName}${quantity > 0 ? ` · ${quantity}개` : ''}`;
            const destination = workOrder?.direction === '출고'
                ? route?.buffer || '버퍼 배정 대기'
                : workOrder?.finalLocationCode || '랙 로케이션 배정 대기';
            return {
                result: '정상 인식', itemInfo, destination,
                barcode: workOrder?.barcode || `HU-${cargoId || 'UNKNOWN'}`
            };
        };
        barcodeTunnelModel.entries.forEach(entry => {
            const code = entry.tunnel.name;
            const label = createAmrLabelSprite(THREE, {
                name: code,
                communicationStatus: entry.communicationStatus,
                equipmentStatus: entry.equipmentStatus
            });
            label.name = `${code}-status-billboard`;
            label.position.set(0, entry.tunnel.userData.height + 1.02, 0);
            label.userData = {
                ...label.userData,
                kind: 'barcode-tunnel-label',
                barcodeTunnel: entry,
                equipmentCode: code
            };
            entry.label = label;
            entry.tunnel.add(label);
            barcodeTunnelLabelTargets.push(label);
            entry.tunnel.traverse(object => {
                if (!object.isMesh) return;
                object.userData = { ...object.userData, kind: 'barcode-tunnel', barcodeTunnel: entry };
                barcodeTunnelTargets.push(object);
            });
        });
        scene.add(barcodeTunnelModel.group);
        shell.viewport.dataset.barcodeTunnelCount = String(barcodeTunnelLayout.length);
        shell.viewport.dataset.barcodeTunnelLayout = JSON.stringify(barcodeTunnelLayout);
        shell.viewport.dataset.barcodeTunnelBillboardCount = String(barcodeTunnelLabelTargets.length);
        shell.viewport.dataset.warehouseConveyorModel = 'roller';
        shell.viewport.dataset.warehouseConveyorHeight = '1';
        shell.viewport.dataset.warehouseConveyorModuleCount = String(conveyorLayout.modules.length);
        shell.viewport.dataset.warehouseConveyorTransferCount = String(conveyorLayout.modules.filter((module) => module.axis === 'transfer').length);
        shell.viewport.dataset.warehouseConveyorRollerCount = String(conveyorModel.rollerCount);
        shell.viewport.dataset.warehouseConveyorWidths = [...new Set(conveyorLayout.modules.filter((module) => module.axis !== 'transfer').map((module) => module.width / 1000))].join(',');
        const dockBoundarySegments = buildPassageBoundarySegments(
            dockCells,
            data.meta?.floorPlanCellSize || 500,
            passageBoundaryWidthMm,
            passageBoundaryInsetMm
        );
        let dockBoundaryGeometry = null;
        let dockBoundaryMaterial = null;
        if (dockBoundarySegments.length) {
            dockBoundaryGeometry = new THREE.BoxGeometry(1, 0.012, 1);
            dockBoundaryMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
            const dockBoundaries = new THREE.InstancedMesh(
                dockBoundaryGeometry,
                dockBoundaryMaterial,
                dockBoundarySegments.length
            );
            dockBoundaries.name = 'WAREHOUSE-LOADING-DOCK-LINES';
            dockBoundaries.userData = { kind: 'loading-dock-lines', source: 'floorPlan', code: 'D' };
            const dockBoundaryMatrix = new THREE.Matrix4();
            dockBoundarySegments.forEach((segment, index) => {
                dockBoundaryMatrix.makeScale(mm(segment.width), 1, mm(segment.depth));
                dockBoundaryMatrix.setPosition(mm(segment.x), warehouseFloorElevation + 0.008, mm(segment.y));
                dockBoundaries.setMatrixAt(index, dockBoundaryMatrix);
            });
            dockBoundaries.instanceMatrix.needsUpdate = true;
            dockBoundaries.renderOrder = 4;
            scene.add(dockBoundaries);
        }
        shell.viewport.dataset.warehouseDockLineCount = String(dockBoundarySegments.length);
        const bufferBoundarySegments = buildPassageBoundarySegments(
            bufferCells,
            data.meta?.floorPlanCellSize || 500,
            passageBoundaryWidthMm,
            passageBoundaryInsetMm
        );
        let bufferBoundaryGeometry = null;
        let bufferBoundaryMaterial = null;
        if (bufferBoundarySegments.length) {
            bufferBoundaryGeometry = new THREE.BoxGeometry(1, 0.012, 1);
            bufferBoundaryMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
            const bufferBoundaries = new THREE.InstancedMesh(
                bufferBoundaryGeometry,
                bufferBoundaryMaterial,
                bufferBoundarySegments.length
            );
            bufferBoundaries.name = 'WAREHOUSE-HANDOFF-BUFFER-LINES';
            bufferBoundaries.userData = { kind: 'handoff-buffer-lines', source: 'floorPlan', code: 'B' };
            const bufferBoundaryMatrix = new THREE.Matrix4();
            bufferBoundarySegments.forEach((segment, index) => {
                bufferBoundaryMatrix.makeScale(mm(segment.width), 1, mm(segment.depth));
                bufferBoundaryMatrix.setPosition(mm(segment.x), warehouseFloorElevation + 0.009, mm(segment.y));
                bufferBoundaries.setMatrixAt(index, bufferBoundaryMatrix);
            });
            bufferBoundaries.instanceMatrix.needsUpdate = true;
            bufferBoundaries.renderOrder = 5;
            scene.add(bufferBoundaries);
        }
        const bufferCodes = [...new Set(bufferCells.map((cell) => cell.code).filter(Boolean))].sort();
        const bufferBillboardHeight = warehouseFloorElevation + 1.4;
        const bufferBillboards = bufferCodes.map((bufferCode) => {
            const cells = bufferCells.filter((cell) => cell.code === bufferCode);
            if (!cells.length) return null;
            const centerX = cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length + (data.meta?.floorPlanCellSize || 500) / 2;
            const centerZ = cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length + (data.meta?.floorPlanCellSize || 500) / 2;
            const label = createLabelSprite(THREE, bufferCode);
            label.name = `WAREHOUSE-HANDOFF-BUFFER-BILLBOARD-${bufferCode}`;
            label.position.set(mm(centerX), bufferBillboardHeight, mm(centerZ));
            label.userData = { kind: 'handoff-buffer-label', bufferCode, billboardStyle: 'rack-label' };
            scene.add(label);
            return label;
        }).filter(Boolean);
        shell.viewport.dataset.warehouseBufferLineCount = String(bufferBoundarySegments.length);
        shell.viewport.dataset.warehouseBufferBillboardCount = String(bufferBillboards.length);
        shell.viewport.dataset.warehouseBufferBillboardCodes = bufferCodes.join(',');
        const shuttleRailLayout = buildShuttleRailLayout(
            shuttlePassageCells,
            stationCells,
            data.meta?.floorPlanCellSize || 500
        );
        const shuttleFootprintMm = calculateShuttleFootprintMm(
            data.meta?.source === 'drawing' ? data.meta.plan.objects.filter(o=>o.kind==='S').map(o=>({minX:0,minY:0,maxX:o.w*1000,maxY:o.h*1000})) : shuttleRailLayout.stations,
            data.meta?.floorPlanCellSize || 500
        );
        const shuttleFootprintMeters = mm(shuttleFootprintMm);
        const shuttlePathToleranceMm = Math.min(100, shuttleFootprintMm * 0.1);
        const shuttlePathClearanceMm = Math.max(
            data.meta?.floorPlanCellSize || 500,
            shuttleFootprintMm - shuttlePathToleranceMm
        );
        const shuttleResources = [];
        const shuttleStationEntries = [];
        const shuttleDeckMaterial = new THREE.MeshStandardMaterial({
            color: '#435466', roughness: 0.62, metalness: 0.42,
            transparent: true, opacity: 0.78
        });
        const shuttleFrameMaterial = new THREE.MeshStandardMaterial({ color: '#f5b942', roughness: 0.5, metalness: 0.34 });
        const shuttleFrameHeight = 0.085;
        const shuttleFrameCenterOffset = 0.075;
        const shuttleTravelBaseOffset = 0.055;
        const shuttleDeckGeometry = new THREE.BoxGeometry(1, 1, 1);
        const shuttleFrameGeometry = new THREE.BoxGeometry(1, 1, 1);
        const stationFrameMaterial = new THREE.MeshPhysicalMaterial({ color: '#435466', roughness: 0.3, metalness: 0.76 });
        shuttleRailLayout.stations.forEach((station) => {
            const group = new THREE.Group();
            group.name = `WAREHOUSE-INOUT-STATION-${station.code}`;
            group.userData = { kind: 'inout-station', code: station.code, source: 'floorPlan-S' };
            const width = Math.max(passageCellSize, mm(station.maxX - station.minX));
            const depth = Math.max(passageCellSize, mm(station.maxY - station.minY));
            const frameThickness = 0.065;
            [[0, -depth / 2], [0, depth / 2]].forEach(([x, z]) => {
                const beamGeometry = new THREE.BoxGeometry(width + 0.08, frameThickness, frameThickness);
                shuttleResources.push(beamGeometry);
                const beam = new THREE.Mesh(beamGeometry, stationFrameMaterial);
                beam.position.set(x, 0.22, z);
                group.add(beam);
            });
            group.position.set(mm(station.centerX), warehouseFloorElevation, mm(station.centerY));
            scene.add(group);
            shuttleStationEntries.push({ ...station, group, width, depth });
        });
        shuttleResources.push(
            shuttleDeckGeometry, shuttleFrameGeometry, shuttleDeckMaterial, shuttleFrameMaterial,
            stationFrameMaterial
        );
        shell.viewport.dataset.shuttleRailSegmentCount = String(shuttleRailLayout.segments.length);
        shell.viewport.dataset.shuttlePassageCellCount = String(shuttlePassageCells.length);
        shell.viewport.dataset.shuttleStationCount = String(shuttleStationEntries.length);
        shell.viewport.dataset.shuttleStationCodes = shuttleStationEntries.map((entry) => entry.code).join(',');
        shell.viewport.dataset.shuttleStationBillboardCount = '0';
        shell.viewport.dataset.shuttleStationRollerCount = '0';
        shell.viewport.dataset.shuttleStationDeckCount = '0';
        const configuredAmrEquipment = (data.equipment || []).filter((item) =>
            item.enabled && /^AMR-/i.test(String(item.code || ''))
        );
        const fallbackAmrEquipment = data.meta?.equipmentLoadWarning
            ? Array.from({ length: 5 }, (_, index) => {
                const code = `AMR-${String(index + 1).padStart(3, '0')}`;
                return { code, name: code, enabled: true };
            })
            : [];
        const amrEquipment = configuredAmrEquipment.length ? configuredAmrEquipment : fallbackAmrEquipment;
        const amrCount = amrEquipment.length;
        const forkliftClearanceDiameterMm = calculateAmrPassageClearanceMm(
            passageCells,
            data.meta?.floorPlanCellSize || 500,
            1950
        );
        const passageNavigation = buildPassageNavigationGraph(
            passageCells,
            data.meta?.floorPlanCellSize || 500,
            forkliftClearanceDiameterMm
        );
        const amrCorridorAssignments = buildAmrCorridorAssignments(
            passageNavigation,
            shuttleStationEntries,
            amrCount
        );
        const amrComponent = amrCorridorAssignments[0]?.componentKeys || [];
        const amrNavigableKeys = new Set(amrCorridorAssignments.flatMap((assignment) => assignment.componentKeys));
        const amrFleet = [];
        const amrLabelTargets = [];
        const equipmentByCode = new Map((data.equipment || []).map(item => [item.code, item]));
        const equipmentStatusByCode = new Map((data.equipmentStatuses || []).map(item => [item.equipmentCode, item]));
        const amrResources = [];
        const simplifyPath = (path) => path.filter((node, index) => {
            if (index === 0 || index === path.length - 1) return true;
            const previous = path[index - 1];
            const next = path[index + 1];
            return (node.gridX - previous.gridX) !== (next.gridX - node.gridX)
                || (node.gridY - previous.gridY) !== (next.gridY - node.gridY);
        });
        const travelForkHeight = 0.08;
        const forkThickness = 0.055;
        const amrVisualScale = 0.9;
        // Metres, measured from the navigation pivot. Keep docking and geometry in sync.
        const stackerDimensions = Object.freeze({
            mastZ: -0.24,
            forkLength: 0.98,
            forkCenterZ: 0.57,
            maxExtension: 1.85,
            frontReach: 0.82,
            rackClearance: 0.1
        });
        const createForkliftModel = (index) => {
            const group = new THREE.Group();
            group.name = `FORKLIFT-AMR-${index + 1}`;
            group.userData.kind = 'forklift-amr';
            group.userData.amrId = index + 1;
            group.userData.modelType = 'slim-autonomous-stacker';
            const shadowGeometry = new THREE.CircleGeometry(0.72, 32);
            const shadowMaterial = new THREE.MeshBasicMaterial({ color: '#020617', transparent: true, opacity: 0.42, depthWrite: false });
            const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
            shadow.rotation.x = -Math.PI / 2;
            shadow.position.y = 0.018;
            group.add(shadow);
            const bodyMaterial = new THREE.MeshPhysicalMaterial({
                color: '#32b5e5', roughness: 0.35, metalness: 0.25,
                clearcoat: 0.5, clearcoatRoughness: 0.22
            });
            const darkMaterial = new THREE.MeshPhysicalMaterial({ color: '#151d25', roughness: 0.48, metalness: 0.38 });
            const steelMaterial = new THREE.MeshPhysicalMaterial({ color: '#657581', roughness: 0.28, metalness: 0.8 });
            const forkMaterial = new THREE.MeshPhysicalMaterial({ color: '#303b45', roughness: 0.38, metalness: 0.75 });
            const wheelMaterial = new THREE.MeshPhysicalMaterial({ color: '#050b14', roughness: 0.72, metalness: 0.08 });
            const yellowMaterial = new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.55 });
            const greenMaterial = new THREE.MeshStandardMaterial({ color: '#32efd4', emissive: '#10bfa0', emissiveIntensity: 0.8 });
            const redMaterial = new THREE.MeshStandardMaterial({ color: '#ef4444', emissive: '#991b1b', emissiveIntensity: 0.3 });
            const screenMaterial = new THREE.MeshStandardMaterial({ color: '#99d9f2', emissive: '#267eab', emissiveIntensity: 0.45 });
            const addPart = (name, geometry, material, position, parent = group) => {
                const mesh = new THREE.Mesh(geometry, material);
                mesh.name = name;
                mesh.position.set(...position);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                parent.add(mesh);
                amrResources.push(geometry);
                return mesh;
            };
            const box = (name, size, position, material = darkMaterial, parent = group) =>
                addPart(name, new THREE.BoxGeometry(...size), material, position, parent);
            // Chamfered, tall blue cabinet: no operator cab, roof or counterweight.
            const bodyProfile = new THREE.Shape();
            bodyProfile.moveTo(-0.44, 0.22);
            bodyProfile.lineTo(0.44, 0.22);
            bodyProfile.lineTo(0.44, 1.64);
            bodyProfile.lineTo(0.31, 1.82);
            bodyProfile.lineTo(-0.31, 1.82);
            bodyProfile.lineTo(-0.44, 1.64);
            bodyProfile.closePath();
            addPart('forklift-body', new THREE.ExtrudeGeometry(bodyProfile, {
                depth: 0.44, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015,
                bevelSegments: 1, steps: 1
            }), bodyMaterial, [0, 0, -0.76]);
            box('stacker-base', [0.94, 0.16, 0.54], [0, 0.17, -0.51]);
            box('stacker-bumper', [0.92, 0.1, 0.07], [0, 0.12, -0.8]);
            box('stacker-safety-band', [0.9, 0.035, 0.012], [0, 0.27, -0.781], yellowMaterial);
            const fasciaProfile = new THREE.Shape();
            fasciaProfile.moveTo(-0.29, 0.34);
            fasciaProfile.lineTo(0.29, 0.34);
            fasciaProfile.lineTo(0.1, 0.72);
            fasciaProfile.lineTo(0.1, 1.35);
            fasciaProfile.lineTo(0.34, 1.67);
            fasciaProfile.lineTo(-0.34, 1.67);
            fasciaProfile.lineTo(-0.1, 1.35);
            fasciaProfile.lineTo(-0.1, 0.72);
            fasciaProfile.closePath();
            addPart('stacker-black-fascia', new THREE.ExtrudeGeometry(fasciaProfile, {
                depth: 0.012, bevelEnabled: false
            }), darkMaterial, [0, 0, -0.788]);
            box('stacker-status-light', [0.025, 0.48, 0.015], [0, 0.95, -0.798], greenMaterial);
            box('stacker-console', [0.26, 0.16, 0.025], [0.22, 1.67, -0.76]);
            box('stacker-display', [0.2, 0.1, 0.012], [0.22, 1.67, -0.78], screenMaterial);
            const stop = addPart('stacker-emergency-stop', new THREE.CylinderGeometry(0.043, 0.043, 0.04, 12), redMaterial, [-0.24, 1.57, -0.79]);
            stop.rotation.x = Math.PI / 2;
            [-0.44, 0.44].forEach((x) => {
                const drive = addPart('stacker-drive-wheel', new THREE.CylinderGeometry(0.11, 0.11, 0.075, 16), wheelMaterial, [x, 0.11, -0.54]);
                drive.rotation.z = Math.PI / 2;
                box('stacker-support-leg', [0.12, 0.05, 1.04], [x, 0.055, 0.24]);
                const roller = addPart('stacker-load-roller', new THREE.CylinderGeometry(0.047, 0.047, 0.1, 12), wheelMaterial, [x, 0.047, 0.68]);
                roller.rotation.z = Math.PI / 2;
                box('stacker-leg-marker', [0.125, 0.015, 0.1], [x, 0.086, 0.64], yellowMaterial);
                box('stacker-side-safety-band', [0.016, 0.035, 0.4], [x * 1.03, 0.27, -0.51], yellowMaterial);
                [0.42, 0.51].forEach(y => box('stacker-vent', [0.016, 0.035, 0.18], [x * 1.04, y, -0.51]));
            });
            box('stacker-sensor-tower', [0.18, 0.75, 0.18], [0, 2.15, -0.53]);
            box('stacker-sensor-head', [0.36, 0.2, 0.28], [0, 2.57, -0.53]);
            [-0.11, 0, 0.11].forEach(x => box('stacker-sensor-window', [0.045, 0.055, 0.012], [x, 2.57, -0.676], screenMaterial));
            [greenMaterial, yellowMaterial, redMaterial].forEach((material, i) =>
                box('stacker-signal-tower', [0.06, 0.09, 0.022], [0, 2.13 + i * 0.095, -0.63], material));
            addPart('stacker-lidar', new THREE.CylinderGeometry(0.075, 0.075, 0.07, 16), redMaterial, [0, 2.72, -0.53]);
            const mastGroup = new THREE.Group();
            mastGroup.name = 'forklift-mast';
            mastGroup.position.z = stackerDimensions.mastZ / amrVisualScale;
            [-0.31, 0.31].forEach(x => box('stacker-outer-mast', [0.075, 2.45, 0.1], [x, 1.3, 0], darkMaterial, mastGroup));
            box('stacker-mast-crossbar', [0.69, 0.08, 0.1], [0, 2.5, 0], darkMaterial, mastGroup);
            const mastMiddle = new THREE.Group();
            [-0.23, 0.23].forEach(x => box('stacker-middle-mast', [0.055, 2.25, 0.075], [x, 1.22, 0.02], steelMaterial, mastMiddle));
            mastGroup.add(mastMiddle);
            const mastUpper = new THREE.Group();
            [-0.16, 0.16].forEach(x => box('stacker-inner-mast', [0.045, 2.05, 0.055], [x, 1.12, 0.04], darkMaterial, mastUpper));
            mastGroup.add(mastUpper);
            const carriage = new THREE.Group();
            carriage.name = 'forklift-carriage';
            carriage.position.y = travelForkHeight / amrVisualScale;
            const reachRails = [-0.24, 0.24].map(x => {
                const rail = box('stacker-reach-guide', [0.075, 0.025, 1], [x, -0.025, 0.06], steelMaterial, carriage);
                rail.scale.z = 0.12;
                return rail;
            });
            const forkAssembly = new THREE.Group();
            forkAssembly.name = 'forklift-forks';
            forkAssembly.scale.setScalar(1 / amrVisualScale);
            box('stacker-carriage-back', [0.62, 0.13, 0.07], [0, 0.35, 0.065], darkMaterial, forkAssembly);
            [-0.24, 0.24].forEach((x) => {
                box('stacker-fork-heel', [0.095, 0.39, 0.06], [x, 0.19, 0.08], forkMaterial, forkAssembly);
                box('stacker-fork-tine', [0.11, forkThickness, stackerDimensions.forkLength], [x, 0, stackerDimensions.forkCenterZ], forkMaterial, forkAssembly);
            });
            const loadAnchor = new THREE.Group();
            loadAnchor.name = 'forklift-load-anchor';
            loadAnchor.position.set(0, forkThickness / 2, stackerDimensions.forkCenterZ);
            forkAssembly.add(loadAnchor);
            carriage.add(forkAssembly);
            mastGroup.add(carriage);
            group.add(mastGroup);
            group.scale.setScalar(amrVisualScale);
            amrResources.push(
                shadowGeometry, shadowMaterial, bodyMaterial, darkMaterial, steelMaterial, forkMaterial,
                wheelMaterial, yellowMaterial, greenMaterial, redMaterial, screenMaterial
            );
            return { group, carriage, forkAssembly, loadAnchor, mastMiddle, mastUpper, reachRails };
        };
        const chooseAmrDestination = (amr) => {
            const componentKeys = amr.corridorKeys || amrComponent;
            if (componentKeys.length < 2) return amr.currentKey;
            const current = passageNavigation.nodesByKey.get(amr.currentKey);
            let selectedKey = amr.currentKey;
            let selectedDistance = -1;
            for (let attempt = 0; attempt < 16; attempt += 1) {
                const candidateKey = componentKeys[Math.floor(Math.random() * componentKeys.length)];
                const candidate = passageNavigation.nodesByKey.get(candidateKey);
                const candidateDistance = Math.abs(candidate.gridX - current.gridX) + Math.abs(candidate.gridY - current.gridY);
                if (candidateDistance > selectedDistance) {
                    selectedKey = candidateKey;
                    selectedDistance = candidateDistance;
                }
            }
            return selectedKey;
        };
        const planAmrRoute = (amr, timestamp = performance.now()) => {
            const destinationKey = chooseAmrDestination(amr);
            const path = simplifyPath(findPassagePath(passageNavigation, amr.currentKey, destinationKey));
            amr.route = path.length > 1 ? path : [passageNavigation.nodesByKey.get(amr.currentKey)];
            amr.waypointIndex = Math.min(1, amr.route.length - 1);
            amr.waitUntil = path.length > 1 ? timestamp : timestamp + 800;
        };
        if (amrCorridorAssignments.length) {
            for (let index = 0; index < amrCount; index += 1) {
                const configuredEquipment = amrEquipment[index];
                const corridor = amrCorridorAssignments[index];
                const startKey = corridor.farKey;
                const startNode = passageNavigation.nodesByKey.get(startKey);
                const model = createForkliftModel(index);
                model.group.position.set(mm(startNode.x), warehouseFloorElevation, mm(startNode.y));
                scene.add(model.group);
                const amr = {
                    ...model,
                    index,
                    equipmentCode: configuredEquipment.code,
                    equipmentName: configuredEquipment.name,
                    equipmentType: configuredEquipment.type || 'FORKLIFT',
                    modelName: configuredEquipment.modelName,
                    configuredSpeed: configuredEquipment.configuredSpeed,
                    kindLabel: 'AMR',
                    corridorCode: corridor.code,
                    corridorKeys: corridor.componentKeys,
                    corridorNearKey: corridor.nearKey,
                    corridorFarKey: corridor.farKey,
                    currentKey: startKey,
                    route: [startNode],
                    waypointIndex: 0,
                    speed: 0.9 + index * 0.08,
                    waitUntil: performance.now() + index * 240,
                    state: 'driving',
                    stateStartedAt: performance.now(),
                    forkHeight: travelForkHeight,
                    forkExtension: 0,
                    task: null,
                    completedTasks: 0,
                    carriedLoad: null,
                    placedLoad: null
                };
                amr.equipmentName = configuredEquipment.name || equipmentByCode.get(amr.equipmentCode)?.name || amr.equipmentCode;
                const equipmentStatus = equipmentStatusByCode.get(amr.equipmentCode) || {};
                Object.assign(amr, equipmentStatus);
                amr.communicationStatus = amr.communicationStatus || 'OFFLINE';
                amr.equipmentStatus = amr.equipmentStatus || '미설정';
                amr.label = createAmrLabelSprite(THREE, {
                    name: amr.equipmentName,
                    communicationStatus: amr.communicationStatus,
                    equipmentStatus: amr.equipmentStatus,
                    parentScale: amrVisualScale
                });
                amr.label.name = amr.equipmentName;
                amr.label.position.set(0, 3.26 / amrVisualScale, 0);
                amr.label.userData = { ...amr.label.userData, kind: 'amr-label', amr };
                amr.group.userData.equipmentCode = amr.equipmentCode;
                amr.group.add(amr.label);
                amrLabelTargets.push(amr.label);
                amrFleet.push(amr);
                planAmrRoute(amr, amr.waitUntil);
            }
        }
        shell.viewport.dataset.amrCount = String(amrFleet.length);
        shell.viewport.dataset.amrVisualScale = String(amrVisualScale);
        shell.viewport.dataset.amrForkScalePolicy = 'pallet-compatible';
        shell.viewport.dataset.amrPathfinding = amrFleet.length ? 'astar' : 'unavailable';
        shell.viewport.dataset.amrClearance = String(forkliftClearanceDiameterMm);
        shell.viewport.dataset.amrCorridorCount = String(amrCorridorAssignments.length);
        shell.viewport.dataset.amrCorridorAssignments = amrFleet
            .map((amr) => `${amr.equipmentCode}:${amr.corridorCode}`)
            .join(',');
        renderer.domElement.setAttribute('aria-label', `기준정보 기반 3D 창고, 무인 지게차 ${amrFleet.length}대 운행 중`);
        const grid = new THREE.Group();
        const gridPositions = [];
        for (let x = 0; x <= floorWidth + 0.0001; x += passageCellSize) {
            gridPositions.push(x, 0, 0, x, 0, floorDepth);
        }
        for (let z = 0; z <= floorDepth + 0.0001; z += passageCellSize) {
            gridPositions.push(0, 0, z, floorWidth, 0, z);
        }
        const gridGeometry = new THREE.BufferGeometry();
        gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gridPositions, 3));
        grid.add(new THREE.LineSegments(
            gridGeometry,
            new THREE.LineBasicMaterial({ color: '#78a98b', transparent: true, opacity: 0.42 })
        ));
        const boundaryGeometry = new THREE.BufferGeometry();
        boundaryGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
            0, 0.006, 0, floorWidth, 0.006, 0,
            floorWidth, 0.006, 0, floorWidth, 0.006, floorDepth,
            floorWidth, 0.006, floorDepth, 0, 0.006, floorDepth,
            0, 0.006, floorDepth, 0, 0.006, 0
        ], 3));
        grid.add(new THREE.LineSegments(boundaryGeometry, new THREE.LineBasicMaterial({ color: '#2f7454' })));
        grid.position.y = warehouseFloorElevation;
        scene.add(grid);

        const rackTypeByCode = new Map(data.rackTypes.map((type) => [type.code, type]));
        const itemByCode = new Map(data.items.map((item) => [item.code, item]));
        const zoneByCode = new Map(data.zones.map((zone) => [zone.code, zone]));
        const slotKey = (rackCode, rackRow, bay, level, depth) => `${rackCode}|${rackRow}|${bay}|${level}|${depth}`;
        const locationBySlot = new Map((data.locations || []).map((location) => [
            slotKey(location.rackCode, location.rackRow || 1, location.bay, location.level, location.depth || 1),
            location
        ]));
        const inventoryBySlot = new Map(data.inventory.map((stock) => [
            slotKey(stock.rackCode, stock.rackRow || 1, stock.bay, stock.level, stock.depth || 1),
            stock
        ]));
        const inventoryByRack = new Map();
        data.inventory.forEach((stock) => {
            if (!inventoryByRack.has(stock.rackCode)) inventoryByRack.set(stock.rackCode, []);
            inventoryByRack.get(stock.rackCode).push(stock);
        });

        const rackEntries = [];
        const clickTargets = [];
        const labelTargets = [];
        const levelLabelTargets = [];
        const slotMeshEntries = [];
        const zoneVisualizationEntries = [];
        const shuttleFrameVisualObjects = [];
        const geometryCache = new Map();
        const outlineGeometryCache = new Map();
        const outlineTubeGeometryCache = new Map();
        const materialCache = new Map();
        const dimmedMaterialCache = new Map();
        const originalMaterialsByObject = new WeakMap();
        const unitLoadPalletHeight = 0.14;
        const unitLoadPalletColor = '#6b5a45';
        let activeRackLevelFocus = null;
        const getUnitLoadComposition = (width, height, depth, palletWidth = width - 0.02, palletDepth = depth - 0.02) => {
            const palletHeight = Math.min(unitLoadPalletHeight, Math.max(0.04, height - 0.08));
            const deckHeight = palletHeight * 0.4;
            const runnerHeight = palletHeight - deckHeight;
            return {
                cargoHeight: Math.max(0.08, height - palletHeight),
                palletHeight,
                deckHeight,
                runnerHeight,
                palletWidth: Math.max(0.08, Math.min(width, palletWidth)),
                palletDepth: Math.max(0.08, Math.min(depth, palletDepth))
            };
        };
        const getFourWayPalletSupportLayout = (composition) => {
            const supportWidth = Math.max(0.035, composition.palletWidth * 0.18);
            const supportDepth = Math.max(0.035, composition.palletDepth * 0.18);
            const xOffsets = [-composition.palletWidth * 0.36, 0, composition.palletWidth * 0.36];
            const zOffsets = [-composition.palletDepth * 0.36, 0, composition.palletDepth * 0.36];
            return {
                supportWidth,
                supportDepth,
                positions: xOffsets.flatMap((x) => zOffsets.map((z) => ({ x, z })))
            };
        };
        let rackPalletCount = 0;
        let rackPalletSupportCount = 0;
        const getGeometry = (width, height, depth) => {
            const key = `${width}:${height}:${depth}`;
            if (!geometryCache.has(key)) geometryCache.set(key, new THREE.BoxGeometry(width, height, depth));
            return geometryCache.get(key);
        };
        const getChamferedBoxGeometry = (width, height, depth) => {
            const chamfer = Math.min(0.055, Math.max(0.012, Math.min(width, height, depth) * 0.045));
            const key = `chamfer:${width}:${height}:${depth}:${chamfer}`;
            if (!geometryCache.has(key)) {
                const halfWidth = Math.max(chamfer * 2, width / 2 - chamfer);
                const halfHeight = Math.max(chamfer * 2, height / 2 - chamfer);
                const cornerCut = chamfer * 0.85;
                const shape = new THREE.Shape();
                shape.moveTo(-halfWidth + cornerCut, -halfHeight);
                shape.lineTo(halfWidth - cornerCut, -halfHeight);
                shape.lineTo(halfWidth, -halfHeight + cornerCut);
                shape.lineTo(halfWidth, halfHeight - cornerCut);
                shape.lineTo(halfWidth - cornerCut, halfHeight);
                shape.lineTo(-halfWidth + cornerCut, halfHeight);
                shape.lineTo(-halfWidth, halfHeight - cornerCut);
                shape.lineTo(-halfWidth, -halfHeight + cornerCut);
                shape.closePath();
                const geometry = new THREE.ExtrudeGeometry(shape, {
                    depth: Math.max(0.001, depth - chamfer * 2),
                    steps: 1,
                    curveSegments: 1,
                    bevelEnabled: true,
                    bevelSegments: 1,
                    bevelSize: chamfer,
                    bevelThickness: chamfer
                });
                geometry.center();
                geometry.computeVertexNormals();
                geometryCache.set(key, geometry);
            }
            return geometryCache.get(key);
        };
        const getSlotOutlineGeometry = (width, height, depth) => {
            const key = `${width}:${height}:${depth}`;
            if (!outlineGeometryCache.has(key)) {
                const boxGeometry = new THREE.BoxGeometry(width, height, depth);
                const edgeGeometry = new THREE.EdgesGeometry(boxGeometry);
                boxGeometry.dispose();
                outlineGeometryCache.set(key, edgeGeometry);
            }
            return outlineGeometryCache.get(key);
        };
        const getOutlineTubeGeometry = (length, radius) => {
            const key = `${length.toFixed(4)}:${radius}`;
            if (!outlineTubeGeometryCache.has(key)) outlineTubeGeometryCache.set(key, new THREE.CylinderGeometry(radius, radius, length, 6));
            return outlineTubeGeometryCache.get(key);
        };
        const addOuterEdgeTubes = (outline, edgeGeometry, radius, material, renderOrder) => {
            const positions = edgeGeometry.getAttribute('position');
            const up = new THREE.Vector3(0, 1, 0);
            for (let index = 0; index < positions.count; index += 2) {
                const start = new THREE.Vector3().fromBufferAttribute(positions, index);
                const end = new THREE.Vector3().fromBufferAttribute(positions, index + 1);
                const direction = end.clone().sub(start);
                const length = direction.length();
                if (!(length > 0)) continue;
                const segment = new THREE.Mesh(getOutlineTubeGeometry(length, radius), material);
                segment.position.copy(start).add(end).multiplyScalar(0.5);
                segment.quaternion.setFromUnitVectors(up, direction.normalize());
                segment.renderOrder = renderOrder;
                outline.add(segment);
            }
        };
        const getMaterial = (color, options = {}) => {
            const materialOptions = {
                roughness: 0.38,
                metalness: 0.12,
                clearcoat: 0.45,
                clearcoatRoughness: 0.28,
                ...options
            };
            const key = [
                color,
                materialOptions.transparent ? 't' : 'o',
                materialOptions.opacity ?? 1,
                materialOptions.roughness,
                materialOptions.metalness,
                materialOptions.clearcoat,
                materialOptions.clearcoatRoughness
            ].join(':');
            if (!materialCache.has(key)) materialCache.set(key, new THREE.MeshPhysicalMaterial({ color, ...materialOptions }));
            return materialCache.get(key);
        };
        const getDimmedMaterial = (material) => {
            if (!material) return material;
            if (!dimmedMaterialCache.has(material)) {
                const dimmedMaterial = material.clone();
                dimmedMaterial.transparent = true;
                dimmedMaterial.opacity = 0.1;
                dimmedMaterial.depthWrite = false;
                dimmedMaterial.needsUpdate = true;
                dimmedMaterialCache.set(material, dimmedMaterial);
            }
            return dimmedMaterialCache.get(material);
        };
        const setObjectDimmed = (object, dimmed) => {
            const originalMaterial = originalMaterialsByObject.get(object);
            if (!originalMaterial) return;
            object.material = dimmed
                ? (Array.isArray(originalMaterial) ? originalMaterial.map(getDimmedMaterial) : getDimmedMaterial(originalMaterial))
                : originalMaterial;
        };
        const setRackEntryDimmed = (entry, mode = 'none') => {
            if (!entry || entry.dimMode === mode) return;
            entry.visualObjects.forEach((object) => {
                const dimmed = mode === 'all'
                    || (mode === 'frames' && entry.rackStructureObjects.includes(object));
                setObjectDimmed(object, dimmed);
            });
            entry.dimMode = mode;
            entry.dimmed = mode !== 'none';
        };
        const setShuttleFrameDimmed = (dimmed) => {
            shuttleFrameVisualObjects.forEach((object) => setObjectDimmed(object, dimmed));
        };
        const rackHoverMaterial = new THREE.MeshBasicMaterial({ color: '#78ABFF', transparent: true, opacity: 0.92, depthTest: false, depthWrite: false });
        const rackSelectedMaterial = new THREE.MeshBasicMaterial({ color: '#3B82F6', transparent: true, opacity: 1, depthTest: false, depthWrite: false });
        const createRackOutline = (size, position, material) => {
            const outline = new THREE.Group();
            const edgeGeometry = getSlotOutlineGeometry(size[0], size[1], size[2]);
            addOuterEdgeTubes(outline, edgeGeometry, 0.042, material, 12);
            outline.position.set(position[0], position[1], position[2]);
            outline.visible = false;
            outline.renderOrder = 12;
            outline.userData = { material, maxOpacity: material.opacity };
            return outline;
        };
        const addBox = (group, size, position, color, userData, options = {}) => {
            const mesh = new THREE.Mesh(getGeometry(size[0], size[1], size[2]), getMaterial(color, options));
            mesh.position.set(position[0], position[1], position[2]);
            mesh.castShadow = options.castShadow !== false;
            mesh.receiveShadow = true;
            if (userData) mesh.userData = userData;
            group.add(mesh);
            return mesh;
        };

        const createSlotOutline = (color, radius) => {
            const outline = new THREE.Group();
            outline.visible = false;
            outline.renderOrder = 10;
            outline.userData = {
                radius,
                material: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
                maxOpacity: 1
            };
            return outline;
        };
        const hoverOutline = createSlotOutline('#FFFF97', 0.03);
        const selectedOutline = createSlotOutline('#FFFF2D', 0.03);

        data.racks.forEach((rack) => {
            const type = rackTypeByCode.get(rack.rackTypeCode);
            if (!type) return;
            const bayWidth = mm(type.bayWidth);
            const depth = mm(type.depth);
            const height = mm(type.height);
            const levelHeight = mm(type.levelHeight) || height / Math.max(1, type.levels);
            const bayGap = mm(rack.bayGap), rowGap = mm(rack.rowGap);
            const length = bayWidth * rack.bayCount + bayGap * (rack.bayCount - 1);
            const rackRowCount = Math.max(1, Math.round(Number(rack.rackRowCount) || 1));
            const depthCount = Math.max(1, Math.round(Number(type.depthCount) || 1));
            const slotDepth = depth / depthCount;
            const rackWidth = depth * rackRowCount + rowGap * (rackRowCount - 1);
            const group = new THREE.Group();
            group.name = rack.code;
            const rackHorizontalFrameColor = '#f5b942';
            const rackVerticalFrameColor = '#2979FF';
            const rackFrameMaterial = {
                roughness: 0.2,
                metalness: 0.78,
                clearcoat: 0.62,
                clearcoatRoughness: 0.14,
                castShadow: false
            };
            const rackData = { kind: 'rack', rack, type, zone: zoneByCode.get(rack.zoneCode) };
            const rackStructureObjects = [];
            const postSize = Math.min(0.1, Math.max(0.055, bayWidth * 0.045));
            const depthFramePositions = [...new Set(Array.from({length:rackRowCount},(_,row)=>Array.from({length:depthCount+1},(_,d)=>row*(depth+rowGap)+d*slotDepth)).flat())];
            const bayFramePositions = [...new Set(Array.from({length:rack.bayCount},(_,bay)=>[bay*(bayWidth+bayGap),bay*(bayWidth+bayGap)+bayWidth]).flat())];
            for (const x of bayFramePositions) {
                depthFramePositions.forEach((z) => {
                    rackStructureObjects.push(
                        addBox(group, [postSize, height, postSize], [x, height / 2, z], rackVerticalFrameColor, rackData, rackFrameMaterial)
                    );
                });
            }
            for (let level = 0; level <= type.levels; level += 1) {
                const y = Math.min(height, level * levelHeight);
                depthFramePositions.forEach((z) => {
                    rackStructureObjects.push(
                        addBox(group, [length, 0.08, 0.09], [length / 2, y, z], rackHorizontalFrameColor, rackData, rackFrameMaterial)
                    );
                });
                for (let rackRow = 0; rackRow < rackRowCount; rackRow += 1) {
                    const rowStart = rackRow * (depth + rowGap);
                    if (level < type.levels) rackStructureObjects.push(addBox(
                            group,
                            [length, 0.035, depth],
                            [length / 2, y + 0.03, rowStart + depth / 2],
                            '#334155',
                            rackData,
                            {
                                castShadow: false,
                                roughness: 0.38,
                                metalness: 0.62,
                                clearcoat: 0.35,
                                clearcoatRoughness: 0.22
                            }
                        ));
                }
            }
            const stocks = inventoryByRack.get(rack.code) || [];
            const boxWidth = Math.max(0.08, bayWidth * 0.92);
            const boxHeight = Math.max(0.08, levelHeight * 0.82);
            const boxDepth = Math.max(0.08, slotDepth * 0.9);
            const unitLoad = getUnitLoadComposition(
                boxWidth,
                boxHeight,
                boxDepth,
                bayWidth - 0.1,
                slotDepth - 0.1
            );
            const slots = [];
            for (let bay = 1; bay <= rack.bayCount; bay += 1) {
                for (let level = 1; level <= type.levels; level += 1) {
                    for (let rackRow = 1; rackRow <= rackRowCount; rackRow += 1) {
                        for (let depthIndex = 1; depthIndex <= depthCount; depthIndex += 1) {
                        const key = slotKey(rack.code, rackRow, bay, level, depthIndex);
                        const stock = inventoryBySlot.get(key);
                        const location = locationBySlot.get(key);
                        const item = stock ? itemByCode.get(stock.itemCode) : null;
                        const occupied = Boolean(stock && Number(stock.quantity) > 0);
                        slots.push({
                            kind: 'slot',
                            locationCode: location?.locationCode || `${rack.code}-R${String(rackRow).padStart(2, '0')}-B${String(bay).padStart(2, '0')}-L${String(level).padStart(2, '0')}-D${String(depthIndex).padStart(2, '0')}`,
                            rack,
                            type,
                            zone: zoneByCode.get(rack.zoneCode),
                            rackRow,
                            bay,
                            level,
                            depth: depthIndex,
                            depthCount,
                            rackWidth,
                            location,
                            stock,
                            item,
                            occupied,
                            taskVisible: true,
                            group,
                            boxSize: [boxWidth, boxHeight, boxDepth],
                            cargoBoxSize: [boxWidth, unitLoad.cargoHeight, boxDepth],
                            palletSize: [unitLoad.palletWidth, unitLoad.palletHeight, unitLoad.palletDepth],
                            position: [
                                (bay - 0.5) * bayWidth + (bay - 1) * bayGap,
                                (level - 1) * levelHeight + boxHeight / 2 + 0.06,
                                (rackRow - 1) * (depth + rowGap) + (depthIndex - 0.5) * slotDepth
                            ],
                            cargoPosition: [
                                (bay - 0.5) * bayWidth + (bay - 1) * bayGap,
                                (level - 1) * levelHeight + 0.06 + unitLoad.palletHeight + unitLoad.cargoHeight / 2,
                                (rackRow - 1) * (depth + rowGap) + (depthIndex - 0.5) * slotDepth
                            ],
                            palletBaseY: (level - 1) * levelHeight + 0.06
                        });
                    }
                    }
                }
            }
            const createSlotInstances = (slotList, empty) => {
                if (!slotList.length) return;
                const material = getMaterial('#ffffff', empty
                    ? {
                        transparent: true,
                        opacity: 0.5,
                        depthWrite: false,
                        roughness: 0.18,
                        metalness: 0.14,
                        clearcoat: 0.9,
                        clearcoatRoughness: 0.08
                    }
                    : {
                        transparent: false,
                        opacity: 1,
                        roughness: 0.12,
                        metalness: 0.16,
                        clearcoat: 1,
                        clearcoatRoughness: 0.04
                    });
                const boxGeometry = empty
                    ? getChamferedBoxGeometry(boxWidth, boxHeight, boxDepth)
                    : getChamferedBoxGeometry(boxWidth, unitLoad.cargoHeight, boxDepth);
                const mesh = new THREE.InstancedMesh(boxGeometry, material, slotList.length);
                const matrix = new THREE.Matrix4();
                slotList.forEach((slot, index) => {
                    const boxPosition = empty ? slot.position : slot.cargoPosition;
                    matrix.makeTranslation(boxPosition[0], boxPosition[1], boxPosition[2]);
                    mesh.setMatrixAt(index, matrix);
                    mesh.setColorAt(index, new THREE.Color(slotColorPalette[getSlotVisualKey(slot, 'utilization')]));
                    slot.instanceMesh = mesh;
                    slot.instanceIndex = index;
                    slot.instanceMatrix = matrix.clone();
                });
                mesh.instanceMatrix.needsUpdate = true;
                if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
                mesh.castShadow = !empty;
                mesh.receiveShadow = true;
                mesh.userData = { kind: 'slotInstances', slots: slotList };
                group.add(mesh);
                clickTargets.push(mesh);
                slotMeshEntries.push({ mesh, slots: slotList });
            };
            const createRackPalletInstances = (occupiedSlots) => {
                if (!occupiedSlots.length) return;
                const palletMaterial = getMaterial(unitLoadPalletColor, {
                    roughness: 0.72,
                    metalness: 0.06,
                    clearcoat: 0.12,
                    clearcoatRoughness: 0.7
                });
                const deckMesh = new THREE.InstancedMesh(
                    getGeometry(unitLoad.palletWidth, unitLoad.deckHeight, unitLoad.palletDepth),
                    palletMaterial,
                    occupiedSlots.length
                );
                const supportLayout = getFourWayPalletSupportLayout(unitLoad);
                const supportMesh = new THREE.InstancedMesh(
                    getGeometry(supportLayout.supportWidth, unitLoad.runnerHeight, supportLayout.supportDepth),
                    palletMaterial,
                    occupiedSlots.length * supportLayout.positions.length
                );
                const matrix = new THREE.Matrix4();
                occupiedSlots.forEach((slot, index) => {
                    const deckY = slot.palletBaseY + unitLoad.runnerHeight + unitLoad.deckHeight / 2;
                    matrix.makeTranslation(slot.position[0], deckY, slot.position[2]);
                    deckMesh.setMatrixAt(index, matrix);
                    slot.palletInstances = [{ mesh: deckMesh, index, matrix: matrix.clone() }];
                    supportLayout.positions.forEach((supportPosition, supportIndex) => {
                        const instanceIndex = index * supportLayout.positions.length + supportIndex;
                        matrix.makeTranslation(
                            slot.position[0] + supportPosition.x,
                            slot.palletBaseY + unitLoad.runnerHeight / 2,
                            slot.position[2] + supportPosition.z
                        );
                        supportMesh.setMatrixAt(instanceIndex, matrix);
                        slot.palletInstances.push({ mesh: supportMesh, index: instanceIndex, matrix: matrix.clone() });
                    });
                });
                deckMesh.instanceMatrix.needsUpdate = true;
                supportMesh.instanceMatrix.needsUpdate = true;
                deckMesh.castShadow = true;
                deckMesh.receiveShadow = true;
                supportMesh.castShadow = true;
                supportMesh.receiveShadow = true;
                deckMesh.name = 'rack-pallet-decks';
                supportMesh.name = 'rack-pallet-four-way-supports';
                group.add(deckMesh, supportMesh);
                rackPalletCount += occupiedSlots.length;
                rackPalletSupportCount += occupiedSlots.length * supportLayout.positions.length;
            };
            createSlotInstances(slots.filter((slot) => !slot.occupied), true);
            const occupiedSlots = slots.filter((slot) => slot.occupied);
            createSlotInstances(occupiedSlots, false);
            createRackPalletInstances(occupiedSlots);
            const pick = addBox(group, [length, height, rackWidth], [length / 2, height / 2, rackWidth / 2], '#ffffff', rackData, { transparent: true, opacity: 0.001, castShadow: false });
            pick.material.depthWrite = false;
            clickTargets.push(pick);
            const label = createLabelSprite(THREE, rack.code);
            label.position.set(length / 2, height + 0.65, rackWidth / 2);
            label.userData = rackData;
            rackData.label = label;
            clickTargets.push(label);
            labelTargets.push(label);
            const labelLayer = new THREE.Group();
            labelLayer.renderOrder = billboardRenderOrder;
            labelLayer.add(label);
            group.add(labelLayer);
            const levelLabelGroup = new THREE.Group();
            levelLabelGroup.name = `${rack.code}-LEVEL-BILLBOARDS`;
            levelLabelGroup.renderOrder = billboardRenderOrder;
            levelLabelGroup.visible = false;
            const levelLabels = [];
            for (let rackLevel = 1; rackLevel <= type.levels; rackLevel += 1) {
                const levelLabel = createLevelBadgeSprite(THREE, rackLevel);
                levelLabel.name = `${rack.code}-LV${rackLevel}`;
                levelLabel.position.set(length + 0.72, (rackLevel - 0.5) * levelHeight, rackWidth / 2);
                levelLabel.userData = { kind: 'rack-level-label', rackData, level: rackLevel, label: levelLabel };
                levelLabelGroup.add(levelLabel);
                levelLabels.push(levelLabel);
                levelLabelTargets.push(levelLabel);
            }
            rackData.levelLabelGroup = levelLabelGroup;
            rackData.levelLabels = levelLabels;
            group.add(levelLabelGroup);
            const outlineSize = [length + 0.18, height + 0.18, rackWidth + 0.18];
            const outlinePosition = [length / 2, height / 2, rackWidth / 2];
            const rackHoverOutline = createRackOutline(outlineSize, outlinePosition, rackHoverMaterial);
            const rackSelectedOutline = createRackOutline(outlineSize, outlinePosition, rackSelectedMaterial);
            rackData.outlines = { hover: rackHoverOutline, selected: rackSelectedOutline };
            group.add(rackHoverOutline, rackSelectedOutline);
            const startX = mm(rack.startX);
            const startZ = mm(rack.startY);
            if (rack.layoutSource === 'drawing') {
                group.position.set(startX, warehouseFloorElevation, startZ);
                group.rotation.y = -rack.angle * Math.PI / 180;
            } else if (rack.direction === 'vertical') {
                group.position.set(startX + rackWidth, warehouseFloorElevation, startZ);
                group.rotation.y = -Math.PI / 2;
            } else group.position.set(startX, warehouseFloorElevation, startZ);
            scene.add(group);
            group.updateMatrixWorld(true);
            rackData.focusBounds = new THREE.Box3(
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(length, height, rackWidth)
            ).applyMatrix4(group.matrixWorld);
            const visualObjects = [];
            group.traverse((object) => {
                if (!object.material || object === pick) return;
                originalMaterialsByObject.set(object, object.material);
                visualObjects.push(object);
            });
            rackEntries.push({
                rack, type, group, stocks, slots, rackData, visualObjects, rackStructureObjects, dimmed: false, dimMode: 'none',
                searchText: `${rack.code} ${rack.zoneCode} ${zoneByCode.get(rack.zoneCode)?.name || ''} ${stocks.map((stock) => `${stock.itemCode} ${itemByCode.get(stock.itemCode)?.name || ''}`).join(' ')}`.toLowerCase()
            });
        });
        shell.viewport.dataset.rackPalletCount = String(rackPalletCount);
        shell.viewport.dataset.rackPalletHeight = String(unitLoadPalletHeight);
        shell.viewport.dataset.rackPalletSupportCount = String(rackPalletSupportCount);
        shell.viewport.dataset.rackLevelBillboardCount = String(levelLabelTargets.length);
        shell.viewport.dataset.rackLevelBillboardShape = 'circle';
        shell.viewport.dataset.rackLevelBillboardLabelFormat = 'L-number';
        shell.viewport.dataset.billboardRenderOrder = String(billboardRenderOrder);
        shell.viewport.dataset.billboardOcclusionMode = 'foreground-opaque';

        const shuttleLevelElevations = calculateShuttleLevelElevations(data.racks, data.rackTypes);
        const shuttleFrameLayout = buildShuttleFrameLayout(
            shuttlePassageCells,
            shuttleLevelElevations,
            data.meta?.floorPlanCellSize || 500
        );
        const shuttleFrameGroup = new THREE.Group();
        shuttleFrameGroup.name = 'WAREHOUSE-4WAY-SHUTTLE-FRAMES';
        shuttleFrameGroup.userData = { kind: 'shuttle-frames', source: 'floorPlan-GR', coverage: 'full-cell-area' };
        if (shuttleFrameLayout.tiles.length) {
            const decks = new THREE.InstancedMesh(shuttleDeckGeometry, shuttleDeckMaterial, shuttleFrameLayout.tiles.length);
            decks.name = 'WAREHOUSE-4WAY-SHUTTLE-DECKS';
            decks.userData = { kind: 'shuttle-frame-decks', source: 'floorPlan-GR' };
            const matrix = new THREE.Matrix4();
            const position = new THREE.Vector3();
            const rotation = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            const tileGap = Math.min(0.04, passageCellSize * 0.08);
            shuttleFrameLayout.tiles.forEach((tile, index) => {
                position.set(mm(tile.x), warehouseFloorElevation + mm(tile.levelY) + 0.04, mm(tile.y));
                scale.set(
                    Math.max(0.04, mm(tile.width) - tileGap),
                    0.055,
                    Math.max(0.04, mm(tile.depth) - tileGap)
                );
                matrix.compose(position, rotation, scale);
                decks.setMatrixAt(index, matrix);
            });
            decks.instanceMatrix.needsUpdate = true;
            decks.receiveShadow = true;
            shuttleFrameGroup.add(decks);
        }
        if (shuttleFrameLayout.boundaries.length) {
            const frameEdges = new THREE.InstancedMesh(
                shuttleFrameGeometry,
                shuttleFrameMaterial,
                shuttleFrameLayout.boundaries.length
            );
            frameEdges.name = 'WAREHOUSE-4WAY-SHUTTLE-FRAME-EDGES';
            frameEdges.userData = { kind: 'shuttle-frame-edges', source: 'floorPlan-GR' };
            const matrix = new THREE.Matrix4();
            const position = new THREE.Vector3();
            const rotation = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            shuttleFrameLayout.boundaries.forEach((segment, index) => {
                position.set(mm(segment.x), warehouseFloorElevation + mm(segment.levelY) + shuttleFrameCenterOffset, mm(segment.y));
                scale.set(mm(segment.width), shuttleFrameHeight, mm(segment.depth));
                matrix.compose(position, rotation, scale);
                frameEdges.setMatrixAt(index, matrix);
            });
            frameEdges.instanceMatrix.needsUpdate = true;
            frameEdges.castShadow = true;
            frameEdges.receiveShadow = true;
            shuttleFrameGroup.add(frameEdges);
        }
        shuttleFrameGroup.traverse((object) => {
            if (!object.material) return;
            originalMaterialsByObject.set(object, object.material);
            shuttleFrameVisualObjects.push(object);
        });
        const stationFrameConnectors = [];
        scene.add(shuttleFrameGroup);
        shell.viewport.dataset.shuttleFrameCoverage = 'full-GR-area';
        shell.viewport.dataset.shuttleFrameLevelCount = String(shuttleFrameLayout.levels.length);
        shell.viewport.dataset.shuttleFrameTileCount = String(shuttleFrameLayout.tiles.length);
        shell.viewport.dataset.shuttleFrameBoundaryCount = String(shuttleFrameLayout.boundaries.length);
        shell.viewport.dataset.shuttleFrameStationConnectorCount = String(stationFrameConnectors.length);
        shell.viewport.dataset.shuttleLiftFloorAlignment = 'moving-platform-inside-posts';

        const zoneColors = ['#38bdf8', '#a78bfa', '#f59e0b', '#22c55e', '#fb7185'];
        const zoneColorByCode = new Map(data.zones.map((zone, index) => [zone.code, zoneColors[index % zoneColors.length]]));
        calculateZoneFloorBounds(data.racks, data.rackTypes, 500).forEach((bounds) => {
            const entries = rackEntries.filter((entry) => entry.rack.zoneCode === bounds.zoneCode);
            const height = Math.max(0.4, ...entries.map((entry) => mm(entry.type.height))) + 0.4;
            const geometry = new THREE.BoxGeometry(mm(bounds.maxX - bounds.minX), height, mm(bounds.maxY - bounds.minY));
            const material = new THREE.MeshBasicMaterial({
                color: zoneColorByCode.get(bounds.zoneCode) || zoneColors[0],
                transparent: true,
                opacity: 0.08,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = `ZONE-${bounds.zoneCode}-VISUALIZATION`;
            mesh.position.set(mm((bounds.minX + bounds.maxX) / 2), warehouseFloorElevation + height / 2, mm((bounds.minY + bounds.maxY) / 2));
            mesh.visible = false;
            mesh.renderOrder = 7;
            mesh.userData = { kind: 'zone-visualization', zoneCode: bounds.zoneCode };
            scene.add(mesh);
            zoneVisualizationEntries.push({ zoneCode: bounds.zoneCode, mesh, geometry, material });
        });

        const shuttleNavigation = buildPassageNavigationGraph(
            shuttlePassageCells,
            data.meta?.floorPlanCellSize || 500,
            shuttlePathClearanceMm
        );
        const shuttleComponent = shuttleNavigation.components[0] || [];
        const shuttleLiftEntries = [];
        const shuttleFleet = [];
        const configuredShuttleEquipment = (data.equipment || []).filter((item) => {
            const code = String(item.code || '').trim();
            const type = String(item.type || '').trim().toUpperCase();
            return item.enabled && (type === '4WAY' || /^4SHUTTLE-/i.test(code));
        });
        const liftHeight = Math.max(2.8, ...rackEntries.map((entry) => mm(entry.type.height))) + 0.55;
        if (rackEntries.length && shuttleComponent.length && shuttleLevelElevations.length) {
            const usedLiftKeys = new Set();
            shuttleStationEntries.slice(0, 3).forEach((station) => {
                const node = findNearestPassageNode(
                    shuttleNavigation,
                    station.passageX,
                    station.passageY,
                    (data.meta?.floorPlanCellSize || 500) * 2
                );
                if (!node || usedLiftKeys.has(node.key)) return;
                usedLiftKeys.add(node.key);
                shuttleLiftEntries.push({
                    code: `L${String(shuttleLiftEntries.length + 1).padStart(2, '0')}`,
                    station,
                    stationCode: station.code,
                    node,
                    x: mm(station.centerX),
                    z: mm(station.centerY),
                    width: station.width,
                    depth: station.depth,
                    height: liftHeight,
                    levelStops: shuttleLevelElevations.map(mm)
                });
            });
        }
        const liftSteelMaterial = new THREE.MeshPhysicalMaterial({ color: '#2979FF', roughness: 0.28, metalness: 0.82 });
        const liftAccentMaterial = new THREE.MeshStandardMaterial({ color: '#f5b942', roughness: 0.42, metalness: 0.34 });
        const liftPostThickness = 0.09;
        const liftPostGeometry = new THREE.BoxGeometry(liftPostThickness, 1, liftPostThickness);
        const rackTopFrameElevation = Math.max(0, ...rackEntries.map((entry) => mm(entry.type.height)));
        const createLiftModel = (lift) => {
            const group = new THREE.Group();
            group.name = `WAREHOUSE-SHUTTLE-LIFT-${lift.code}`;
            group.userData = {
                kind: 'shuttle-lift',
                code: lift.code,
                stationCode: lift.stationCode,
                platformCount: 1,
                placement: 'station-centered',
                footprint: [lift.width, lift.depth],
                frameAlignment: 'post-inner-faces',
                floorAlignment: 'axis-aligned-inside-posts',
                levelStops: lift.levelStops.slice()
            };
            const frameDimensions = calculateLiftFrameDimensions(lift.width, lift.depth, liftPostThickness);
            const { halfPostX, halfPostZ, innerWidth, innerDepth } = frameDimensions;
            const liftBeamXGeometry = new THREE.BoxGeometry(innerWidth, shuttleFrameHeight, shuttleFrameHeight);
            const liftBeamZGeometry = new THREE.BoxGeometry(shuttleFrameHeight, shuttleFrameHeight, innerDepth);
            shuttleResources.push(liftBeamXGeometry, liftBeamZGeometry);
            [[-halfPostX, -halfPostZ], [halfPostX, -halfPostZ], [-halfPostX, halfPostZ], [halfPostX, halfPostZ]].forEach(([x, z]) => {
                const post = new THREE.Mesh(liftPostGeometry, liftSteelMaterial);
                post.scale.y = lift.height;
                post.position.set(x, lift.height / 2, z);
                post.castShadow = true;
                group.add(post);
                originalMaterialsByObject.set(post, post.material);
                shuttleFrameVisualObjects.push(post);
            });
            const horizontalFrameElevations = [
                ...lift.levelStops.map((levelY) => levelY + shuttleFrameCenterOffset),
                rackTopFrameElevation
            ].filter((levelY, index, values) => values.findIndex((candidate) => Math.abs(candidate - levelY) < 0.001) === index)
                .sort((left, right) => left - right);
            group.userData.horizontalFrameElevations = horizontalFrameElevations.slice();
            horizontalFrameElevations.forEach((y) => {
                [[0, -halfPostZ], [0, halfPostZ]].forEach(([x, z]) => {
                    const beam = new THREE.Mesh(liftBeamXGeometry, liftAccentMaterial);
                    beam.position.set(x, y, z);
                    group.add(beam);
                    originalMaterialsByObject.set(beam, beam.material);
                    shuttleFrameVisualObjects.push(beam);
                });
                [[-halfPostX, 0], [halfPostX, 0]].forEach(([x, z]) => {
                    const beam = new THREE.Mesh(liftBeamZGeometry, liftAccentMaterial);
                    beam.position.set(x, y, z);
                    group.add(beam);
                    originalMaterialsByObject.set(beam, beam.material);
                    shuttleFrameVisualObjects.push(beam);
                });
            });
            const platform = new THREE.Group();
            platform.name = 'shuttle-lift-platform-anchor';
            platform.position.y = 0.08;
            platform.rotation.set(0, 0, 0);
            platform.userData = { alignment: 'axis-aligned-inside-posts', visibleSurface: false };
            group.add(platform);
            group.position.set(lift.x, warehouseFloorElevation, lift.z);
            scene.add(group);
            lift.group = group;
            lift.platform = platform;
            return lift;
        };
        shuttleLiftEntries.forEach(createLiftModel);
        const shuttleBodyClearance = Math.min(0.1, shuttleFootprintMeters * 0.1);
        const shuttleBodySize = Math.max(0.25, shuttleFootprintMeters - shuttleBodyClearance);
        const shuttleBodyCenterY = shuttleFrameCenterOffset - shuttleTravelBaseOffset;
        const shuttleWheelRadius = Math.max(0.055, shuttleFootprintMeters * (0.11 / 1.5));
        const shuttleWheelWidth = Math.max(0.08, shuttleFootprintMeters * (0.14 / 1.5));
        const shuttleWheelOffset = shuttleFootprintMeters * (0.62 / 1.5);
        const shuttleBodyGeometry = new THREE.BoxGeometry(shuttleBodySize, shuttleFrameHeight, shuttleBodySize);
        const shuttleWheelGeometry = new THREE.CylinderGeometry(shuttleWheelRadius, shuttleWheelRadius, shuttleWheelWidth, 12);
        const shuttleBodyMaterial = new THREE.MeshPhysicalMaterial({ color: '#0b76b7', roughness: 0.32, metalness: 0.46, clearcoat: 0.68 });
        const shuttleWheelMaterial = new THREE.MeshStandardMaterial({ color: '#111827', roughness: 0.76, metalness: 0.12 });
        const transportCargoResources = [];
        let transportCartonMaterials;
        function createTransportCartonStack(width, height, depth) {
            if (!transportCartonMaterials) {
                const makeTexture = top => {
                    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
                    const context = canvas.getContext('2d');
                    context.fillStyle = '#c99b59'; context.fillRect(0, 0, 512, 512);
                    context.strokeStyle = '#a7793b18'; context.lineWidth = 1;
                    for (let i = 0; i < 512; i += 8) { context.beginPath(); context.moveTo(i, 0); context.lineTo(i, 512); context.moveTo(0, i); context.lineTo(512, i); context.stroke(); }
                    if (top) {
                        context.fillStyle = '#ddb87d'; context.fillRect(225, 0, 62, 512);
                        context.strokeStyle = '#8f6936'; context.beginPath(); context.moveTo(256, 0); context.lineTo(256, 512); context.stroke();
                    } else {
                        context.fillStyle = '#f4f0e7'; context.fillRect(36, 34, 192, 114);
                        context.fillStyle = '#28251f'; context.font = 'bold 23px sans-serif'; context.fillText('CARGO', 48, 61);
                        // Generic packaging marks: no brand, watermark or imitation of a registered barcode.
                        context.font = '14px sans-serif'; context.fillText('HANDLE WITH CARE', 48, 85);
                        for (let i = 0; i < 22; i++) context.fillRect(48 + i * 7, 99, i % 3 === 0 ? 4 : 2, 28);
                        context.strokeStyle = '#28251f'; context.lineWidth = 5;
                        [202, 300, 398].forEach(x => context.strokeRect(x, 365, 82, 82));
                        [225, 256].forEach(x => { context.beginPath(); context.moveTo(x, 430); context.lineTo(x, 381); context.moveTo(x - 9, 391); context.lineTo(x, 381); context.lineTo(x + 9, 391); context.stroke(); });
                        context.beginPath(); context.moveTo(318, 381); context.lineTo(363, 381); context.quadraticCurveTo(363, 412, 341, 412); context.quadraticCurveTo(318, 412, 318, 381); context.moveTo(341, 412); context.lineTo(341, 433); context.moveTo(328, 433); context.lineTo(354, 433); context.stroke();
                        context.beginPath(); context.arc(439, 407, 25, Math.PI, 0); context.lineTo(414, 407); context.moveTo(439, 407); context.lineTo(439, 430); context.quadraticCurveTo(439, 442, 428, 435); context.stroke();
                    }
                    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
                    transportCargoResources.push(texture); return texture;
                };
                transportCartonMaterials = {
                    body: new THREE.MeshStandardMaterial({ color: '#c99b59', roughness: 0.9, metalness: 0 }),
                    face: new THREE.MeshStandardMaterial({ map: makeTexture(false), roughness: 0.9, metalness: 0 }),
                    top: new THREE.MeshStandardMaterial({ map: makeTexture(true), roughness: 0.9, metalness: 0 })
                };
                transportCargoResources.push(...Object.values(transportCartonMaterials));
            }
            const layout = getCartonStackLayout(width, height, depth), [w, h, d] = layout.cartonSize;
            const stack = new THREE.Group(); stack.name = 'transport-carton-stack';
            stack.userData.cartonCount = layout.positions.length;
            const bodies = new THREE.InstancedMesh(getGeometry(w, h, d), transportCartonMaterials.body, 8);
            const faces = new THREE.InstancedMesh(getGeometry(1, 1, 0.001), transportCartonMaterials.face, 32);
            const tops = new THREE.InstancedMesh(getGeometry(1, 1, 0.001), transportCartonMaterials.top, 8);
            const transform = new THREE.Object3D(); let faceIndex = 0;
            layout.positions.forEach((p, index) => {
                transform.position.set(p.x, p.y, p.z); transform.rotation.set(0, 0, 0); transform.scale.set(1, 1, 1); transform.updateMatrix(); bodies.setMatrixAt(index, transform.matrix);
                [[p.x, p.z + d / 2 + 0.001, 0, w], [p.x, p.z - d / 2 - 0.001, Math.PI, w],
                    [p.x + w / 2 + 0.001, p.z, Math.PI / 2, d], [p.x - w / 2 - 0.001, p.z, -Math.PI / 2, d]].forEach(([x, z, yaw, faceWidth]) => {
                    transform.position.set(x, p.y, z); transform.rotation.set(0, yaw, 0); transform.scale.set(faceWidth, h, 1); transform.updateMatrix(); faces.setMatrixAt(faceIndex++, transform.matrix);
                });
                transform.position.set(p.x, p.y + h / 2 + 0.001, p.z); transform.rotation.set(-Math.PI / 2, 0, 0); transform.scale.set(w, d, 1); transform.updateMatrix(); tops.setMatrixAt(index, transform.matrix);
            });
            [bodies, faces, tops].forEach(mesh => { mesh.castShadow = true; mesh.receiveShadow = true; stack.add(mesh); });
            return stack;
        }
        const shuttleLoadMaterials = ['#f5c84b', '#71d48c', '#f06b6b'].map((color) =>
            new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0.08, clearcoat: 0.55 })
        );
        const createShuttleModel = (index, configuredEquipment, loadDimensions) => {
            const group = new THREE.Group();
            const equipmentCode = configuredEquipment?.code || `4SHUTTLE-${String(index + 1).padStart(3, '0')}`;
            group.name = `FOUR-WAY-SHUTTLE-${equipmentCode}`;
            group.userData = {
                kind: 'four-way-shuttle',
                code: equipmentCode,
                equipmentCode,
                footprint: [shuttleFootprintMeters, shuttleFootprintMeters]
            };
            const body = new THREE.Mesh(shuttleBodyGeometry, shuttleBodyMaterial);
            body.position.y = shuttleBodyCenterY;
            body.castShadow = true;
            group.add(body);
            [[-shuttleWheelOffset, -shuttleWheelOffset], [shuttleWheelOffset, -shuttleWheelOffset],
                [-shuttleWheelOffset, shuttleWheelOffset], [shuttleWheelOffset, shuttleWheelOffset]].forEach(([x, z]) => {
                const wheel = new THREE.Mesh(shuttleWheelGeometry, shuttleWheelMaterial);
                wheel.rotation.z = Math.PI / 2;
                wheel.position.set(x, shuttleBodyCenterY, z);
                group.add(wheel);
            });
            const composition = getUnitLoadComposition(
                loadDimensions.width,
                loadDimensions.height,
                loadDimensions.depth
            );
            const load = new THREE.Group();
            load.name = 'shuttle-carried-unit-load';
            load.userData = {
                sizingSource: loadDimensions.source,
                dimensions: [loadDimensions.width, loadDimensions.height, loadDimensions.depth],
                palletHeight: composition.palletHeight
            };
            const loadBaseY = shuttleBodyCenterY + shuttleFrameHeight / 2 + 0.01;
            const cargo = new THREE.Mesh(
                getChamferedBoxGeometry(loadDimensions.width, composition.cargoHeight, loadDimensions.depth),
                shuttleLoadMaterials[index % shuttleLoadMaterials.length]
            );
            cargo.name = 'shuttle-carried-load-box';
            cargo.visible = false;
            const cartons = createTransportCartonStack(loadDimensions.width, composition.cargoHeight, loadDimensions.depth);
            cartons.position.y = loadBaseY + composition.palletHeight;
            cargo.position.y = loadBaseY + composition.palletHeight + composition.cargoHeight / 2;
            cargo.castShadow = true;
            const pallet = new THREE.Group();
            pallet.name = 'shuttle-carried-pallet';
            const palletMaterial = getMaterial(unitLoadPalletColor, {
                roughness: 0.72,
                metalness: 0.06,
                clearcoat: 0.12,
                clearcoatRoughness: 0.7
            });
            const palletDeck = new THREE.Mesh(
                getGeometry(composition.palletWidth, composition.deckHeight, composition.palletDepth),
                palletMaterial
            );
            palletDeck.position.y = loadBaseY + composition.runnerHeight + composition.deckHeight / 2;
            pallet.add(palletDeck);
            const supportLayout = getFourWayPalletSupportLayout(composition);
            supportLayout.positions.forEach(({ x, z }) => {
                const support = new THREE.Mesh(
                    getGeometry(supportLayout.supportWidth, composition.runnerHeight, supportLayout.supportDepth),
                    palletMaterial
                );
                support.name = 'shuttle-pallet-four-way-support';
                support.position.set(x, loadBaseY + composition.runnerHeight / 2, z);
                pallet.add(support);
            });
            pallet.traverse((part) => {
                if (!part.isMesh) return;
                part.castShadow = true;
                part.receiveShadow = true;
            });
            load.add(cargo, pallet, cartons);
            group.add(load);
            return { group, load, cargo, pallet, loadDimensions, loadComposition: composition };
        };
        const getPathMetrics = (path) => {
            const cumulativeDistances = [0];
            for (let pointIndex = 1; pointIndex < path.length; pointIndex += 1) {
                cumulativeDistances.push(cumulativeDistances[pointIndex - 1] + Math.hypot(
                    path[pointIndex].x - path[pointIndex - 1].x,
                    path[pointIndex].z - path[pointIndex - 1].z
                ));
            }
            return { path, cumulativeDistances, length: cumulativeDistances[cumulativeDistances.length - 1] || 0.001 };
        };
        const fallbackShuttleEquipment = data.meta?.equipmentLoadWarning
            ? shuttleLiftEntries.map((lift, index) => ({
                code: `4SHUTTLE-${String(index + 1).padStart(3, '0')}`,
                name: `SHUTTLE-${String(index + 1).padStart(3, '0')}`,
                type: '4WAY', enabled: true, configuredSpeed: 0.5, lift
            }))
            : [];
        const shuttleEquipment = configuredShuttleEquipment.length
            ? configuredShuttleEquipment : fallbackShuttleEquipment;
        const getNearestRackSlots = (targetNode) => {
            if (!targetNode || !rackEntries.length) return [];
            const targetX = mm(targetNode.x);
            const targetZ = mm(targetNode.y);
            let nearestEntry = null;
            let nearestDistance = Infinity;
            rackEntries.forEach((entry) => {
                const center = entry.rackData.focusBounds.getCenter(new THREE.Vector3());
                const distance = Math.hypot(center.x - targetX, center.z - targetZ);
                if (distance < nearestDistance) {
                    nearestEntry = entry;
                    nearestDistance = distance;
                }
            });
            return nearestEntry?.slots || [];
        };
        shuttleEquipment.forEach((configuredEquipment, index) => {
            const lift = shuttleLiftEntries[index % Math.max(1, shuttleLiftEntries.length)];
            if (!lift) return;
            const station = lift.station;
            if (!station) return;
            const componentKeys = shuttleNavigation.components.find((component) => component.includes(lift.node.key)) || shuttleComponent;
            const targetCandidates = componentKeys
                .map((key) => shuttleNavigation.nodesByKey.get(key))
                .filter(Boolean)
                .sort((left, right) => (
                    Math.hypot(right.x - lift.node.x, right.y - lift.node.y)
                    - Math.hypot(left.x - lift.node.x, left.y - lift.node.y)
                ));
            const targetIndex = Math.min(
                targetCandidates.length - 1,
                Math.floor(index * targetCandidates.length / Math.max(1, shuttleEquipment.length))
            );
            const targetNode = targetCandidates[Math.max(0, targetIndex)] || lift.node;
            const rackGraphPath = simplifyPath(findPassagePath(shuttleNavigation, lift.node.key, targetNode.key));
            if (!rackGraphPath.length) return;
            const stationPath = getPathMetrics([
                { x: mm(station.centerX), z: mm(station.centerY) },
                { x: lift.x, z: lift.z }
            ]);
            const rackGraphPoints = rackGraphPath.map((node) => ({ x: mm(node.x), z: mm(node.y) }));
            const liftConnectorPath = buildOrthogonalConnectorPath(
                { x: lift.x, z: lift.z },
                rackGraphPoints[0]
            );
            const rackPath = getPathMetrics([
                ...liftConnectorPath,
                ...rackGraphPoints.slice(1)
            ].filter((point, pointIndex, points) => pointIndex === 0
                || Math.hypot(point.x - points[pointIndex - 1].x, point.z - points[pointIndex - 1].z) > 0.01));
            const elevatedStops = lift.levelStops.filter((level) => level > 0.01);
            const targetLevel = elevatedStops.length ? elevatedStops[index % elevatedStops.length] : 0;
            const loadDimensions = calculateShuttleLoadDimensions(
                getNearestRackSlots(targetNode),
                data.meta?.floorPlanCellSize || 500
            );
            const model = createShuttleModel(index, configuredEquipment, loadDimensions);
            model.group.position.set(stationPath.path[0].x, warehouseFloorElevation + shuttleTravelBaseOffset, stationPath.path[0].z);
            scene.add(model.group);
            const equipmentStatus = equipmentStatusByCode.get(configuredEquipment.code) || {};
            const shuttle = {
                ...model,
                ...equipmentStatus,
                index,
                equipmentCode: configuredEquipment.code,
                equipmentName: configuredEquipment.name || configuredEquipment.code,
                equipmentType: configuredEquipment.type || '4WAY',
                modelName: configuredEquipment.modelName || '',
                configuredSpeed: configuredEquipment.configuredSpeed,
                communicationStatus: equipmentStatus.communicationStatus || 'OFFLINE',
                equipmentStatus: equipmentStatus.equipmentStatus || '미설정',
                kindLabel: '4 WAY SHUTTLE',
                station, lift, stationPath, rackPath, targetLevel,
                state: 'station-handoff'
            };
            shuttle.label = createAmrLabelSprite(THREE, {
                name: shuttle.equipmentName,
                communicationStatus: shuttle.communicationStatus,
                equipmentStatus: shuttle.equipmentStatus
            });
            shuttle.label.name = `${shuttle.equipmentName}-status-billboard`;
            shuttle.label.position.set(
                0,
                shuttleBodyCenterY + shuttleFrameHeight / 2 + loadDimensions.height + 0.72,
                0
            );
            shuttle.label.userData = {
                ...shuttle.label.userData,
                kind: 'amr-label',
                amr: shuttle,
                equipmentKind: 'shuttle'
            };
            shuttle.group.add(shuttle.label);
            amrLabelTargets.push(shuttle.label);
            shuttleFleet.push(shuttle);
        });
        shuttleResources.push(
            liftSteelMaterial, liftAccentMaterial,
            liftPostGeometry,
            shuttleBodyGeometry, shuttleWheelGeometry,
            shuttleBodyMaterial, shuttleWheelMaterial, ...shuttleLoadMaterials
        );
        shell.viewport.dataset.shuttleLiftCount = String(shuttleLiftEntries.length);
        shell.viewport.dataset.shuttleLiftPlatformCount = String(shuttleLiftEntries.filter((lift) => lift.platform).length);
        shell.viewport.dataset.shuttleLiftVisiblePlatformCount = '0';
        shell.viewport.dataset.shuttleLiftStationCodes = shuttleLiftEntries.map((lift) => lift.stationCode).join(',');
        shell.viewport.dataset.shuttleVehicleCount = String(shuttleFleet.length);
        shell.viewport.dataset.shuttleEquipmentCodes = shuttleFleet.map((shuttle) => shuttle.equipmentCode).join(',');
        shell.viewport.dataset.shuttleStatusBillboardCount = String(shuttleFleet.filter((shuttle) => shuttle.label).length);
        shell.viewport.dataset.shuttleStatusBillboardCodes = shuttleFleet
            .filter((shuttle) => shuttle.label)
            .map((shuttle) => shuttle.equipmentCode)
            .join(',');
        shell.viewport.dataset.shuttleEquipmentSource = configuredShuttleEquipment.length ? 'equipment-master' : 'fallback';
        shell.viewport.dataset.shuttleEquipmentStatuses = shuttleFleet
            .map((shuttle) => `${shuttle.equipmentCode}:${shuttle.communicationStatus}:${shuttle.equipmentStatus}`)
            .join(',');
        shell.viewport.dataset.shuttleVehicleFootprint = `${shuttleFootprintMeters}x${shuttleFootprintMeters}`;
        shell.viewport.dataset.shuttleBodySize = `${shuttleBodySize}x${shuttleFrameHeight}x${shuttleBodySize}`;
        shell.viewport.dataset.shuttleLoadSize = shuttleFleet.length
            ? `${shuttleFleet[0].loadDimensions.width}x${shuttleFleet[0].loadDimensions.height}x${shuttleFleet[0].loadDimensions.depth}`
            : '';
        shell.viewport.dataset.shuttleLoadSizes = shuttleFleet
            .map((shuttle) => `${shuttle.equipmentCode}:${shuttle.loadDimensions.width}x${shuttle.loadDimensions.height}x${shuttle.loadDimensions.depth}`)
            .join(',');
        shell.viewport.dataset.shuttleLoadSizingSource = shuttleFleet.every((shuttle) => shuttle.loadDimensions.source === 'rack-slot')
            ? 'rack-slot' : 'floorPlan-cell-fallback';
        shell.viewport.dataset.shuttlePalletCount = String(shuttleFleet.filter((shuttle) => shuttle.pallet).length);
        shell.viewport.dataset.shuttlePalletHeight = String(unitLoadPalletHeight);
        shell.viewport.dataset.palletForkEntryDirections = '4';
        shell.viewport.dataset.palletSupportLayout = '3x3';
        shell.viewport.dataset.shuttlePalletSupportCount = String(shuttleFleet.length * 9);
        shell.viewport.dataset.floorPlanCellSize = String(passageCellSize);
        shell.viewport.dataset.shuttleFrameHeight = String(shuttleFrameHeight);
        shell.viewport.dataset.shuttleBodyPlacement = 'inside-frame';
        shell.viewport.dataset.shuttleTopPlate = 'false';
        shell.viewport.dataset.shuttlePathClearance = String(shuttlePathClearanceMm);
        shell.viewport.dataset.shuttleSizingSource = 'floorPlan-S';
        shell.viewport.dataset.shuttleLiftPlacement = 'station-centered';
        shell.viewport.dataset.shuttleLiftFrameAlignment = 'post-inner-faces';
        shell.viewport.dataset.shuttleLiftHorizontalFrameAlignment = 'shuttle-level-center-and-rack-top';
        shell.viewport.dataset.shuttleLiftHorizontalFrameHeight = String(shuttleFrameHeight);
        shell.viewport.dataset.shuttleLiftHorizontalFrameOffset = String(shuttleFrameCenterOffset);
        shell.viewport.dataset.shuttleLiftHorizontalFrameElevations = shuttleLiftEntries
            .map((lift) => `${lift.code}:${lift.group?.userData?.horizontalFrameElevations?.map((value) => value.toFixed(3)).join(',') || ''}`)
            .join(';');
        shell.viewport.dataset.shuttleLiftFootprints = shuttleLiftEntries
            .map((lift) => `${lift.stationCode}:${lift.width.toFixed(2)}x${lift.depth.toFixed(2)}`)
            .join(',');
        shell.viewport.dataset.shuttleFlow = shuttleFleet.length ? 'amr-station-shuttle-rack-bidirectional' : 'unavailable';
        renderer.domElement.setAttribute('aria-label', `기준정보 기반 3D 창고, 무인 지게차 ${amrFleet.length}대, 4 WAY SHUTTLE ${shuttleFleet.length}대 운행 중`);

        const forkliftTaskTargets = [];
        const reservedTaskKeys = new Set();
        const reservedDockKeys = new Set();
        const hiddenInstanceMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
        const getDockTarget = (slot) => {
            const slotWorld = new THREE.Vector3(...slot.position);
            slot.group.localToWorld(slotWorld);
            const preferredSide = slot.depth <= Math.ceil(slot.depthCount / 2) ? 'front' : 'back';
            const sides = preferredSide === 'front' ? ['front', 'back'] : ['back', 'front'];
            for (const side of sides) {
                const faceLocalZ = side === 'front' ? 0 : slot.rackWidth;
                const faceWorld = new THREE.Vector3(slot.position[0], 0, faceLocalZ);
                slot.group.localToWorld(faceWorld);
                const outward = faceWorld.clone().sub(slotWorld);
                outward.y = 0;
                if (outward.lengthSq() < 0.0001) continue;
                outward.normalize();
                const desiredDock = faceWorld.clone().addScaledVector(outward, 1.15);
                const dockNode = findNearestPassageNode(
                    passageNavigation,
                    desiredDock.x * 1000,
                    desiredDock.z * 1000,
                    1250
                );
                if (!dockNode || !amrNavigableKeys.has(dockNode.key)) continue;
                const dockWorld = new THREE.Vector3(mm(dockNode.x), warehouseFloorElevation, mm(dockNode.y));
                const toSlot = slotWorld.clone().sub(dockWorld);
                toSlot.y = 0;
                const distanceToSlot = toSlot.length();
                const clearanceToFace = dockWorld.clone().sub(faceWorld).dot(outward);
                const forkExtension = distanceToSlot - (stackerDimensions.mastZ + stackerDimensions.forkCenterZ);
                // The chassis/low support legs stay in the aisle; only the lifting forks reach into the cell.
                if (clearanceToFace < stackerDimensions.frontReach + stackerDimensions.rackClearance
                    || forkExtension < 0 || forkExtension > stackerDimensions.maxExtension) continue;
                return {
                    key: slot.locationCode,
                    slot,
                    dockNode,
                    slotWorld,
                    facingYaw: Math.atan2(toSlot.x, toSlot.z),
                    forkHeight: getForkTargetHeight(slot, forkThickness),
                    forkExtension,
                    side
                };
            }
            return null;
        };
        rackEntries.forEach((entry) => {
            entry.slots.forEach((slot) => {
                const target = getDockTarget(slot);
                if (target) forkliftTaskTargets.push(target);
            });
        });
        const shuttleLoadDimensionsByStation = new Map();
        shuttleFleet.forEach((shuttle) => {
            if (!shuttleLoadDimensionsByStation.has(shuttle.station.code)) {
                shuttleLoadDimensionsByStation.set(shuttle.station.code, shuttle.loadDimensions);
            }
        });
        const stationAmrTaskTargets = shuttleStationEntries.map((station) => {
            const dockNode = findNearestPassageNode(
                passageNavigation,
                station.passageX,
                station.passageY,
                3500
            );
            if (!dockNode) return null;
            const dockWorld = new THREE.Vector3(mm(dockNode.x), warehouseFloorElevation, mm(dockNode.y));
            const stationWorld = new THREE.Vector3(mm(station.centerX), warehouseFloorElevation, mm(station.centerY));
            const toStation = stationWorld.clone().sub(dockWorld);
            toStation.y = 0;
            const distance = toStation.length();
            if (distance < 0.05) toStation.set(0, 0, 1);
            const forkExtension = Math.max(0, Math.min(
                stackerDimensions.maxExtension,
                distance - (stackerDimensions.mastZ + stackerDimensions.forkCenterZ)
            ));
            const handoffDimensions = shuttleLoadDimensionsByStation.get(station.code)
                || calculateShuttleLoadDimensions([], data.meta?.floorPlanCellSize || 500);
            const handoffComposition = getUnitLoadComposition(
                handoffDimensions.width,
                handoffDimensions.height,
                handoffDimensions.depth
            );
            return {
                key: `station-${station.code}`,
                station,
                dockNode,
                facingYaw: Math.atan2(toStation.x, toStation.z),
                forkHeight: travelForkHeight,
                forkExtension,
                slot: {
                    locationCode: station.code,
                    group: station.group,
                    position: [0, 0.02 + handoffDimensions.height / 2, 0],
                    boxSize: [handoffDimensions.width, handoffDimensions.height, handoffDimensions.depth],
                    cargoBoxSize: [handoffDimensions.width, handoffComposition.cargoHeight, handoffDimensions.depth],
                    palletSize: [handoffComposition.palletWidth, handoffComposition.palletHeight, handoffComposition.palletDepth],
                    unitLoadSource: 'shuttle-handoff',
                    occupied: false,
                    item: null
                }
            };
        }).filter(Boolean);
        const applySlotInstanceVisibility = (slot) => {
            const visibleForLevel = !activeRackLevelFocus
                || (slot?.rack === activeRackLevelFocus.rackData.rack && slot?.level === activeRackLevelFocus.level);
            const visible = slot?.taskVisible !== false && visibleForLevel;
            if (slot?.instanceMesh && Number.isInteger(slot.instanceIndex)) {
                slot.instanceMesh.setMatrixAt(slot.instanceIndex, visible ? slot.instanceMatrix : hiddenInstanceMatrix);
                slot.instanceMesh.instanceMatrix.needsUpdate = true;
            }
            (slot?.palletInstances || []).forEach((instance) => {
                instance.mesh.setMatrixAt(instance.index, visible ? instance.matrix : hiddenInstanceMatrix);
                instance.mesh.instanceMatrix.needsUpdate = true;
            });
        };
        const setSlotInstanceVisible = (slot, visible) => {
            if (!slot) return;
            slot.taskVisible = Boolean(visible);
            applySlotInstanceVisibility(slot);
        };
        const createTaskLoad = (amr, target) => {
            const size = target.slot.boxSize.slice();
            const color = target.slot.item?.color || (target.slot.occupied ? '#f59e0b' : '#38bdf8');
            const composition = getUnitLoadComposition(size[0], size[1], size[2]);
            const load = new THREE.Group();
            load.name = 'forklift-carried-load';
            load.userData = {
                loadSize: size,
                cargoSize: [size[0], composition.cargoHeight, size[2]],
                palletSize: [composition.palletWidth, composition.palletHeight, composition.palletDepth],
                sizingSource: target.slot.unitLoadSource || 'rack-slot'
            };
            const cargo = new THREE.Mesh(
                getChamferedBoxGeometry(size[0], composition.cargoHeight, size[2]),
                getMaterial(color, { roughness: 0.2, metalness: 0.12, clearcoat: 0.86, clearcoatRoughness: 0.08 })
            );
            cargo.name = 'forklift-carried-load-box';
            cargo.visible = false;
            const cartons = createTransportCartonStack(size[0], composition.cargoHeight, size[2]);
            cartons.position.y = composition.palletHeight;
            cargo.position.y = composition.palletHeight + composition.cargoHeight / 2;
            cargo.castShadow = true;
            cargo.receiveShadow = true;
            const pallet = new THREE.Group();
            pallet.name = 'forklift-carried-pallet';
            const palletMaterial = getMaterial(unitLoadPalletColor, {
                roughness: 0.72, metalness: 0.06, clearcoat: 0.12, clearcoatRoughness: 0.7
            });
            const palletDeck = new THREE.Mesh(
                getGeometry(composition.palletWidth, composition.deckHeight, composition.palletDepth),
                palletMaterial
            );
            palletDeck.position.y = composition.runnerHeight + composition.deckHeight / 2;
            pallet.add(palletDeck);
            const supportLayout = getFourWayPalletSupportLayout(composition);
            supportLayout.positions.forEach(({ x, z }) => {
                const support = new THREE.Mesh(
                    getGeometry(supportLayout.supportWidth, composition.runnerHeight, supportLayout.supportDepth),
                    palletMaterial
                );
                support.name = 'forklift-pallet-four-way-support';
                support.position.set(x, composition.runnerHeight / 2, z);
                pallet.add(support);
            });
            pallet.traverse((part) => {
                if (!part.isMesh) return;
                part.castShadow = true;
                part.receiveShadow = true;
            });
            load.add(cargo, pallet, cartons);
            load.userData.cargoAppearance = 'kraft-carton-stack';
            load.setStorageState = (stored, rackColor) => setUnitLoadStoredAppearance(load, stored, rackColor);
            load.position.set(0, 0.035, 0);
            amr.loadAnchor.add(load);
            amr.carriedLoad = load;
            return load;
        };
        const clearTaskVisuals = (amr) => {
            if (amr.task?.slotHidden) setSlotInstanceVisible(amr.task.target.slot, true);
            if (amr.carriedLoad) {
                amr.carriedLoad.removeFromParent();
                amr.carriedLoad = null;
            }
            if (amr.placedLoad) {
                amr.placedLoad.removeFromParent();
                amr.placedLoad = null;
            }
            if (amr.task) {
                reservedTaskKeys.delete(amr.task.target.key);
                reservedDockKeys.delete(amr.task.target.dockNode.key);
            }
        };
        const setForkliftState = (amr, state, timestamp) => {
            amr.state = state;
            amr.stateStartedAt = timestamp;
            amr.group.userData.operationState = state;
        };
        const assignForkliftTask = (amr, timestamp = performance.now()) => {
            clearTaskVisuals(amr);
            const preferredMode = (amr.index + amr.completedTasks) % 2 ? 'putaway' : 'picking';
            const assignedStationTargets = stationAmrTaskTargets.filter((target) => (
                target.station.code === amr.corridorCode
                && amr.corridorKeys.includes(target.dockNode.key)
            ));
            const assignedRackTargets = forkliftTaskTargets.filter((target) => amr.corridorKeys.includes(target.dockNode.key));
            const assignedTargets = assignedStationTargets.length ? assignedStationTargets : assignedRackTargets;
            const taskTargets = assignedTargets.length
                ? assignedTargets.map((target, index) => ({
                    ...target,
                    slot: { ...target.slot, occupied: (amr.completedTasks + index) % 2 === 0 }
                }))
                : forkliftTaskTargets;
            const available = taskTargets.filter((target) => (
                !reservedTaskKeys.has(target.key)
                && !reservedDockKeys.has(target.dockNode.key)
                && (preferredMode === 'picking' ? target.slot.occupied : !target.slot.occupied)
            ));
            const fallback = available.length ? available : taskTargets.filter((target) => (
                !reservedTaskKeys.has(target.key) && !reservedDockKeys.has(target.dockNode.key)
            ));
            if (!fallback.length) {
                amr.task = null;
                planAmrRoute(amr, timestamp);
                setForkliftState(amr, 'driving', timestamp);
                return;
            }
            let selected = null;
            let selectedPath = [];
            for (let attempt = 0; attempt < Math.min(24, fallback.length * 2); attempt += 1) {
                const candidate = fallback[Math.floor(Math.random() * fallback.length)];
                const path = findPassagePath(passageNavigation, amr.currentKey, candidate.dockNode.key);
                if (path.length > selectedPath.length) {
                    selected = candidate;
                    selectedPath = path;
                }
            }
            if (!selected || !selectedPath.length) {
                amr.task = null;
                planAmrRoute(amr, timestamp);
                setForkliftState(amr, 'driving', timestamp);
                return;
            }
            if (selected.dockNode.key === amr.currentKey && amr.corridorFarKey !== amr.currentKey) {
                const patrolPath = simplifyPath(findPassagePath(
                    passageNavigation,
                    amr.currentKey,
                    amr.corridorFarKey
                ));
                if (patrolPath.length > 1) {
                    amr.task = null;
                    amr.route = patrolPath;
                    amr.waypointIndex = 1;
                    amr.waitUntil = timestamp;
                    setForkliftState(amr, 'driving', timestamp);
                    return;
                }
            }
            const mode = selected.slot.occupied ? 'picking' : 'putaway';
            reservedTaskKeys.add(selected.key);
            reservedDockKeys.add(selected.dockNode.key);
            amr.task = {
                mode,
                target: selected,
                phases: getForkliftTaskSequence(mode),
                handled: false,
                slotHidden: false
            };
            if (mode === 'putaway') createTaskLoad(amr, selected);
            amr.route = simplifyPath(selectedPath);
            amr.waypointIndex = Math.min(1, amr.route.length - 1);
            amr.waitUntil = timestamp;
            setForkliftState(amr, 'driving', timestamp);
        };
        if (!Array.isArray(data.operationRoutes)) amrFleet.forEach((amr, index) => assignForkliftTask(amr, performance.now() + index * 420));

        let yaw = Math.PI / 4;
        let pitch = Math.PI / 6;
        let distance = sceneSpan * 1.08;
        const cameraCenterX = floorWidth / 2 + (loadingDockLayout?.outwardX || 0) * 1.8;
        const cameraCenterZ = floorDepth / 2 + (loadingDockLayout?.outwardZ || 0) * 1.8;
        const target = new THREE.Vector3(cameraCenterX, warehouseFloorElevation + 2.5, cameraCenterZ);
        const perspectiveHalfFov = perspectiveCamera.fov * Math.PI / 360;
        const minimumCameraDistance = 8;
        const maximumCameraDistance = 140;
        let projectionMode = 'perspective';
        let viewportAspect = 1;
        let cameraFocusTransitionToken = 0;
        let followedAmr = null;
        let hoveredAmr = null;
        let amrFocusTransition = null;
        const getPerspectiveViewHeight = (cameraDistance = distance) => 2 * cameraDistance * Math.tan(perspectiveHalfFov);
        const getEquivalentCameraDistance = () => projectionMode === 'orthographic'
            ? orthographicViewHeight / (2 * Math.tan(perspectiveHalfFov))
            : distance;
        let orthographicViewHeight = getPerspectiveViewHeight();
        let animationFrame = 0;
        let destroyed = false;
        let lastAmrFrameTime = 0;
        const activeWorldUiTransitions = new Set();
        const easeOutCubic = (progress) => 1 - ((1 - progress) ** 3);
        const updateWorldUiTransitions = (timestamp) => {
            activeWorldUiTransitions.forEach((transition) => {
                const progress = Math.min(1, Math.max(0, (timestamp - transition.startedAt) / transition.duration));
                const keep = transition.update(easeOutCubic(progress));
                if (progress >= 1 || keep === false) {
                    activeWorldUiTransitions.delete(transition);
                    transition.complete?.();
                }
            });
        };

        const updateCamera = () => {
            const horizontal = distance * Math.cos(pitch);
            camera.position.set(target.x + horizontal * Math.sin(yaw), target.y + distance * Math.sin(pitch), target.z + horizontal * Math.cos(yaw));
            camera.lookAt(target);
            updateWarehouseStructureVisibility();
        };
        const updateProjectionMatrices = () => {
            perspectiveCamera.aspect = viewportAspect;
            perspectiveCamera.updateProjectionMatrix();
            const halfHeight = orthographicViewHeight / 2;
            const halfWidth = halfHeight * viewportAspect;
            orthographicCamera.left = -halfWidth;
            orthographicCamera.right = halfWidth;
            orthographicCamera.top = halfHeight;
            orthographicCamera.bottom = -halfHeight;
            orthographicCamera.updateProjectionMatrix();
        };
        const updateProjectionToggle = () => {
            const isOrthographic = projectionMode === 'orthographic';
            const currentLabel = isOrthographic ? 'Orthographic' : 'Perspective';
            const nextLabel = isOrthographic ? 'Perspective' : 'Orthographic';
            shell.projectionToggle.dataset.projection = projectionMode;
            shell.projectionToggle.setAttribute('aria-pressed', String(isOrthographic));
            shell.projectionToggle.setAttribute('aria-label', `현재 ${currentLabel}. ${nextLabel}으로 전환`);
            shell.projectionToggle.title = `${nextLabel}으로 전환`;
        };
        const moveToward = (current, goal, maximumChange) => {
            if (Math.abs(goal - current) <= maximumChange) return goal;
            return current + Math.sign(goal - current) * maximumChange;
        };
        const rotateForkliftToward = (amr, goal, deltaSeconds, speed = 2.4) => {
            const offset = Math.atan2(
                Math.sin(goal - amr.group.rotation.y),
                Math.cos(goal - amr.group.rotation.y)
            );
            amr.group.rotation.y += Math.max(-deltaSeconds * speed, Math.min(deltaSeconds * speed, offset));
            return Math.abs(offset) < 0.025;
        };
        const setForkHeight = (amr, height) => {
            // A first-level cell may sit below travel height; keep only a physical floor clearance here.
            amr.forkHeight = Math.max(forkThickness / 2 + 0.01, height);
            amr.carriage.position.y = amr.forkHeight / amrVisualScale;
            const extensionHeight = Math.max(0, amr.forkHeight - 1.35);
            amr.mastMiddle.position.y = Math.min(2.2, extensionHeight * 0.48);
            amr.mastUpper.position.y = Math.min(3.8, extensionHeight * 0.82);
            amr.group.userData.forkHeight = amr.forkHeight;
        };
        const setForkExtension = (amr, extension) => {
            amr.forkExtension = Math.max(0, extension);
            amr.forkAssembly.position.z = amr.forkExtension / amrVisualScale;
            amr.reachRails.forEach(rail => {
                rail.scale.z = amr.forkExtension + 0.12;
                rail.position.z = 0.06 + amr.forkExtension / 2;
            });
            amr.group.userData.forkExtension = amr.forkExtension;
        };
        const handleForkliftLoad = (amr) => {
            if (!amr.task || amr.task.handled) return;
            const target = amr.task.target;
            if (amr.task.mode === 'picking') {
                setSlotInstanceVisible(target.slot, false);
                amr.task.slotHidden = true;
                createTaskLoad(amr, target);
            } else {
                const loadSize = amr.carriedLoad?.userData?.loadSize || [0.8, 0.6, 0.7];
                if (amr.carriedLoad) {
                    amr.carriedLoad.removeFromParent();
                    amr.carriedLoad = null;
                }
                const placedLoad = createTaskLoad(amr, target);
                placedLoad.name = 'forklift-placed-load';
                placedLoad.setStorageState(Boolean(target.slot.rack), slotColorPalette[getSlotVisualKey(target.slot, 'utilization')]);
                placedLoad.removeFromParent();
                amr.carriedLoad = null;
                placedLoad.position.set(
                    target.slot.position[0],
                    target.slot.position[1] - loadSize[1] / 2,
                    target.slot.position[2]
                );
                target.slot.group.add(placedLoad);
                amr.placedLoad = placedLoad;
            }
            amr.task.handled = true;
        };
        shell.viewport.dataset.amrHandoffLoadSizes = stationAmrTaskTargets
            .map((target) => `${target.station.code}:${target.slot.boxSize.join('x')}`)
            .join(',');
        shell.viewport.dataset.amrCarriedLoadIncludesPallet = 'true';
        shell.viewport.dataset.amrCargoScalePolicy = 'preserve-shuttle-unit-load';
        const updateDrivingForklift = (amr, timestamp, deltaSeconds) => {
            setForkHeight(amr, moveToward(amr.forkHeight, travelForkHeight, deltaSeconds * 1.2));
            setForkExtension(amr, moveToward(amr.forkExtension, 0, deltaSeconds * 0.9));
            if (timestamp < amr.waitUntil) return;
            if (amr.waypointIndex >= amr.route.length) {
                if (amr.task) setForkliftState(amr, 'aligning', timestamp);
                else assignForkliftTask(amr, timestamp + 600 + Math.random() * 700);
                return;
            }
            const waypoint = amr.route[amr.waypointIndex];
            const targetX = mm(waypoint.x);
            const targetZ = mm(waypoint.y);
            const offsetX = targetX - amr.group.position.x;
            const offsetZ = targetZ - amr.group.position.z;
            const remaining = Math.hypot(offsetX, offsetZ);
            if (remaining < 0.0001) {
                amr.group.position.set(targetX, warehouseFloorElevation, targetZ);
                amr.currentKey = waypoint.key;
                amr.waypointIndex += 1;
                return;
            }
            const desiredRotation = Math.atan2(offsetX, offsetZ);
            const aligned = rotateForkliftToward(amr, desiredRotation, deltaSeconds, 3.2);
            if (!aligned) return;
            const movement = Math.min(remaining, amr.speed * deltaSeconds);
            amr.group.position.x += offsetX / remaining * movement;
            amr.group.position.z += offsetZ / remaining * movement;
            if (movement >= remaining) {
                amr.currentKey = waypoint.key;
                amr.waypointIndex += 1;
            }
        };
        const placeShuttleAtDistance = (shuttle, pathMetrics, distanceAlongPath) => {
            const distance = Math.max(0, Math.min(pathMetrics.length, distanceAlongPath));
            let segmentIndex = 1;
            while (segmentIndex < pathMetrics.cumulativeDistances.length
                && pathMetrics.cumulativeDistances[segmentIndex] < distance) segmentIndex += 1;
            segmentIndex = Math.min(segmentIndex, pathMetrics.path.length - 1);
            const start = pathMetrics.path[Math.max(0, segmentIndex - 1)];
            const end = pathMetrics.path[segmentIndex] || start;
            const segmentStart = pathMetrics.cumulativeDistances[Math.max(0, segmentIndex - 1)] || 0;
            const segmentLength = Math.max(
                0.0001,
                (pathMetrics.cumulativeDistances[segmentIndex] || segmentStart) - segmentStart
            );
            const progress = Math.max(0, Math.min(1, (distance - segmentStart) / segmentLength));
            shuttle.group.position.x = start.x + (end.x - start.x) * progress;
            shuttle.group.position.z = start.z + (end.z - start.z) * progress;
            const dx = end.x - start.x;
            const dz = end.z - start.z;
            if (Math.hypot(dx, dz) > 0.001) shuttle.group.rotation.y = Math.atan2(dx, dz);
        };
        const updateShuttleFleet = (timestamp) => {
            if (!shuttleFleet.length) return false;
            const cycleDuration = 24000;
            shuttleFleet.forEach((shuttle) => {
                const cycle = ((timestamp + shuttle.index * 4300) % cycleDuration) / cycleDuration;
                const floorY = warehouseFloorElevation + shuttleTravelBaseOffset;
                const rackLevelY = floorY + shuttle.targetLevel;
                shuttle.group.position.y = floorY;
                if (cycle < 0.1) {
                    shuttle.lift.platform.position.y = 0.08;
                    placeShuttleAtDistance(shuttle, shuttle.stationPath, 0);
                    shuttle.load.visible = true;
                    shuttle.state = 'station-handoff';
                } else if (cycle < 0.2) {
                    shuttle.lift.platform.position.y = 0.08;
                    placeShuttleAtDistance(
                        shuttle,
                        shuttle.stationPath,
                        shuttle.stationPath.length * ((cycle - 0.1) / 0.1)
                    );
                    shuttle.load.visible = true;
                    shuttle.state = 'lift-approach';
                } else if (cycle < 0.34) {
                    placeShuttleAtDistance(shuttle, shuttle.stationPath, shuttle.stationPath.length);
                    const liftProgress = (cycle - 0.2) / 0.14;
                    shuttle.group.position.y = floorY + shuttle.targetLevel * liftProgress;
                    shuttle.lift.platform.position.y = 0.08 + shuttle.targetLevel * liftProgress;
                    shuttle.load.visible = true;
                    shuttle.state = 'lifting';
                } else if (cycle < 0.62) {
                    shuttle.lift.platform.position.y = 0.08 + shuttle.targetLevel;
                    placeShuttleAtDistance(
                        shuttle,
                        shuttle.rackPath,
                        shuttle.rackPath.length * ((cycle - 0.34) / 0.28)
                    );
                    shuttle.group.position.y = rackLevelY;
                    shuttle.load.visible = true;
                    shuttle.state = 'putaway-transfer';
                } else if (cycle < 0.68) {
                    shuttle.lift.platform.position.y = 0.08 + shuttle.targetLevel;
                    placeShuttleAtDistance(shuttle, shuttle.rackPath, shuttle.rackPath.length);
                    shuttle.group.position.y = rackLevelY;
                    shuttle.load.visible = false;
                    shuttle.state = 'rack-handoff';
                } else if (cycle < 0.84) {
                    shuttle.lift.platform.position.y = 0.08 + shuttle.targetLevel;
                    placeShuttleAtDistance(
                        shuttle,
                        shuttle.rackPath,
                        shuttle.rackPath.length * (1 - (cycle - 0.68) / 0.16)
                    );
                    shuttle.group.position.y = rackLevelY;
                    shuttle.load.visible = true;
                    shuttle.state = 'picking-transfer';
                } else if (cycle < 0.94) {
                    placeShuttleAtDistance(shuttle, shuttle.stationPath, shuttle.stationPath.length);
                    const liftProgress = 1 - (cycle - 0.84) / 0.1;
                    shuttle.group.position.y = floorY + shuttle.targetLevel * liftProgress;
                    shuttle.lift.platform.position.y = 0.08 + shuttle.targetLevel * liftProgress;
                    shuttle.load.visible = true;
                    shuttle.state = 'lowering';
                } else {
                    shuttle.lift.platform.position.y = 0.08;
                    placeShuttleAtDistance(
                        shuttle,
                        shuttle.stationPath,
                        shuttle.stationPath.length * (1 - (cycle - 0.94) / 0.06)
                    );
                    shuttle.load.visible = true;
                    shuttle.state = 'outbound-handoff';
                }
                shuttle.group.userData.operationState = shuttle.state;
            });
            shell.viewport.dataset.shuttleStates = shuttleFleet.map((shuttle) => shuttle.state).join(',');
            return true;
        };
        // Both data sources use these same physical models and screen-space labels.
        const createDrawingEquipment = (object, index) => {
            const isShuttle = object.kind === 'SH';
            const dimensions = calculateShuttleLoadDimensions(rackEntries.flatMap(entry => entry.slots), data.meta.floorPlanCellSize);
            const model = isShuttle ? createShuttleModel(index, {code:object.code}, dimensions) : createForkliftModel(index);
            if (model.load) model.load.visible = false;
            const visual = model.group;
            visual.rotation.y = Math.PI / 2;
            visual.updateMatrixWorld(true);
            const physicalBounds = new THREE.Box3();
            visual.traverse(part => {
                if (!part.isMesh || part.geometry?.type === 'CircleGeometry') return;
                for (let p=part; p && p!==visual; p=p.parent) if (p===model.load) return;
                if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
                physicalBounds.union(part.geometry.boundingBox.clone().applyMatrix4(part.matrixWorld));
            });
            const size=physicalBounds.getSize(new THREE.Vector3()), center=physicalBounds.getCenter(new THREE.Vector3());
            const fitted=new THREE.Group();fitted.name='drawing-equipment-fit';
            fitted.scale.set(object.w/size.x,object.height/size.y,object.h/size.z);
            visual.position.set(-center.x,-physicalBounds.min.y,-center.z);fitted.add(visual);
            const group=new THREE.Group();group.name=visual.name;group.userData={...visual.userData,drawingId:object.id,equipmentCode:object.code};group.add(fitted);
            group.position.set(object.x+object.w/2,warehouseFloorElevation,object.y+object.h/2);group.rotation.y=-object.angle*Math.PI/180;
            const equipment={...model,group,visual,visualScaleY:fitted.scale.y,drawingObject:object,
                equipmentCode:object.code,equipmentName:object.master?.name||object.id,equipmentType:object.master?.type||object.kind,
                modelName:object.master?.modelName||'',configuredSpeed:object.master?.configuredSpeed||0,
                ...object.status,communicationStatus:object.status?.communicationStatus||'OFFLINE',equipmentStatus:object.status?.equipmentStatus||'미설정',
                kindLabel:isShuttle?'4 WAY SHUTTLE':'AMR',state:'대기',transportHistory:[],loadDimensions:dimensions,
                forkHeight:travelForkHeight,forkExtension:0,task:null,carriedLoad:null};
            equipment.label=createAmrLabelSprite(THREE,{name:equipment.equipmentName,communicationStatus:equipment.communicationStatus,equipmentStatus:equipment.equipmentStatus});
            equipment.label.name=`${equipment.equipmentName}-status-billboard`;
            equipment.label.position.set(0,object.height+.72,0);
            equipment.label.userData={...equipment.label.userData,kind:'amr-label',amr:equipment,equipmentKind:isShuttle?'shuttle':'amr'};
            group.add(equipment.label);amrLabelTargets.push(equipment.label);
            (isShuttle?shuttleFleet:amrFleet).push(equipment);scene.add(group);
            return equipment;
        };
        const createDrawingLift = (object) => {
            const lift=createLiftModel({code:object.id,stationCode:object.id,x:object.x+object.w/2,z:object.y+object.h/2,
                width:object.w,depth:object.h,height:liftHeight,levelStops:shuttleLevelElevations.map(mm)});
            lift.group.rotation.y=-object.angle*Math.PI/180;
            shuttleLiftEntries.push(lift);
            return lift;
        };
        const operationFactory = data.meta?.source === 'drawing' ? window.WmsWarehouseDrawingScene.mount : window.createWarehouseOperationScene;
        const operations = Array.isArray(data.operationRoutes) ? operationFactory({
            THREE, shell, data, scene, signal, amrFleet, shuttleFleet, shuttleLiftEntries, rackEntries,
            passageNavigation, shuttleNavigation, buildPassageNavigationGraph, createTaskLoad,
            setSlotInstanceVisible, warehouseFloorElevation, shuttleTravelBaseOffset,
            resetSimulationExtras: () => {barcodeTunnelModel.reset();if(selectedBarcodeTunnel)showBarcodeTunnelSelection(selectedBarcodeTunnel);},
            shuttleBodyCenterY, shuttleFrameHeight, setForkHeight, setForkExtension, stackerDimensions, travelForkHeight,
            isLevelFocused: () => Boolean(activeRackLevelFocus),
            createDrawingEquipment, createDrawingLift,
            createLabel: text => createLabelSprite(THREE,text),
            createConveyor: layout => createConveyorModel(THREE,layout,0),
            originalShuttleFrame: {deckMaterial:shuttleDeckMaterial,frameMaterial:shuttleFrameMaterial,frameHeight:shuttleFrameHeight,frameOffset:shuttleFrameCenterOffset},
            slotVisualState: slot => ({
                visible: !activeRackLevelFocus || (slot.rack === activeRackLevelFocus.rackData.rack && slot.level === activeRackLevelFocus.level),
                opacity: rackEntries.find(entry => entry.rack === slot.rack)?.dimmed ? 0.12 : 1,
                color: slotColorPalette[getSlotVisualKey(slot, viewMode)]
            })
        }) : null;
        const updateAmrFleet = (timestamp) => {
            if (!amrFleet.length) return false;
            if (!lastAmrFrameTime) {
                lastAmrFrameTime = timestamp;
                return true;
            }
            const deltaSeconds = Math.min(0.05, Math.max(0, (timestamp - lastAmrFrameTime) / 1000));
            lastAmrFrameTime = timestamp;
            amrFleet.forEach((amr) => {
                if (amr.state === 'driving') {
                    updateDrivingForklift(amr, timestamp, deltaSeconds);
                    return;
                }
                const task = amr.task;
                if (!task) {
                    assignForkliftTask(amr, timestamp);
                    return;
                }
                if (amr.state === 'aligning') {
                    const aligned = rotateForkliftToward(amr, task.target.facingYaw, deltaSeconds, 2.2);
                    if (aligned && timestamp - amr.stateStartedAt > 220) setForkliftState(amr, 'lifting', timestamp);
                    return;
                }
                if (amr.state === 'lifting') {
                    setForkHeight(amr, moveToward(amr.forkHeight, task.target.forkHeight, deltaSeconds * 0.95));
                    if (Math.abs(amr.forkHeight - task.target.forkHeight) < 0.001) setForkliftState(amr, 'extending', timestamp);
                    return;
                }
                if (amr.state === 'extending') {
                    setForkExtension(amr, moveToward(amr.forkExtension, task.target.forkExtension, deltaSeconds * 0.62));
                    if (Math.abs(amr.forkExtension - task.target.forkExtension) < 0.001) {
                        setForkliftState(amr, task.mode === 'putaway' ? 'placing' : 'picking', timestamp);
                    }
                    return;
                }
                if (amr.state === 'picking' || amr.state === 'placing') {
                    handleForkliftLoad(amr);
                    if (timestamp - amr.stateStartedAt > 650) setForkliftState(amr, 'retracting', timestamp);
                    return;
                }
                if (amr.state === 'retracting') {
                    setForkExtension(amr, moveToward(amr.forkExtension, 0, deltaSeconds * 0.72));
                    if (amr.forkExtension < 0.001) setForkliftState(amr, 'lowering', timestamp);
                    return;
                }
                if (amr.state === 'lowering') {
                    setForkHeight(amr, moveToward(amr.forkHeight, travelForkHeight, deltaSeconds * 1.05));
                    if (Math.abs(amr.forkHeight - travelForkHeight) < 0.001) {
                        amr.completedTasks += 1;
                        setForkliftState(amr, 'waiting', timestamp);
                    }
                    return;
                }
                if (amr.state === 'waiting' && timestamp - amr.stateStartedAt > 850) {
                    assignForkliftTask(amr, timestamp);
                }
            });
            shell.viewport.dataset.forkliftStates = amrFleet.map((amr) => amr.state).join(',');
            shell.viewport.dataset.amrPositions = amrFleet
                .map((amr) => `${amr.equipmentCode}:${amr.group.position.x.toFixed(3)},${amr.group.position.z.toFixed(3)}`)
                .join(';');
            return true;
        };
        const render = (timestamp) => {
            animationFrame = 0;
            const frameTime = timestamp || performance.now();
            updateWorldUiTransitions(frameTime);
            const amrIsActive = operations ? operations.update(frameTime) : updateAmrFleet(frameTime);
            staticTrucks.forEach(truck => {
                const label = truck.userData.infoBillboard;
                const status = operations?.truckProgress(truck.userData.dockCode, label.userData.workType);
                if (status) label.setProgressStatus(status);
            });
            shell.viewport.dataset.warehouseTruckProgress = JSON.stringify(staticTrucks.map(truck => ({
                dock: truck.userData.dockCode, status: truck.userData.infoBillboard.userData.progressStatus
            })));
            const shuttleIsActive = operations ? false : updateShuttleFleet(frameTime);
            const selectedTunnelScanCount = selectedBarcodeTunnel?.scans ?? -1;
            const scannerIsActive = !activeRackLevelFocus && barcodeTunnelModel.update(data.meta?.source==='drawing'&&operations?operations.elapsed*1000:frameTime,
                scene.children.filter(object => object.name.startsWith('operation-pallet-')),
                resolveBarcodeScanMetadata);
            barcodeTunnelModel.entries.forEach(entry => {
                const status = entry.equipmentStatus || '대기';
                if (entry.label?.userData?.equipmentStatus !== status) {
                    entry.label.setOperationStatus(status);
                    const interaction = entry === selectedBarcodeTunnel ? 'selected'
                        : entry === hoveredBarcodeTunnel ? 'hover' : 'normal';
                    entry.label.setInteractionState(interaction)?.(1);
                }
                const statusElement = shell.zoneButtons.querySelector(
                    `[data-warehouse-object-code="${entry.tunnel.name}"] .warehouse-3d-object-status`
                );
                if (statusElement && statusElement.textContent !== status) {
                    statusElement.textContent = status;
                    statusElement.style.setProperty('--warehouse-equipment-status-color', getAmrEquipmentStatusColor(status));
                }
            });
            if (selectedBarcodeTunnel && selectedBarcodeTunnel.scans !== selectedTunnelScanCount) {
                showBarcodeTunnelSelection(selectedBarcodeTunnel);
            }
            updateHistoryDialog();
            shell.viewport.dataset.barcodeTunnelScans = barcodeTunnelModel.entries.map(e => e.scans).join(',');
            shell.viewport.dataset.barcodeTunnelFlashing = barcodeTunnelModel.entries.map(e => Number(e.glow.visible)).join(',');
            updateAmrFollow(frameTime);
            if (!destroyed && renderer.domElement.isConnected && shell.viewport.clientWidth && shell.viewport.clientHeight) {
                renderer.render(scene, camera);
                updateTruckInvoiceButtons();
                updateHoverTooltipPosition();
            }
            if ((data.meta?.source === 'drawing' && operations)
                || activeWorldUiTransitions.size
                || scannerIsActive
                || (amrIsActive && shell.viewport.clientWidth && shell.viewport.clientHeight)
                || (shuttleIsActive && shell.viewport.clientWidth && shell.viewport.clientHeight)) requestRender();
        };
        const requestRender = () => {
            if (!animationFrame && !destroyed) animationFrame = requestAnimationFrame(render);
        };
        const startWorldUiTransition = (duration, update, complete) => {
            activeWorldUiTransitions.add({
                startedAt: performance.now(),
                duration,
                update,
                complete
            });
            requestRender();
        };
        const setAmrLabelState = (amr, state) => {
            const update = amr?.label?.setInteractionState(state);
            if (!update) return;
            const token = {};
            amr.label.userData.interactionToken = token;
            startWorldUiTransition(160, progress => {
                if (amr.label.userData.interactionToken !== token) return false;
                update(progress);
                return true;
            });
        };
        const setBarcodeTunnelLabelState = (entry, state) => {
            const update = entry?.label?.setInteractionState(state);
            if (!update) return;
            const token = {};
            entry.label.userData.interactionToken = token;
            startWorldUiTransition(160, progress => {
                if (entry.label.userData.interactionToken !== token) return false;
                update(progress);
                return true;
            });
        };
        const setHoveredBarcodeTunnel = entry => {
            if (hoveredBarcodeTunnel === entry) return;
            if (hoveredBarcodeTunnel && hoveredBarcodeTunnel !== selectedBarcodeTunnel) {
                setBarcodeTunnelLabelState(hoveredBarcodeTunnel, 'normal');
            }
            hoveredBarcodeTunnel = entry || null;
            if (hoveredBarcodeTunnel && hoveredBarcodeTunnel !== selectedBarcodeTunnel) {
                setBarcodeTunnelLabelState(hoveredBarcodeTunnel, 'hover');
            }
            renderer.domElement.style.cursor = hoveredBarcodeTunnel ? 'pointer' : '';
        };
        const setSelectedBarcodeTunnel = entry => {
            const previous = selectedBarcodeTunnel;
            selectedBarcodeTunnel = entry || null;
            if (previous && previous !== selectedBarcodeTunnel) {
                setBarcodeTunnelLabelState(previous, previous === hoveredBarcodeTunnel ? 'hover' : 'normal');
            }
            if (selectedBarcodeTunnel) {
                setBarcodeTunnelLabelState(selectedBarcodeTunnel, 'selected');
                showBarcodeTunnelSelection(selectedBarcodeTunnel);
            }
            shell.viewport.dataset.selectedBarcodeTunnel = selectedBarcodeTunnel?.tunnel?.name || '';
            shell.syncObjectSelection?.();
            requestRender();
        };
        const setHoveredAmr = (amr) => {
            if (hoveredAmr === amr) return;
            if (hoveredAmr && hoveredAmr !== followedAmr) setAmrLabelState(hoveredAmr, 'normal');
            hoveredAmr = amr || null;
            if (hoveredAmr && hoveredAmr !== followedAmr) setAmrLabelState(hoveredAmr, 'hover');
            renderer.domElement.style.cursor = hoveredAmr ? 'pointer' : '';
        };
        const setSelectedAmr = (amr) => {
            const previous = followedAmr;
            followedAmr = amr || null;
            amrFocusTransition = null;
            amrFollowOffset.set(0, 0, 0);
            if (previous && previous !== followedAmr) setAmrLabelState(previous, previous === hoveredAmr ? 'hover' : 'normal');
            if (followedAmr) {
                setAmrLabelState(followedAmr, 'selected');
                resetInspectorLayout();
                shell.inspector.innerHTML = getAmrInspectorHtml(followedAmr);
                cameraFocusTransitionToken += 1;
                // Keep at least 14m vertically and 10m horizontally in view.
                const viewHeight = Math.max(14, 10 / Math.max(0.1, viewportAspect));
                amrFocusTransition = {
                    startedAt: performance.now(), duration: 500,
                    startTarget: target.clone(), startDistance: distance, startHeight: orthographicViewHeight,
                    endDistance: Math.max(minimumCameraDistance, Math.min(maximumCameraDistance, viewHeight / (2 * Math.tan(perspectiveHalfFov)))),
                    endHeight: viewHeight, zoomCancelled: false
                };
            }
            shell.viewport.dataset.followingAmrCode = followedAmr?.equipmentCode || '';
            if (!followedAmr && previous) showDefaultInspector();
            shell.syncObjectSelection?.();
            requestRender();
        };
        const amrFollowTarget = new THREE.Vector3();
        const amrFollowOffset = new THREE.Vector3();
        const updateAmrFollow = (timestamp) => {
            if (!followedAmr) return;
            amrFollowTarget.copy(followedAmr.group.position);
            amrFollowTarget.y += 1.5;
            amrFollowTarget.add(amrFollowOffset);
            const transition = amrFocusTransition;
            if (transition) {
                const fraction = Math.min(1, Math.max(0, (timestamp - transition.startedAt) / transition.duration));
                const progress = easeOutCubic(fraction);
                target.lerpVectors(transition.startTarget, amrFollowTarget, progress);
                if (!transition.zoomCancelled) {
                    distance = transition.startDistance + (transition.endDistance - transition.startDistance) * progress;
                    orthographicViewHeight = transition.startHeight + (transition.endHeight - transition.startHeight) * progress;
                    updateProjectionMatrices();
                }
                if (fraction >= 1) amrFocusTransition = null;
            } else target.copy(amrFollowTarget);
            // Translation only: yaw, pitch and the selected view preset stay untouched.
            updateCamera();
        };
        const fadeWorldObject = (object, visible, { duration = 140, reset = false } = {}) => {
            const material = object?.userData?.material || object?.material;
            if (!material) return;
            const targetOpacity = visible ? (object.userData.maxOpacity ?? 1) : 0;
            if (visible) object.visible = true;
            if (!visible && !object.visible) return;
            const token = {};
            object.userData.worldTransitionToken = token;
            const startOpacity = reset ? 0 : material.opacity;
            if (reset) material.opacity = 0;
            if (Math.abs(startOpacity - targetOpacity) < 0.001 && !reset) {
                material.opacity = targetOpacity;
                if (!visible) object.visible = false;
                return;
            }
            startWorldUiTransition(duration, (progress) => {
                if (object.userData.worldTransitionToken !== token) return false;
                material.opacity = startOpacity + (targetOpacity - startOpacity) * progress;
                return true;
            }, () => {
                if (object.userData.worldTransitionToken === token && !visible) object.visible = false;
            });
        };
        const focusRackInCurrentView = (rackData) => {
            const bounds = rackData?.focusBounds;
            const focusView = calculateRackFocusView(bounds, {
                yaw,
                pitch,
                aspect: viewportAspect,
                verticalFovDegrees: perspectiveCamera.fov,
                padding: 1.12
            });
            if (!focusView) return;
            const startTarget = target.clone();
            const endTarget = new THREE.Vector3(focusView.center.x, focusView.center.y, focusView.center.z);
            const startDistance = distance;
            const startOrthographicViewHeight = orthographicViewHeight;
            const endDistance = Math.max(minimumCameraDistance, Math.min(maximumCameraDistance, focusView.perspectiveDistance));
            const endOrthographicViewHeight = Math.max(0.5, Math.min(getPerspectiveViewHeight(maximumCameraDistance), focusView.orthographicViewHeight));
            const orthographicCameraDistance = Math.max(distance, focusView.depthExtent + 1);
            const token = ++cameraFocusTransitionToken;
            startWorldUiTransition(320, (progress) => {
                if (cameraFocusTransitionToken !== token) return false;
                target.lerpVectors(startTarget, endTarget, progress);
                if (projectionMode === 'orthographic') {
                    distance = startDistance + (orthographicCameraDistance - startDistance) * progress;
                    orthographicViewHeight = startOrthographicViewHeight + (endOrthographicViewHeight - startOrthographicViewHeight) * progress;
                } else {
                    distance = startDistance + (endDistance - startDistance) * progress;
                    orthographicViewHeight = getPerspectiveViewHeight(distance);
                }
                updateProjectionMatrices();
                updateCamera();
                return true;
            });
        };

        const applyGridVisibility = (isVisible) => {
            grid.visible = Boolean(isVisible);
            shell.gridToggle.setAttribute('aria-pressed', String(grid.visible));
            shell.gridToggle.setAttribute('aria-label', grid.visible ? 'Grid 숨기기' : 'Grid 표시');
            requestRender();
        };
        const moveSlotOverlay = (overlay, slot) => {
            if (!slot) return;
            if (overlay.parent !== slot.group) { overlay.parent?.remove(overlay); slot.group.add(overlay); }
            overlay.position.set(slot.position[0], slot.position[1], slot.position[2]);
        };
        const updateSlotOutline = (outline, slot) => {
            if (!slot) { fadeWorldObject(outline, false); return; }
            const [width, height, depth] = slot.boxSize;
            const edgeGeometry = getSlotOutlineGeometry(width + 0.045, height + 0.045, depth + 0.045);
            if (outline.userData.edgeGeometry !== edgeGeometry) {
                outline.clear();
                const positions = edgeGeometry.getAttribute('position');
                const up = new THREE.Vector3(0, 1, 0);
                for (let index = 0; index < positions.count; index += 2) {
                    const start = new THREE.Vector3().fromBufferAttribute(positions, index);
                    const end = new THREE.Vector3().fromBufferAttribute(positions, index + 1);
                    const direction = end.clone().sub(start);
                    const length = direction.length();
                    if (!(length > 0)) continue;
                    const segment = new THREE.Mesh(getOutlineTubeGeometry(length, outline.userData.radius), outline.userData.material);
                    segment.position.copy(start).add(end).multiplyScalar(0.5);
                    segment.quaternion.setFromUnitVectors(up, direction.normalize());
                    segment.renderOrder = 10;
                    outline.add(segment);
                }
                outline.userData.edgeGeometry = edgeGeometry;
            }
            moveSlotOverlay(outline, slot);
            const slotChanged = outline.userData.slot !== slot;
            outline.userData.slot = slot;
            fadeWorldObject(outline, true, { reset: slotChanged });
        };
        const getSlotSummary = (slot) => {
            const capacity = Number(slot.stock?.capacity || slot.location?.capacity || 0);
            const quantity = Number(slot.stock?.quantity || 0);
            return { itemName: slot.item?.name || '빈 로케이션', quantity, capacity, rate: capacity > 0 ? Math.round((quantity / capacity) * 100) : null };
        };
        const updateHoverTooltipPosition = () => {
            const tooltip = shell.hoverTooltip;
            if (!hoveredSlot || tooltip.hidden) return;
            const anchor = new THREE.Vector3(
                hoveredSlot.position[0],
                hoveredSlot.position[1] + hoveredSlot.boxSize[1] / 2 + 0.22,
                hoveredSlot.position[2]
            );
            hoveredSlot.group.localToWorld(anchor);
            const cameraSpace = anchor.clone().applyMatrix4(camera.matrixWorldInverse);
            const projected = anchor.project(camera);
            const isOutsideViewport = cameraSpace.z >= 0 || projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1;
            tooltip.classList.toggle('is-offscreen', isOutsideViewport);
            if (isOutsideViewport) return;
            const rect = renderer.domElement.getBoundingClientRect();
            const padding = 10;
            const anchorX = (projected.x + 1) * rect.width / 2;
            const anchorY = (1 - projected.y) * rect.height / 2;
            const x = Math.max(padding, Math.min(rect.width - tooltip.offsetWidth - padding, anchorX + 14));
            const y = Math.max(padding, Math.min(rect.height - tooltip.offsetHeight - padding, anchorY - tooltip.offsetHeight - 14));
            tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        };
        const updateHoverTooltip = (slot) => {
            const tooltip = shell.hoverTooltip;
            if (!slot) {
                tooltip.hidden = true;
                tooltip.classList.remove('is-visible', 'is-offscreen');
                return;
            }
            const summary = getSlotSummary(slot);
            tooltip.innerHTML = `<strong>${escapeHtml(summary.itemName)}</strong><span>수량 ${summary.quantity} / ${summary.capacity || '미설정'} · 적재율 ${summary.rate === null ? '용량 미설정' : `${summary.rate}%`}</span>`;
            tooltip.hidden = false;
            tooltip.classList.add('is-visible');
            updateHoverTooltipPosition();
        };
        let hoveredSlot = null;
        const setHoveredSlot = (slot) => {
            if (hoveredSlot === slot) return;
            hoveredSlot = slot || null;
            updateSlotOutline(hoverOutline, hoveredSlot);
            updateHoverTooltip(hoveredSlot);
            requestRender();
        };
        const setSelectedSlot = (slot) => {
            updateSlotOutline(selectedOutline, slot || null);
            requestRender();
        };
        let hoveredRack = null;
        let selectedRack = null;
        let focusedRack = null;
        let restoreCameraAfterRackLevelClear = null;
        let hoveredRackLevelLabel = null;
        const setRackLevelLabelState = (levelData, state) => {
            const update = levelData?.label?.setInteractionState?.(state);
            if (update) startWorldUiTransition(140, (progress) => { update(progress); return true; });
        };
        const syncRackLevelSceneVisibility = () => {
            const active = activeRackLevelFocus;
            rackEntries.forEach((entry) => {
                const selectedEntry = active?.rackData === entry.rackData;
                entry.group.visible = !active || selectedEntry;
                entry.rackStructureObjects.forEach((object) => { object.visible = !active; });
                entry.rackData.label.visible = !active;
                entry.rackData.levelLabelGroup.visible = entry.rackData === selectedRack;
                entry.rackData.levelLabels.forEach((levelLabel) => {
                    levelLabel.visible = !active || (selectedEntry && levelLabel.userData.level === active.level);
                });
                if (entry.rackData.outlines?.hover) entry.rackData.outlines.hover.visible = false;
                if (entry.rackData.outlines?.selected) {
                    entry.rackData.outlines.selected.visible = !active && entry.rackData === selectedRack;
                    if (!active && entry.rackData === selectedRack) {
                        entry.rackData.outlines.selected.userData.material.opacity = entry.rackData.outlines.selected.userData.maxOpacity;
                    }
                }
                entry.slots.forEach(applySlotInstanceVisibility);
            });
            shuttleFrameGroup.visible = !active;
            barcodeTunnelModel.group.visible = !active;
            shuttleLiftEntries.forEach((lift) => { if (lift.group) lift.group.visible = !active; });
            amrFleet.forEach((amr) => { amr.group.visible = !active; });
            shuttleFleet.forEach((shuttle) => { shuttle.group.visible = !active; });
            shell.viewport.dataset.selectedRackLevel = active ? `${active.rackData.rack.code}:LV${active.level}` : '';
            shell.viewport.dataset.rackLevelView = active ? 'top' : '';
            shell.viewport.dataset.visibleRackLevelBillboards = selectedRack?.levelLabels
                ?.filter((levelLabel) => levelLabel.visible)
                .map((levelLabel) => `${selectedRack.rack.code}:LV${levelLabel.userData.level}`)
                .join(',') || '';
        };
        const setActiveRackLevelFocus = (levelData) => {
            const previous = activeRackLevelFocus;
            const sameLevel = previous && levelData
                && previous.rackData === levelData.rackData && previous.level === levelData.level;
            if (previous) setRackLevelLabelState(previous, 'normal');
            activeRackLevelFocus = sameLevel ? null : levelData || null;
            if (activeRackLevelFocus) setRackLevelLabelState(activeRackLevelFocus, 'selected');
            syncRackLevelSceneVisibility();
            requestRender();
            return activeRackLevelFocus;
        };
        const setHoveredRackLevelLabel = (levelData) => {
            if (hoveredRackLevelLabel === levelData) return;
            if (hoveredRackLevelLabel && hoveredRackLevelLabel !== activeRackLevelFocus) {
                setRackLevelLabelState(hoveredRackLevelLabel, 'normal');
            }
            hoveredRackLevelLabel = levelData || null;
            if (hoveredRackLevelLabel && hoveredRackLevelLabel !== activeRackLevelFocus) {
                setRackLevelLabelState(hoveredRackLevelLabel, 'hover');
            }
        };
        const setFocusedRack = (rackData) => {
            if (activeRackLevelFocus && activeRackLevelFocus.rackData !== rackData) setActiveRackLevelFocus(null);
            focusedRack = rackData || null;
            rackEntries.forEach((entry) => {
                const mode = !focusedRack ? 'none' : entry.rack === focusedRack.rack ? 'frames' : 'all';
                setRackEntryDimmed(entry, mode);
            });
            setShuttleFrameDimmed(Boolean(focusedRack));
            shell.viewport.dataset.rackFocusDimming = focusedRack ? 'rack-and-shuttle-frames' : 'none';
            requestRender();
        };
        const setRackLabelState = (rackData, state) => {
            const update = rackData?.label?.setInteractionState?.(state);
            if (update) startWorldUiTransition(160, (progress) => { update(progress); return true; });
        };
        const setHoveredRack = (rackData) => {
            if (hoveredRack === rackData) return;
            if (hoveredRack?.outlines?.hover) {
                const previousOutline = hoveredRack.outlines.hover;
                if (rackData) { previousOutline.visible = false; previousOutline.userData.material.opacity = 0; }
                else fadeWorldObject(previousOutline, false);
            }
            if (hoveredRack && hoveredRack !== selectedRack) setRackLabelState(hoveredRack, 'normal');
            hoveredRack = rackData || null;
            if (hoveredRack?.outlines?.hover) fadeWorldObject(hoveredRack.outlines.hover, true, { reset: true });
            if (hoveredRack && hoveredRack !== selectedRack) setRackLabelState(hoveredRack, 'hover');
            requestRender();
        };
        const setSelectedRack = (rackData) => {
            const clearedRackLevelFocus = Boolean(activeRackLevelFocus && activeRackLevelFocus.rackData !== rackData);
            if (clearedRackLevelFocus) setActiveRackLevelFocus(null);
            const previousSelectedRack = selectedRack;
            if (previousSelectedRack?.outlines?.selected) {
                const previousOutline = previousSelectedRack.outlines.selected;
                if (rackData) { previousOutline.visible = false; previousOutline.userData.material.opacity = 0; }
                else fadeWorldObject(previousOutline, false, { duration: 180 });
            }
            if (previousSelectedRack) setRackLabelState(previousSelectedRack, previousSelectedRack === hoveredRack ? 'hover' : 'normal');
            selectedRack = rackData || null;
            if (selectedRack?.outlines?.selected) fadeWorldObject(selectedRack.outlines.selected, true, { duration: 180, reset: true });
            if (selectedRack) setRackLabelState(selectedRack, 'selected');
            syncRackLevelSceneVisibility();
            shell.syncObjectSelection?.();
            if (clearedRackLevelFocus) restoreCameraAfterRackLevelClear?.(selectedRack);
            requestRender();
        };
        const resetInspectorLayout = () => shell.inspector.classList.remove('is-barcode-tunnel', 'is-transport-inspector');
        const showDefaultInspector = () => {
            resetInspectorLayout();
            shell.inspector.innerHTML = '<h5>선택 정보</h5><p>구역, 랙, 설비, 스캔 터널 또는 적재 상자를 선택하면 상세 정보가 표시됩니다.</p>';
        };
        function showBarcodeTunnelSelection(entry) {
            if (!entry) return;
            resetInspectorLayout();
            const code = entry.tunnel?.name || 'BT';
            const communicationText = entry.communicationStatus === 'ONLINE' ? '온라인 (ONLINE)' : '오프라인 (OFFLINE)';
            shell.inspector.innerHTML = `<h5>${escapeHtml(code)} · 스캔 터널</h5><dl class="warehouse-3d-amr-details"><dt>터널 번호</dt><dd>${escapeHtml(code)}</dd><dt>통신 상태</dt><dd>${escapeHtml(communicationText)}</dd><dt>설비 상태</dt><dd>${escapeHtml(entry.equipmentStatus || '대기')}</dd><dt>누적 스캔</dt><dd>${entry.scans}건</dd></dl><button type="button" class="warehouse-3d-history-button" data-warehouse-history="scan">작업 이력 보기</button>`;
        }
        const historyDialog = document.createElement('dialog');
        historyDialog.className = 'warehouse-history-dialog';
        historyDialog.setAttribute('aria-label', '설비 작업 이력');
        historyDialog.innerHTML = '<div class="warehouse-history-dialog-content"><header><h3></h3><button type="button" class="warehouse-history-close" aria-label="작업 이력 닫기">닫기</button></header><p class="warehouse-history-caption">현재 모의 운행의 이력입니다. 기준정보 새로고침 또는 모의 운행 초기화 시 이력이 초기화됩니다.</p><div class="warehouse-history-table-scroll"><table class="warehouse-history-table"><thead></thead><tbody></tbody></table></div><footer><span class="warehouse-history-count"></span><span>운행 중 자동 갱신</span></footer></div>';
        shell.viewport.closest('.warehouse-3d-shell').append(historyDialog);
        let historyTarget = null;
        let historyKind = '';
        let historySignature = '';
        function updateHistoryDialog() {
            if (!historyDialog.open || !historyTarget) return;
            const records = historyKind === 'scan' ? historyTarget.history : historyTarget.transportHistory;
            const signature = JSON.stringify(records || []);
            if (signature === historySignature) return;
            historyDialog.querySelector('tbody').innerHTML = historyKind === 'scan'
                ? getScanHistoryHtml(historyTarget) : getTransportHistoryHtml(historyTarget);
            historyDialog.querySelector('.warehouse-history-count').textContent = `총 ${records?.length || 0}건`;
            historySignature = signature;
        }
        shell.inspector.addEventListener('click', event => {
            const button = event.target.closest('[data-warehouse-history]');
            if (!button) return;
            historyKind = button.dataset.warehouseHistory;
            historyDialog.dataset.kind = historyKind;
            historyTarget = historyKind === 'scan' ? selectedBarcodeTunnel : followedAmr;
            if (!historyTarget) return;
            historySignature = '';
            const name = historyKind === 'scan' ? `${historyTarget.tunnel.name} · 스캔 터널`
                : historyTarget.equipmentName || historyTarget.equipmentCode;
            historyDialog.querySelector('h3').textContent = `${name} · 작업 이력`;
            const columns = historyKind === 'scan'
                ? ['통과 시간', '물품 정보', '바코드 정보', '인식 상태', '도착지']
                : ['물품 정보', '바코드 정보', '작업 상태', '배정 시간', '상차 지점', '상차 시간', '하차 지점', '하차 시간'];
            historyDialog.querySelector('thead').innerHTML = `<tr>${columns.map(column => `<th scope="col">${column}</th>`).join('')}</tr>`;
            const scroller = historyDialog.querySelector('.warehouse-history-table-scroll');
            scroller.scrollTop = 0; scroller.scrollLeft = 0;
            historyDialog.showModal();
            updateHistoryDialog();
        }, { signal });
        historyDialog.querySelector('.warehouse-history-close').addEventListener('click', () => historyDialog.close(), { signal });
        historyDialog.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation();
            historyDialog.close();
        }, { signal });
        historyDialog.addEventListener('click', event => {
            if (event.target !== historyDialog) return;
            const rect = historyDialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) historyDialog.close();
        }, { signal });
        historyDialog.addEventListener('close', () => {
            historyTarget = null;
            shell.inspector.querySelector('[data-warehouse-history]')?.focus();
        }, { signal });
        signal.addEventListener('abort', () => { historyDialog.close(); historyDialog.remove(); }, { once: true });
        const invoiceDialog = document.createElement('dialog');
        invoiceDialog.className = 'warehouse-invoice-dialog';
        invoiceDialog.setAttribute('aria-label', '차량 운송 송장');
        invoiceDialog.innerHTML = '<div class="warehouse-invoice-toolbar"><span>운송 송장</span><button type="button" class="warehouse-invoice-close" aria-label="송장 닫기">닫기</button></div><div class="warehouse-invoice-content"></div>';
        shell.viewport.closest('.warehouse-3d-shell').append(invoiceDialog);
        let invoiceOpener = null;
        const invoiceButtons = staticTrucks.map(truck => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'warehouse-truck-invoice-trigger';
            button.dataset.truckInvoiceDock = truck.userData.dockCode;
            button.setAttribute('aria-label', `${truck.userData.dockCode} 차량 송장 보기`);
            button.title = `${truck.userData.dockCode} 차량 송장 보기`;
            button.hidden = true;
            shell.viewport.append(button);
            button.addEventListener('click', () => {
                invoiceOpener = button;
                const info = schedulesByDock.get(truck.userData.dockCode) || {};
                const order = data.workOrders?.find(order => order.code === info.scheduleCode) || {};
                invoiceDialog.dataset.dockCode = truck.userData.dockCode;
                invoiceDialog.querySelector('.warehouse-invoice-content').innerHTML = getTruckInvoiceHtml({ ...info,
                    progressStatus: truck.userData.infoBillboard.userData.progressStatus }, truck.userData.dockCode,
                    document.body.dataset.brandTitle || '물류 창고', order);
                invoiceDialog.querySelector('.warehouse-invoice-content').scrollTop = 0;
                invoiceDialog.showModal();
            }, { signal });
            return { truck, button };
        });
        // Place native, keyboard-accessible buttons exactly over the buttons drawn on each sprite.
        function updateTruckInvoiceButtons() {
            const width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
            invoiceButtons.forEach(({ truck, button }) => {
                const sprite = truck.userData.infoBillboard;
                const world = sprite.getWorldPosition(new THREE.Vector3());
                const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
                const projected = world.clone().project(camera);
                const scale = sprite.getWorldScale(new THREE.Vector3());
                const divisor = camera.isPerspectiveCamera ? -view.z : 1;
                const spriteWidth = scale.x * camera.projectionMatrix.elements[0] / divisor * width / 2;
                const spriteHeight = scale.y * camera.projectionMatrix.elements[5] / divisor * height / 2;
                const x = (projected.x + 1) * width / 2 + spriteWidth * (24 / 520 - 0.5);
                const y = (1 - projected.y) * height / 2 + spriteHeight * (242 / 300 - 0.5);
                button.hidden = !sprite.visible || !truck.visible || view.z >= 0 || projected.z < -1 || projected.z > 1
                    || x + spriteWidth * 472 / 520 < 0 || x > width || y + spriteHeight * 40 / 300 < 0 || y > height;
                if (button.hidden) return;
                button.style.left = `${x}px`; button.style.top = `${y}px`;
                button.style.width = `${spriteWidth * 472 / 520}px`; button.style.height = `${spriteHeight * 40 / 300}px`;
            });
        }
        invoiceDialog.querySelector('.warehouse-invoice-close').addEventListener('click', () => invoiceDialog.close(), { signal });
        invoiceDialog.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation(); invoiceDialog.close();
        }, { signal });
        invoiceDialog.addEventListener('click', event => {
            if (event.target !== invoiceDialog) return;
            const rect = invoiceDialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) invoiceDialog.close();
        }, { signal });
        invoiceDialog.addEventListener('close', () => { invoiceOpener?.focus({ preventScroll: true }); invoiceOpener = null; }, { signal });
        signal.addEventListener('abort', () => {
            invoiceDialog.close(); invoiceDialog.remove(); invoiceButtons.forEach(({ button }) => button.remove());
        }, { once: true });
        let hoveredZoneCode = '';
        let selectedZoneCode = '';
        const getZoneStatistics = (zoneCode) => {
            const entries = rackEntries.filter((entry) => entry.rack.zoneCode === zoneCode);
            const slots = entries.flatMap((entry) => entry.slots);
            return {
                rackCount: entries.length,
                locationCount: slots.length,
                occupiedLocationCount: slots.filter((slot) => slot.occupied).length,
                stockQuantity: entries.reduce((total, entry) => total + entry.stocks.reduce((sum, stock) => sum + Number(stock.quantity || 0), 0), 0)
            };
        };
        const showZoneSelection = (zoneCode) => {
            const zone = zoneByCode.get(zoneCode);
            if (!zone) { showDefaultInspector(); return; }
            resetInspectorLayout();
            const statistics = getZoneStatistics(zoneCode);
            const defaultRackType = rackTypeByCode.get(zone.defaultRackTypeCode);
            const rackTypeText = defaultRackType
                ? `${escapeHtml(defaultRackType.code)} · ${escapeHtml(defaultRackType.name)}`
                : escapeHtml(zone.defaultRackTypeCode || '미설정');
            shell.inspector.innerHTML = `<h5>${escapeHtml(zone.code)} · ${escapeHtml(zone.name || '구역')}</h5><dl><dt>용도</dt><dd>${escapeHtml(zone.purpose || '미설정')}</dd><dt>기본 랙</dt><dd>${rackTypeText}</dd><dt>랙 수</dt><dd>${statistics.rackCount}개</dd><dt>로케이션</dt><dd>${statistics.locationCount}개</dd><dt>적재 위치</dt><dd>${statistics.occupiedLocationCount}개</dd><dt>재고 수량</dt><dd>${statistics.stockQuantity}</dd></dl>`;
        };
        const syncZoneVisualization = () => {
            zoneVisualizationEntries.forEach((entry) => {
                const isSelected = entry.zoneCode === selectedZoneCode;
                const isHovered = entry.zoneCode === hoveredZoneCode;
                entry.mesh.visible = isSelected || isHovered;
                entry.material.opacity = isSelected ? 0.08 : 0.065;
            });
            shell.zoneButtons.querySelectorAll('[data-warehouse-zone-code]').forEach((button) => {
                const zoneCode = button.dataset.warehouseZoneCode || '';
                button.setAttribute('aria-pressed', String(zoneCode === selectedZoneCode));
            });
            shell.viewport.dataset.selectedZoneCode = selectedZoneCode;
            shell.viewport.dataset.hoveredZoneCode = hoveredZoneCode;
            shell.viewport.dataset.visibleZoneCodes = zoneVisualizationEntries
                .filter((entry) => entry.mesh.visible)
                .map((entry) => entry.zoneCode)
                .join(',');
            shell.viewport.dataset.zoneVisualizationCount = String(zoneVisualizationEntries.length);
            shell.syncObjectSelection?.();
            requestRender();
        };
        const setHoveredZone = (zoneCode) => {
            const nextZoneCode = zoneByCode.has(zoneCode) ? zoneCode : '';
            if (hoveredZoneCode === nextZoneCode) return;
            hoveredZoneCode = nextZoneCode;
            syncZoneVisualization();
        };
        const setSelectedZone = (zoneCode, updateInspector = true) => {
            selectedZoneCode = zoneByCode.has(zoneCode) ? zoneCode : '';
            syncZoneVisualization();
            if (!updateInspector) return;
            if (selectedZoneCode) showZoneSelection(selectedZoneCode);
            else showDefaultInspector();
        };
        const clearObjectSelectionForZone = () => {
            setSelectedBarcodeTunnel(null);
            setSelectedAmr(null);
            setSelectedSlot(null);
            setHoveredSlot(null);
            setHoveredRack(null);
            setSelectedRack(null);
            setFocusedRack(null);
        };
        const selectableZones = data.zones.filter((zone) => zoneVisualizationEntries.some((entry) => entry.zoneCode === zone.code));
        const communicationIcon = (online) => `<svg class="warehouse-3d-connection-icon ${online ? 'is-online' : 'is-offline'}" viewBox="0 0 24 24" role="img" aria-label="${online ? '온라인' : '오프라인'}"><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>${online ? '' : '<path d="m3 3 18 18"/>'}</svg>`;
        const mobileEquipmentRows = [...amrFleet, ...shuttleFleet].map(equipment => ({
            code: equipment.equipmentCode,
            name: equipment.equipmentName,
            detail: equipment.equipmentStatus,
            value: equipment,
            equipmentKind: 'mobile'
        }));
        const barcodeTunnelEquipmentRows = barcodeTunnelModel.entries.map(entry => ({
            code: entry.tunnel.name,
            name: `${entry.tunnel.name} 스캔 터널`,
            detail: entry.equipmentStatus,
            value: entry,
            equipmentKind: 'barcode-tunnel'
        }));
        const objectGroups = {
            zone: selectableZones.map((zone) => ({ code: zone.code, name: zone.code, detail: zone.name || zone.purpose || '구역', value: zone })),
            rack: rackEntries.map(entry => ({ code: entry.rack.code, name: entry.rack.code, detail: entry.rack.zoneCode || '', value: entry })),
            equipment: [...mobileEquipmentRows, ...barcodeTunnelEquipmentRows]
        };
        let visibleObjectItems = [];
        let expandedBeforeSearch = null;
        const clearObjectPreview = () => { setHoveredZone(''); setHoveredRack(null); setHoveredAmr(null); setHoveredBarcodeTunnel(null); };
        const isObjectSelected = (item) => item.kind === 'zone' ? selectedZoneCode === item.code
            : item.kind === 'rack' ? selectedRack === item.value.rackData
                : item.equipmentKind === 'barcode-tunnel' ? selectedBarcodeTunnel === item.value : followedAmr === item.value;
        shell.syncObjectSelection = () => {
            shell.zoneButtons.querySelectorAll('[data-warehouse-object-index]').forEach(button => {
                const item = visibleObjectItems[Number(button.dataset.warehouseObjectIndex)];
                button.setAttribute('aria-pressed', String(Boolean(item && isObjectSelected(item))));
            });
            shell.objectOverview.setAttribute('aria-pressed', String(
                !selectedZoneCode && !selectedRack && !followedAmr && !selectedBarcodeTunnel && !selectedOutline.visible
                && !shell.objectSearch.value.trim()
            ));
        };
        const renderObjectList = () => {
            const query = shell.objectSearch.value.trim().toLocaleLowerCase();
            if (query && !expandedBeforeSearch) {
                expandedBeforeSearch = new Map(shell.objectSections.map(section => [section.dataset.warehouseObjectSection, section.open]));
            }
            visibleObjectItems = [];
            shell.objectSections.forEach(section => {
                const kind = section.dataset.warehouseObjectSection;
                const items = objectGroups[kind].filter(item =>
                    `${item.code} ${item.name} ${item.detail || ''}`.toLocaleLowerCase().includes(query));
                section.hidden = Boolean(query && !items.length);
                if (query && items.length) section.open = true;
                else if (!query && expandedBeforeSearch) section.open = expandedBeforeSearch.get(kind);
                section.querySelector('.warehouse-3d-object-children').innerHTML = items.map(item => {
                    const index = visibleObjectItems.push({ ...item, kind }) - 1;
                    const zone = kind === 'zone';
                    const equipment = kind === 'equipment';
                    const detail = equipment
                        ? `${communicationIcon(item.value.communicationStatus === 'ONLINE')}<span class="warehouse-3d-object-status" style="--warehouse-equipment-status-color:${getAmrEquipmentStatusColor(item.detail)}">${escapeHtml(item.detail || '미설정')}</span>`
                        : `<small>${escapeHtml(item.detail)}</small>`;
                    const icon = zone ? `<i class="warehouse-3d-object-swatch" style="background:${zoneColorByCode.get(item.code) || zoneColors[0]}" aria-hidden="true"></i>` : '';
                    return `<button type="button" class="warehouse-3d-object-row${zone ? ' warehouse-3d-zone-button' : ''}${equipment ? ' is-equipment' : ''}" data-warehouse-object-index="${index}" data-warehouse-object-kind="${kind}" data-warehouse-object-code="${escapeHtml(item.code)}"${zone ? ` data-warehouse-zone-code="${escapeHtml(item.code)}"` : ''} aria-pressed="false" title="${escapeHtml(`${item.code} · ${item.name} · ${item.detail || ''}`)}">${icon}<span class="warehouse-3d-object-name">${escapeHtml(item.name)}</span>${detail}</button>`;
                }).join('') || '<p class="warehouse-3d-object-empty">표시할 항목이 없습니다.</p>';
            });
            if (!query) expandedBeforeSearch = null;
            const total = Object.values(objectGroups).reduce((count, items) => count + items.length, 0);
            shell.objectEmpty.hidden = !query || visibleObjectItems.length > 0;
            shell.objectTotal.textContent = query ? `${visibleObjectItems.length} / ${total}개` : `${total}개`;
            shell.syncObjectSelection();
        };
        const clearPanelSelection = () => {
            cameraFocusTransitionToken += 1;
            clearObjectPreview();
            clearObjectSelectionForZone();
            setSelectedZone('');
        };
        const getObjectListItem = (node) => {
            const button = node?.closest?.('[data-warehouse-object-index]');
            return button && shell.zoneButtons.contains(button) ? visibleObjectItems[Number(button.dataset.warehouseObjectIndex)] : null;
        };
        const previewObjectListItem = (item) => {
            clearObjectPreview();
            if (!item) return;
            if (item.kind === 'zone') setHoveredZone(item.code);
            else if (item.kind === 'rack') setHoveredRack(item.value.rackData);
            else if (item.equipmentKind === 'barcode-tunnel') setHoveredBarcodeTunnel(item.value);
            else setHoveredAmr(item.value);
        };
        shell.zoneButtons.addEventListener('pointerover', event => {
            const item = getObjectListItem(event.target);
            if (item !== getObjectListItem(event.relatedTarget)) previewObjectListItem(item);
        }, { signal });
        shell.zoneButtons.addEventListener('pointerleave', clearObjectPreview, { signal });
        shell.zoneButtons.addEventListener('focusin', event => previewObjectListItem(getObjectListItem(event.target)), { signal });
        shell.zoneButtons.addEventListener('focusout', event => { if (!shell.zoneButtons.contains(event.relatedTarget)) clearObjectPreview(); }, { signal });
        shell.zoneButtons.addEventListener('click', event => {
            const item = getObjectListItem(event.target);
            if (!item) return;
            const deselect = isObjectSelected(item);
            clearPanelSelection();
            if (deselect) return;
            if (item.kind === 'zone') setSelectedZone(item.code);
            else if (item.kind === 'rack') {
                const rack = item.value.rackData;
                setSelectedRack(rack); setFocusedRack(rack); focusRackInCurrentView(rack); showSelection(rack);
            } else if (item.equipmentKind === 'barcode-tunnel') setSelectedBarcodeTunnel(item.value);
            else setSelectedAmr(item.value);
        }, { signal });
        shell.objectSearch.addEventListener('input', () => {
            clearObjectPreview();
            renderObjectList();
            shell.zoneButtons.scrollTop = 0;
        }, { signal });
        shell.objectOverview.addEventListener('click', () => {
            clearPanelSelection();
            shell.objectSearch.value = '';
            renderObjectList();
            applyCameraView('quarter');
            shell.objectOverview.focus();
            shell.zoneButtons.scrollTop = 0;
        }, { signal });
        renderObjectList();
        syncZoneVisualization();
        const cameraViewPresets = {
            quarter: { yaw: Math.PI / 4, pitch: Math.PI / 6, distanceScale: 1.08, targetY: 2.5 },
            top: { yaw: 0, pitch: Math.PI / 2 - 0.01, distanceScale: 1.82, targetY: 0 },
            front: { yaw: 0, pitch: 0.08, distanceScale: 1.08, targetY: 2.5 },
            side: { yaw: Math.PI / 2, pitch: 0.08, distanceScale: 1.08, targetY: 2.5 }
        };
        // Track alignment separately from the persistent selected-view button.
        // Manual rotation releases alignment; panning and zooming do not.
        let alignedCameraView = 'quarter';
        const getCameraViewPitch = (viewName) => {
            if (projectionMode === 'orthographic' && (viewName === 'front' || viewName === 'side')) return 0;
            return cameraViewPresets[viewName].pitch;
        };
        const setActiveCameraView = (viewName = '') => {
            shell.cameraViewButtons.forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.warehouseCameraView === viewName));
            });
        };
        const applyCameraView = (viewName) => {
            setSelectedAmr(null);
            cameraFocusTransitionToken += 1;
            const preset = cameraViewPresets[viewName] || cameraViewPresets.quarter;
            alignedCameraView = cameraViewPresets[viewName] ? viewName : 'quarter';
            yaw = preset.yaw;
            pitch = getCameraViewPitch(alignedCameraView);
            distance = sceneSpan * preset.distanceScale;
            target.set(cameraCenterX, warehouseFloorElevation + preset.targetY, cameraCenterZ);
            orthographicViewHeight = getPerspectiveViewHeight(distance);
            updateProjectionMatrices();
            updateCamera();
            setActiveCameraView(viewName);
            requestRender();
            renderer.domElement.focus();
        };
        restoreCameraAfterRackLevelClear = (rackData) => {
            applyCameraView('quarter');
            if (rackData) focusRackInCurrentView(rackData);
        };
        const showRackLevelSelection = (rackData, level) => {
            const entry = rackEntries.find((candidate) => candidate.rackData === rackData);
            const levelSlots = entry?.slots.filter((slot) => slot.level === level) || [];
            const occupiedSlots = levelSlots.filter((slot) => slot.occupied);
            const stockQuantity = occupiedSlots.reduce((total, slot) => total + Number(slot.stock?.quantity || 0), 0);
            const statusCounts = occupiedSlots.reduce((counts, slot) => {
                const status = String(slot.stock?.status || 'unknown').toLowerCase();
                counts[status] = (counts[status] || 0) + 1;
                return counts;
            }, {});
            const statusText = Object.entries(statusCounts)
                .map(([status, count]) => `${escapeHtml(status)} ${count}`)
                .join(' · ') || '적재 없음';
            shell.inspector.innerHTML = `<h5>${escapeHtml(rackData.rack.code)} · LV${level}</h5><dl><dt>선택 단</dt><dd>${level}단</dd><dt>전체 셀</dt><dd>${levelSlots.length}개</dd><dt>적재 셀</dt><dd>${occupiedSlots.length}개</dd><dt>빈 셀</dt><dd>${levelSlots.length - occupiedSlots.length}개</dd><dt>재고 수량</dt><dd>${stockQuantity}</dd><dt>재고 상태</dt><dd>${statusText}</dd></dl>`;
        };
        const focusRackLevelTopView = (rackData, level) => {
            const bounds = rackData?.focusBounds;
            if (!bounds) return;
            cameraFocusTransitionToken += 1;
            amrFocusTransition = null;
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const rackLevelHeight = mm(rackData.type.levelHeight)
                || mm(rackData.type.height) / Math.max(1, rackData.type.levels);
            const viewHeight = Math.max(1.2, size.z * 1.24, (size.x / Math.max(0.1, viewportAspect)) * 1.24);
            alignedCameraView = 'top';
            yaw = cameraViewPresets.top.yaw;
            pitch = getCameraViewPitch('top');
            target.set(center.x, warehouseFloorElevation + (level - 0.5) * rackLevelHeight, center.z);
            orthographicViewHeight = viewHeight;
            distance = Math.max(
                minimumCameraDistance,
                Math.min(maximumCameraDistance, viewHeight / (2 * Math.tan(perspectiveHalfFov)))
            );
            updateProjectionMatrices();
            updateCamera();
            setActiveCameraView('top');
            renderer.domElement.focus();
            requestRender();
        };
        const selectRackLevel = (levelData) => {
            const selectedLevel = setActiveRackLevelFocus(levelData);
            if (selectedLevel) {
                showRackLevelSelection(selectedLevel.rackData, selectedLevel.level);
                focusRackLevelTopView(selectedLevel.rackData, selectedLevel.level);
                return;
            }
            alignedCameraView = 'quarter';
            yaw = cameraViewPresets.quarter.yaw;
            pitch = getCameraViewPitch('quarter');
            updateCamera();
            setActiveCameraView('quarter');
            showSelection(levelData.rackData);
            focusRackInCurrentView(levelData.rackData);
        };
        shell.cameraViewButtons.forEach((button) => {
            button.addEventListener('click', () => applyCameraView(button.dataset.warehouseCameraView), { signal });
        });
        const applyProjectionMode = (nextMode) => {
            const normalizedMode = nextMode === 'orthographic' ? 'orthographic' : 'perspective';
            if (normalizedMode === projectionMode) return;
            if (amrFocusTransition) amrFocusTransition.zoomCancelled = true;
            cameraFocusTransitionToken += 1;
            if (normalizedMode === 'orthographic') {
                orthographicViewHeight = getPerspectiveViewHeight(distance);
                projectionMode = 'orthographic';
                camera = orthographicCamera;
            } else {
                distance = Math.max(
                    minimumCameraDistance,
                    Math.min(maximumCameraDistance, orthographicViewHeight / (2 * Math.tan(perspectiveHalfFov)))
                );
                projectionMode = 'perspective';
                camera = perspectiveCamera;
            }
            if (alignedCameraView) pitch = getCameraViewPitch(alignedCameraView);
            updateProjectionMatrices();
            updateCamera();
            updateProjectionToggle();
            requestRender();
        };
        shell.projectionToggle.addEventListener('click', () => {
            applyProjectionMode(projectionMode === 'perspective' ? 'orthographic' : 'perspective');
        }, { signal });
        updateProjectionToggle();
        shell.gridToggle.addEventListener('click', () => applyGridVisibility(!grid.visible), { signal });
        const legendsByMode = {
            utilization: [
                ['empty', '비어 있음'],
                ['low', '1~49%'],
                ['medium', '50~79%'],
                ['high', '80~100%'],
                ['unknown', '용량 미설정']
            ],
            status: [
                ['empty', '비어 있음'],
                ['normal', '정상'],
                ['warning', '주의'],
                ['hold', '보류'],
                ['defect', '불량'],
                ['unknown', '상태 미설정']
            ]
        };
        let viewMode = 'utilization';
        const applyViewMode = (nextMode) => {
            viewMode = nextMode === 'status' ? 'status' : 'utilization';
            slotMeshEntries.forEach(({ mesh, slots }) => {
                slots.forEach((slot, index) => {
                    const visualKey = getSlotVisualKey(slot, viewMode);
                    mesh.setColorAt(index, new THREE.Color(slotColorPalette[visualKey]));
                });
                if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            });
            shell.viewButtons.forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.warehouseView === viewMode));
            });
            shell.legendItems.innerHTML = legendsByMode[viewMode]
                .map(([key, label]) => `<span><i class="is-${key}"></i>${label}</span>`)
                .join('');
            requestRender();
        };
        shell.viewButtons.forEach((button) => {
            button.addEventListener('click', () => applyViewMode(button.dataset.warehouseView), { signal });
        });
        applyViewMode('utilization');
        const resize = () => {
            const viewportWidth = shell.viewport.clientWidth;
            const viewportHeight = shell.viewport.clientHeight;
            // A hidden menu panel reports a zero-sized viewport. Keeping the
            // last canvas size avoids changing the card height while hidden.
            if (!viewportWidth || !viewportHeight) return;
            const isPage = Boolean(shell.viewport.closest('.warehouse-page'));
            const width = Math.max(isPage ? 1 : 320, viewportWidth);
            const height = Math.max(isPage ? 1 : 360, viewportHeight);
            renderer.setSize(width, height, false);
            viewportAspect = width / height;
            updateProjectionMatrices();
            requestRender();
        };
        updateCamera();
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(shell.viewport);
        resize();

        let pointerStart;
        renderer.domElement.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 && event.button !== 2) return;
            event.preventDefault();
            cameraFocusTransitionToken += 1;
            setHoveredRack(null);
            setHoveredAmr(null);
            if (typeof setHoveredBarcodeTunnel === 'function') setHoveredBarcodeTunnel(null);
            // Preserve the current framing if a drag interrupts the focus animation.
            if (followedAmr) {
                amrFocusTransition = null;
                amrFollowOffset.copy(target).sub(followedAmr.group.position);
                amrFollowOffset.y -= 1.5;
            }
            const viewDirection = new THREE.Vector3();
            camera.getWorldDirection(viewDirection);
            viewDirection.y = 0;
            viewDirection.normalize();
            const viewRight = new THREE.Vector3().crossVectors(viewDirection, camera.up).normalize();
            pointerStart = {
                x: event.clientX,
                y: event.clientY,
                yaw,
                pitch,
                distance: getEquivalentCameraDistance(),
                target: target.clone(),
                amrPosition: followedAmr?.group.position.clone() || null,
                viewDirection,
                viewRight,
                mode: event.button === 2 ? 'rotate' : 'pan',
                button: event.button,
                pointerId: event.pointerId
            };
            renderer.domElement.setPointerCapture(event.pointerId);
        }, { signal });
        renderer.domElement.addEventListener('pointermove', (event) => {
            if (!pointerStart || event.pointerId !== pointerStart.pointerId) return;
            const deltaX = event.clientX - pointerStart.x;
            const deltaY = event.clientY - pointerStart.y;
            // A click keeps slot information; only a real camera drag clears hover.
            if (Math.hypot(deltaX, deltaY) > 5) setHoveredSlot(null);
            if (pointerStart.mode === 'rotate') {
                if (deltaX === 0 && deltaY === 0 && yaw === pointerStart.yaw && pitch === pointerStart.pitch) return;
                alignedCameraView = null;
                yaw = pointerStart.yaw - deltaX * 0.008;
                const minimumPitch = Math.min(pointerStart.pitch, projectionMode === 'orthographic' ? 0 : 0.02);
                pitch = Math.max(minimumPitch, Math.min(Math.PI / 2 - 0.02, pointerStart.pitch + deltaY * 0.006));
            } else {
                const panScale = Math.max(0.004, pointerStart.distance * 0.0015);
                target.copy(pointerStart.target);
                // Include movement since pointerdown so long drags do not lag behind the AMR.
                if (followedAmr && pointerStart.amrPosition) {
                    target.add(followedAmr.group.position).sub(pointerStart.amrPosition);
                }
                target.addScaledVector(pointerStart.viewRight, -deltaX * panScale);
                target.addScaledVector(pointerStart.viewDirection, deltaY * panScale);
                target.x = Math.max(0, Math.min(floorWidth, target.x));
                target.z = Math.max(0, Math.min(floorDepth, target.z));
                if (followedAmr) {
                    amrFollowOffset.copy(target).sub(followedAmr.group.position);
                    amrFollowOffset.y -= 1.5;
                }
            }
            updateCamera();
            requestRender();
        }, { signal });
        renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
        renderer.domElement.addEventListener('pointercancel', () => { pointerStart = null; }, { signal });
        renderer.domElement.addEventListener('wheel', (event) => {
            event.preventDefault();
            if (amrFocusTransition) amrFocusTransition.zoomCancelled = true;
            cameraFocusTransitionToken += 1;
            const zoomFactor = Math.exp(event.deltaY * 0.0012);
            if (projectionMode === 'orthographic') {
                const minimumViewHeight = getPerspectiveViewHeight(minimumCameraDistance);
                const maximumViewHeight = getPerspectiveViewHeight(maximumCameraDistance);
                orthographicViewHeight = Math.max(minimumViewHeight, Math.min(maximumViewHeight, orthographicViewHeight * zoomFactor));
                updateProjectionMatrices();
            } else {
                distance = Math.max(minimumCameraDistance, Math.min(maximumCameraDistance, distance * zoomFactor));
            }
            updateCamera();
            requestRender();
        }, { signal, passive: false });
        shell.root.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || (!followedAmr && !selectedZoneCode && !selectedRack && !selectedBarcodeTunnel)) return;
            event.preventDefault();
            clearPanelSelection();
        }, { signal });

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const isRaycastTargetVisible = (object) => {
            for (let node = object; node; node = node.parent) {
                if (!node.visible) return false;
            }
            return true;
        };
        const getSlotAtPointer = (event) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const hits = raycaster.intersectObjects(clickTargets, false).filter((hit) => isRaycastTargetVisible(hit.object));
            const hit = hits.find((candidate) => candidate.object.userData.kind === 'slotInstances');
            return hit && Number.isInteger(hit.instanceId) ? hit.object.userData.slots[hit.instanceId] || null : null;
        };
        const getBillboardAtPointer = (event) => {
            scene.updateMatrixWorld(true);
            camera.updateMatrixWorld(true);
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const hit = raycaster.intersectObjects([...levelLabelTargets, ...barcodeTunnelLabelTargets, ...labelTargets, ...amrLabelTargets], false).find((candidate) => isRaycastTargetVisible(candidate.object));
            return hit?.object.userData || null;
        };
        const getRackLevelLabelAtPointer = (event) => {
            const label = getBillboardAtPointer(event);
            return label?.kind === 'rack-level-label' ? label : null;
        };
        const getLabelRackAtPointer = (event) => {
            const label = getBillboardAtPointer(event);
            return label?.kind === 'rack' ? label : null;
        };
        const getLabelAmrAtPointer = (event) => {
            const label = getBillboardAtPointer(event);
            return label?.kind === 'amr-label' ? label.amr : null;
        };
        const getLabelBarcodeTunnelAtPointer = event => {
            const label = getBillboardAtPointer(event);
            return label?.kind === 'barcode-tunnel-label' ? label.barcodeTunnel : null;
        };
        const getBarcodeTunnelAtPointer = event => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const hit = raycaster.intersectObjects(barcodeTunnelTargets, false)
                .find(candidate => isRaycastTargetVisible(candidate.object));
            return hit?.object.userData?.barcodeTunnel || null;
        };
        const getRackAtPointer = (event) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const hits = raycaster.intersectObjects(clickTargets, false).filter((hit) => isRaycastTargetVisible(hit.object));
            return hits.find((candidate) => candidate.object.userData.kind === 'rack')?.object.userData || null;
        };
        const showSelection = (selection) => {
            resetInspectorLayout();
            if (selection.kind === 'slot') {
                const statusLabels = { normal: '정상', warning: '주의', hold: '보류', defect: '불량' };
                const capacity = Number(selection.stock?.capacity || selection.location?.capacity || 0);
                const quantity = Number(selection.stock?.quantity || 0);
                const rate = capacity > 0 ? Math.round((quantity / capacity) * 100) : null;
                const itemText = selection.item
                    ? `${escapeHtml(selection.item.code)} · ${escapeHtml(selection.item.name)}`
                    : '빈 슬롯';
                const statusText = selection.occupied
                    ? (statusLabels[String(selection.stock?.status || '').toLowerCase()] || '상태 미설정')
                    : '비어 있음';
                shell.inspector.innerHTML = `<h5>${escapeHtml(selection.locationCode)}</h5><dl><dt>품목</dt><dd>${itemText}</dd><dt>랙</dt><dd>${escapeHtml(selection.rack.code)} / ${escapeHtml(selection.zone?.name || selection.rack.zoneCode)}</dd><dt>셀 위치</dt><dd>${selection.rackRow}랙열 · ${selection.bay}베이 · ${selection.level}단 · 깊이 ${selection.depth}</dd><dt>수량</dt><dd>${quantity} / ${capacity || '미설정'}</dd><dt>적재율</dt><dd>${rate === null ? '용량 미설정' : `${rate}%`}</dd><dt>재고 상태</dt><dd>${escapeHtml(statusText)}</dd></dl>`;
            } else {
                const plan = selection.rack.floorPlan;
                const planInfo = plan
                    ? `<dt>평면도 범위</dt><dd>${plan.columns}칸 × ${plan.rows}칸 (${(plan.planLength / 1000).toFixed(2)}m × ${(plan.planWidth / 1000).toFixed(2)}m)</dd><dt>여유 공간</dt><dd>길이 ${(plan.remainingLength / 1000).toFixed(2)}m · 폭 ${(plan.remainingWidth / 1000).toFixed(2)}m</dd>`
                    : '';
                shell.inspector.innerHTML = `<h5>${escapeHtml(selection.rack.code)}</h5><dl><dt>구역</dt><dd>${escapeHtml(selection.rack.zoneCode)} · ${escapeHtml(selection.zone?.name || '')}</dd><dt>랙타입</dt><dd>${escapeHtml(selection.type.name)}</dd><dt>배치 기준</dt><dd>${selection.rack.layoutSource === 'floorPlan' ? '평면도' : '랙배치'}</dd><dt>구성</dt><dd>${selection.rack.rackRowCount}랙열 · ${selection.rack.bayCount}베이</dd><dt>단수·깊이</dt><dd>${selection.type.levels}단 · 깊이 ${Math.max(1, Number(selection.type.depthCount) || 1)}</dd><dt>실제 규격</dt><dd>${(selection.type.bayWidth * selection.rack.bayCount / 1000).toFixed(2)}m × ${(selection.type.depth * selection.rack.rackRowCount / 1000).toFixed(2)}m × ${(selection.type.height / 1000).toFixed(2)}m</dd>${planInfo}<dt>등록 재고</dt><dd>${(inventoryByRack.get(selection.rack.code) || []).length}개 로케이션</dd></dl>`;
            }
        };
        renderer.domElement.addEventListener('pointermove', (event) => {
            if (pointerStart) return;
            const rackLevelLabel = getRackLevelLabelAtPointer(event);
            setHoveredRackLevelLabel(rackLevelLabel);
            if (rackLevelLabel) {
                setHoveredSlot(null);
                setHoveredRack(null);
                setHoveredAmr(null);
                setHoveredBarcodeTunnel(null);
                return;
            }
            const barcodeTunnel = typeof getLabelBarcodeTunnelAtPointer === 'function'
                ? getLabelBarcodeTunnelAtPointer(event) || getBarcodeTunnelAtPointer(event)
                : null;
            setHoveredBarcodeTunnel(barcodeTunnel);
            if (barcodeTunnel) {
                setHoveredSlot(null);
                setHoveredRack(null);
                setHoveredAmr(null);
                return;
            }
            const labelAmr = getLabelAmrAtPointer(event);
            setHoveredAmr(labelAmr);
            if (labelAmr) {
                setHoveredSlot(null);
                setHoveredRack(null);
                return;
            }
            const labelRack = getLabelRackAtPointer(event);
            if (labelRack) {
                setHoveredSlot(null);
                setHoveredRack(labelRack);
                return;
            }
            const slot = getSlotAtPointer(event);
            setHoveredSlot(slot);
            setHoveredRack(slot ? null : getRackAtPointer(event));
        }, { signal });
        renderer.domElement.addEventListener('pointerleave', () => {
            setHoveredRackLevelLabel(null);
            setHoveredSlot(null);
            setHoveredRack(null);
            setHoveredAmr(null);
            setHoveredBarcodeTunnel(null);
        }, { signal });
        renderer.domElement.addEventListener('pointerup', (event) => {
            if (!pointerStart || event.pointerId !== pointerStart.pointerId) return;
            const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
            const button = pointerStart.button;
            pointerStart = null;
            if (button !== 0 || moved > 5) return;
            const rackLevelLabel = getRackLevelLabelAtPointer(event);
            if (rackLevelLabel) {
                setSelectedZone('', false);
                setSelectedSlot(null);
                setHoveredSlot(null);
                setHoveredRack(null);
                setSelectedAmr(null);
                if (typeof setSelectedBarcodeTunnel === 'function') setSelectedBarcodeTunnel(null);
                selectRackLevel(rackLevelLabel);
                return;
            }
            const barcodeTunnel = typeof getLabelBarcodeTunnelAtPointer === 'function'
                ? getLabelBarcodeTunnelAtPointer(event) || getBarcodeTunnelAtPointer(event)
                : null;
            if (barcodeTunnel) {
                setSelectedZone('', false);
                setSelectedSlot(null);
                setHoveredSlot(null);
                setHoveredRack(null);
                setSelectedRack(null);
                setFocusedRack(null);
                setSelectedAmr(null);
                setSelectedBarcodeTunnel(barcodeTunnel);
                renderer.domElement.focus();
                return;
            }
            if (typeof setSelectedBarcodeTunnel === 'function') setSelectedBarcodeTunnel(null);
            const labelAmr = getLabelAmrAtPointer(event);
            if (labelAmr) {
                setSelectedZone('', false);
                setSelectedSlot(null);
                setHoveredSlot(null);
                setHoveredRack(null);
                setSelectedRack(null);
                setFocusedRack(null);
                showDefaultInspector();
                setSelectedAmr(labelAmr);
                renderer.domElement.focus();
                return;
            }
            setSelectedAmr(null);
            const labelRack = getLabelRackAtPointer(event);
            if (labelRack) {
                setSelectedZone('', false);
                setSelectedSlot(null);
                setHoveredSlot(null);
                setSelectedRack(labelRack);
                setFocusedRack(labelRack);
                focusRackInCurrentView(labelRack);
                showSelection(labelRack);
                return;
            }
            const slot = getSlotAtPointer(event);
            if (slot) { setSelectedZone('', false); setHoveredSlot(slot); setSelectedSlot(slot); setSelectedRack(null); setFocusedRack(null); showSelection(slot); return; }
            setHoveredSlot(null);
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const hits = raycaster.intersectObjects(clickTargets, false).filter((hit) => isRaycastTargetVisible(hit.object));
            const hit = hits[0];
            if (hit?.object.userData?.kind) { setSelectedZone('', false); setSelectedSlot(null); setFocusedRack(null); setSelectedRack(hit.object.userData); showSelection(hit.object.userData); }
            else { setSelectedZone('', false); setSelectedSlot(null); setSelectedRack(null); setFocusedRack(null); showDefaultInspector(); }
        }, { signal });

        const applyFilters = () => {
            rackEntries.forEach((entry) => { entry.group.visible = true; });
            shell.syncObjectSelection();
            requestRender();
        };
        applyFilters();
        requestRender();

        return () => {
            destroyed = true;
            followedAmr = null;
            hoveredAmr = null;
            amrFocusTransition = null;
            activeWorldUiTransitions.clear();
            if (animationFrame) cancelAnimationFrame(animationFrame);
            resizeObserver.disconnect();
            geometryCache.forEach((geometry) => geometry.dispose());
            operations?.dispose?.();
            outlineGeometryCache.forEach((geometry) => geometry.dispose());
            outlineTubeGeometryCache.forEach((geometry) => geometry.dispose());
            materialCache.forEach((material) => material.dispose());
            transportCargoResources.forEach(resource => resource.dispose());
            dimmedMaterialCache.forEach((material) => material.dispose());
            rackHoverMaterial.dispose();
            rackSelectedMaterial.dispose();
            hoverOutline.userData.material.dispose();
            selectedOutline.userData.material.dispose();
            passageBoundaryGeometry?.dispose();
            passageBoundaryMaterial?.dispose();
            conveyorBoundaryGeometry?.dispose();
            conveyorBoundaryMaterial?.dispose();
            conveyorModel.resources.forEach((resource) => resource.dispose());
            barcodeTunnelModel.resources.forEach((resource) => resource.dispose());
            dockBoundaryGeometry?.dispose();
            dockBoundaryMaterial?.dispose();
            bufferBoundaryGeometry?.dispose();
            bufferBoundaryMaterial?.dispose();
            enclosureResources.forEach((resource) => resource.dispose());
            floor.geometry.dispose();
            floor.material.dispose();
            loadingYard?.geometry.dispose();
            loadingYard?.material.dispose();
            truckResources.forEach((resource) => resource.dispose());
            amrResources.forEach((resource) => resource.dispose());
            shuttleResources.forEach((resource) => resource.dispose());
            zoneVisualizationEntries.forEach(({ geometry, material }) => { geometry.dispose(); material.dispose(); });
            scene.traverse((object) => {
                if (object.material?.map) object.material.map.dispose();
                if (object.type === 'Sprite' && object.material) object.material.dispose();
            });
            renderer.dispose();
            floorReflectionEnvironment.dispose();
        };
    }

    async function mount(container, options = {}) {
        mountedControllers.get(container)?.dispose();
        const abortController = new AbortController();
        const shell = createShell(container);
        const disposePanelResizing = setupPanelResizing(shell, abortController.signal);
        const updateCurrentTime = () => {
            const now = new Date();
            shell.currentTime.dateTime = now.toISOString();
            shell.currentTime.textContent = formatLocalDateTime(now);
        };
        updateCurrentTime();
        const currentTimeTimer = setInterval(updateCurrentTime, 1000);
        let disposeScene = () => {};
        const controller = {
            dispose() {
                disposePanelResizing();
                clearInterval(currentTimeTimer);
                abortController.abort();
                disposeScene();
                mountedControllers.delete(container);
            }
        };
        mountedControllers.set(container, controller);
        const syncFullscreenButton = () => {
            const active = document.fullscreenElement === container;
            const label = active ? '전체화면 종료' : '전체화면';
            shell.fullscreen.setAttribute('aria-label', label);
            if (!shell.fullscreen.disabled) shell.fullscreen.title = label;
            shell.fullscreen.setAttribute('aria-pressed', String(active));
        };
        shell.fullscreen.disabled = !document.fullscreenEnabled || typeof container.requestFullscreen !== 'function';
        if (shell.fullscreen.disabled) shell.fullscreen.title = '이 브라우저에서는 전체화면을 사용할 수 없습니다.';
        shell.fullscreen.addEventListener('click', async () => {
            try {
                if (document.fullscreenElement === container) await document.exitFullscreen();
                else await container.requestFullscreen({ navigationUI: 'hide' });
            } catch (error) {
                shell.fullscreen.title = `전체화면을 열지 못했습니다. — ${error?.message || '브라우저 권한을 확인해 주세요.'}`;
            }
        }, { signal: abortController.signal });
        document.addEventListener('fullscreenchange', syncFullscreenButton, { signal: abortController.signal });
        syncFullscreenButton();
        options.onShell?.(container);
        if (options.loadData) {
            shell.reload.hidden = false;
            shell.reload.addEventListener('click', async () => {
                shell.reload.disabled = true;
                try { if(options.onReload)await options.onReload();else await mount(container, options); }
                catch(error) { shell.reload.title='기준정보 새로고침 실패: '+error.message; }
                finally { shell.reload.disabled=false; }
            }, { signal: abortController.signal });
        }
        try {
            const [THREE] = await Promise.all([loadThree(), loadOperations(), loadBarcodeTunnels()]);
            if (typeof options.loadData !== 'function') throw new Error('로컬 기준정보 연결을 확인하세요.');
            const data = await options.loadData(abortController.signal);
            const errors = validateWarehouseData(data);
            if (errors.length) {
                showError(shell, errors.slice(0, 8));
                return controller;
            }
            if (abortController.signal.aborted || !container.isConnected) return controller;
            // The bottom panel is intentionally empty; retain nonfatal diagnostics in the console only.
            const warnings = [...(data.meta?.warnings || []), data.meta?.equipmentLoadWarning, data.meta?.equipmentStatusLoadWarning,
                ...(data.meta?.layoutErrors || []), ...(data.meta?.unmappedFloorRackCodes || []),
                ...(data.meta?.unplacedRackCodes || []), ...(data.meta?.outOfRangeLocationCodes || [])].filter(Boolean);
            if (warnings.length) console.warn('[3D 창고 기준정보]', warnings);
            if (data.meta?.source === 'drawing') {
                const brand=container.querySelector('.warehouse-3d-brand-copy');
                brand.querySelector('strong').textContent=data.meta.name;
                brand.querySelector('small').textContent='평면도 + 로컬 기준 정보';
                const details=document.createElement('details');details.className='warehouse-drawing-warnings';
                const summary=document.createElement('summary');summary.textContent=warnings.length?'연결 확인 '+warnings.length+'건':'도면 연결 정상';details.append(summary);
                for(const warning of warnings){const line=document.createElement('p');line.textContent=String(warning);details.append(line);}
                shell.viewport.closest('.warehouse-3d-shell').querySelector('.warehouse-3d-bottom-panel').append(details);
                shell.viewport.dataset.drawingName=data.meta.name;
            }
            disposeScene = startWarehouseScene(THREE, shell, data, abortController.signal);
        } catch (error) {
            if (error?.name !== 'AbortError') showError(shell, [error?.message || '알 수 없는 오류가 발생했습니다.', '기준정보 내용과 로컬 3D 파일을 확인해 주세요.']);
        }
        return controller;
    }

    function disposeWithin(root) {
        root?.querySelectorAll?.('.warehouse-3d-shell').forEach((container) => mountedControllers.get(container)?.dispose());
    }

    window.wmsWarehouse3D = Object.freeze({
        mount,
        disposeWithin,
        validateWarehouseData,
        parseCsv,
        parseEquipmentMaster,
        parseEquipmentStatus,
        getFloorPlanAxisRange,
        convertGoogleSheetCsv,
        calculateZoneFloorBounds,
        calculateLoadingDockLayouts,
        calculateLoadingDockLayout,
        calculateLoadingYardLayout,
        calculateTruckYardPlacement,
        getRackDepthFramePositions,
        getWarehouseStructureOcclusion,
        buildPassageBoundarySegments,
        buildConveyorLayout,
        createConveyorModel,
        groupConnectedFloorCells,
        calculateAmrPassageClearanceMm,
        buildAmrCorridorAssignments,
        buildShuttleRailLayout,
        calculateShuttleFootprintMm,
        calculateShuttleLoadDimensions,
        calculateLiftFrameDimensions,
        buildOrthogonalConnectorPath,
        calculateShuttleLevelElevations,
        buildShuttleFrameLayout,
        buildPassageNavigationGraph,
        findPassagePath,
        findNearestPassageNode,
        getForkTargetHeight,
        getForkliftTaskSequence,
        calculateRackFocusView,
        getSlotVisualKey,
        getCartonStackLayout,
        googleTableToCsv
    });
    window.dispatchEvent(new Event('wms-warehouse-3d-ready'));
}());
