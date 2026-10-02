(function () {
  'use strict';
  const definitions = {
    rackTypes: ['랙타입 마스터', 'A4:H'], zones: ['구역설정', 'A4:D'],
    racks: ['랙배치', 'A4:I'], locations: ['로케이션 마스터', 'A4:F'],
    items: ['품목 마스터', 'A4:C'], inventory: ['재고 현황', 'A4:D'],
    workOrders: ['작업지시', 'A1:R']
  };
  function columnNumber(label) {
    return [...label].reduce((number, character) => number * 26 + character.charCodeAt(0) - 64, 0);
  }
  function sheetCsv(book, name, range) {
    const sheet = book.sheets.find(item => item.name === name);
    if (!sheet) throw Error('기준정보에 ' + name + ' 시트가 없습니다.');
    const match = /^([A-Z]+)(\d+):([A-Z]*)(\d*)$/.exec(range);
    if (!match) throw Error('기준정보 범위가 올바르지 않습니다.');
    const firstColumn = columnNumber(match[1]), firstRow = Number(match[2]);
    const lastColumn = Math.min(sheet.columns, match[3] ? columnNumber(match[3]) : sheet.columns);
    const lastRow = Math.min(sheet.rows, match[4] ? Number(match[4]) : sheet.rows);
    const cells = new Map(sheet.cells.map(([row, column, value]) => [row + ':' + column, value]));
    const escape = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const rows = [];
    for (let row = firstRow; row <= lastRow; row++) {
      const values = [];
      for (let column = firstColumn; column <= lastColumn; column++) values.push(escape(cells.get(row + ':' + column)));
      rows.push(values.join(','));
    }
    return rows.join('\n');
  }
  function records(api, csv) {
    const [headers = [], ...rows] = api.parseCsv(csv);
    return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  }
  function convert(book) {
    const api = window.wmsWarehouse3D;
    const floorPlanAxis = api.getFloorPlanAxisRange(sheetCsv(book, '평면도', 'A3:3'), sheetCsv(book, '평면도', 'A3:A'));
    const csv = Object.fromEntries(Object.entries(definitions).map(([key, [name, range]]) => [key, sheetCsv(book, name, range)]));
    csv.floorPlan = sheetCsv(book, '평면도', floorPlanAxis.range);
    const data = api.convertGoogleSheetCsv(csv, { floorPlanCellSizeMeters: 0.5, floorPlanAxis });
    data.meta.source = 'localReference';
    delete data.meta.documentId;
    const optional = (property, warning, name, range, parse) => {
      try { data[property] = parse(sheetCsv(book, name, range)); }
      catch (error) { data[property] = []; data.meta[warning] = name + ': ' + error.message; }
    };
    optional('equipment', 'equipmentLoadWarning', '설비 마스터', 'A1:F1000', api.parseEquipmentMaster);
    optional('equipmentStatuses', 'equipmentStatusLoadWarning', '설비 상태 정보', 'A2:O1000', api.parseEquipmentStatus);
    optional('operationRoutes', 'operationWarning', '운영 경로', 'A1:I500', csv => window.WmsWarehouseOperations.parseRoutes(records(api, csv)));
    data.meta.truckSchedules.forEach(schedule => {
      const route = data.operationRoutes.find(route => route.enabled && route.code === schedule.routeCode);
      if (route) { schedule.dockCode = route.dock; schedule.workType = route.direction; }
    });
    return data;
  }
  async function load(signal) {
    const saved = await window.WmsFloorPlanReferenceStore.load();
    if (signal?.aborted) throw new DOMException('요청이 취소되었습니다.', 'AbortError');
    return convert(saved.book);
  }
  window.WmsWarehouseLocalData = { load, convert, sheetCsv };
})();
