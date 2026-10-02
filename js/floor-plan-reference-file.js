(function (root, factory) {
  const codec = factory(typeof module === 'object' && module.exports ? require('./floor-plan-reference-model.js') : root.WmsFloorPlanReferenceModel);
  if (typeof module === 'object' && module.exports) module.exports = codec;
  if (root) root.WmsFloorPlanReferenceFile = codec;
})(typeof window === 'undefined' ? null : window, function (model) {
  'use strict';
  const format = 'wms-by-gics-reference-table';
  const metadataName = '__WMS_GICS_META__';
  const maximumCells = 250000;

  function fileName(value, extension) {
    if (!['tbl', 'xlsx'].includes(extension)) throw Error('저장할 파일 형식이 올바르지 않습니다.');
    let name = String(value ?? '').trim().replace(/\.(tbl|xlsx)$/i, '');
    if (!name || name === '.' || name === '..') throw Error('파일 이름을 입력하세요.');
    if (name.length > 150) throw Error('파일 이름은 150자 이하로 입력하세요.');
    if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) {
      throw Error('파일 이름에 사용할 수 없는 문자나 예약된 이름이 있습니다.');
    }
    return name + '.' + extension;
  }

  function check(book) {
    model.validate(book);
    if (book.sheets.reduce((total, sheet) => total + sheet.cells.length, 0) > maximumCells) {
      throw Error('기준정보 셀은 파일당 250,000개 이하로 가져오세요.');
    }
    return book;
  }
  function serializeTbl(book) {
    return JSON.stringify({ format, version: 1, book: check(book) });
  }
  function parseTbl(source) {
    let data;
    try { data = JSON.parse(source); }
    catch { throw Error('.tbl 파일의 JSON 내용을 읽을 수 없습니다.'); }
    if (data?.format !== format || data.version !== 1) throw Error('WMS by Gics 기준정보 .tbl 파일이 아닙니다.');
    return check(data.book);
  }
  function displayedValue(cell) {
    const value = cell.value;
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
      if (value.text != null) return String(value.text);
      if (value.result != null) return String(value.result);
      return '';
    }
    return String(value);
  }
  async function exportExcel(book, ExcelJS) {
    check(book);
    if (!ExcelJS?.Workbook) throw Error('Excel 파일 모듈을 불러오지 못했습니다.');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WMS by Gics';
    for (const sheet of book.sheets) {
      if (sheet.name === metadataName) throw Error('시트 이름 ' + metadataName + '은 Excel 내보내기에 사용할 수 없습니다.');
      const worksheet = workbook.addWorksheet(sheet.name);
      for (const [row, column, value] of sheet.cells) worksheet.getCell(row, column).value = value;
      for (const [column, pixels] of sheet.columnWidths || []) worksheet.getColumn(column).width = (pixels - 5) / 7;
      for (const [row, pixels] of sheet.rowHeights || []) worksheet.getRow(row).height = pixels * 0.75;
    }
    const meta = workbook.addWorksheet(metadataName);
    meta.getCell('A1').value = format;
    book.sheets.forEach((sheet, i) => {
      meta.getCell(i + 2, 1).value = sheet.name;
      meta.getCell(i + 2, 2).value = sheet.rows;
      meta.getCell(i + 2, 3).value = sheet.columns;
      if (sheet.columnWidths?.length) meta.getCell(i + 2, 4).value = JSON.stringify(sheet.columnWidths);
      if (sheet.rowHeights?.length) meta.getCell(i + 2, 5).value = JSON.stringify(sheet.rowHeights);
    });
    meta.state = 'veryHidden';
    return workbook.xlsx.writeBuffer();
  }
  async function importExcel(buffer, ExcelJS) {
    if (!ExcelJS?.Workbook) throw Error('Excel 파일 모듈을 불러오지 못했습니다.');
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(buffer); }
    catch { throw Error('Excel .xlsx 파일을 읽을 수 없습니다. 올바른 파일인지 확인하세요.'); }
    const meta = workbook.getWorksheet(metadataName);
    const dimensions = new Map();
    if (meta?.getCell('A1').value === format) {
      for (let row = 2; row <= meta.rowCount; row++) {
        const name = meta.getCell(row, 1).value;
        if (typeof name === 'string') dimensions.set(name, {
          rows: Number(meta.getCell(row, 2).value), columns: Number(meta.getCell(row, 3).value),
          columnWidths: meta.getCell(row, 4).value, rowHeights: meta.getCell(row, 5).value
        });
      }
    }
    const sheets = [];
    for (const worksheet of workbook.worksheets) {
      if (worksheet === meta && meta.getCell('A1').value === format) continue;
      const cells = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          const value = displayedValue(cell);
          if (value !== '') cells.push([rowNumber, columnNumber, value]);
        });
      });
      const dimension = dimensions.get(worksheet.name);
      const maxRow = cells.reduce((value, cell) => Math.max(value, cell[0]), 1);
      const maxColumn = cells.reduce((value, cell) => Math.max(value, cell[1]), 1);
      const sheet = { name: worksheet.name, rows: Math.max(maxRow, dimension?.rows || 1), columns: Math.max(maxColumn, dimension?.columns || 1), cells };
      if (dimension?.columnWidths) sheet.columnWidths = JSON.parse(dimension.columnWidths);
      if (dimension?.rowHeights) sheet.rowHeights = JSON.parse(dimension.rowHeights);
      sheets.push(sheet);
    }
    return check({ schemaVersion: 1, sheets });
  }
  return { fileName, serializeTbl, parseTbl, exportExcel, importExcel };
});
