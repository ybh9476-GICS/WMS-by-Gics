(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.WmsFloorPlanReferenceModel = model;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const maximumRows = 10000;
  const maximumColumns = 1000;
  const maximumCellLength = 20000;
  const sizeRanges = { row: [30, 400], column: [96, 1000] };

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function validIndex(value, maximum, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error(label + ' 위치가 올바르지 않습니다.');
  }
  function validateSheet(sheet) {
    if (!sheet || typeof sheet.name !== 'string' || !sheet.name || !Array.isArray(sheet.cells)) throw Error('기준정보 시트가 올바르지 않습니다.');
    validIndex(sheet.rows, maximumRows, '행');
    validIndex(sheet.columns, maximumColumns, '열');
    const seen = new Set();
    for (const entry of sheet.cells) {
      if (!Array.isArray(entry) || entry.length !== 3) throw Error('셀 데이터가 올바르지 않습니다.');
      validIndex(entry[0], sheet.rows, '행');
      validIndex(entry[1], sheet.columns, '열');
      if (typeof entry[2] !== 'string' || entry[2].length > maximumCellLength) throw Error('셀 값이 올바르지 않습니다.');
      const key = entry[0] + ':' + entry[1];
      if (seen.has(key)) throw Error('중복된 셀 위치가 있습니다.');
      seen.add(key);
    }
    for (const [axis, field, limit] of [['row', 'rowHeights', sheet.rows], ['column', 'columnWidths', sheet.columns]]) {
      if (sheet[field] === undefined) continue;
      if (!Array.isArray(sheet[field])) throw Error('행·열 크기 정보가 올바르지 않습니다.');
      const sized = new Set();
      for (const entry of sheet[field]) {
        if (!Array.isArray(entry) || entry.length !== 2) throw Error('행·열 크기 정보가 올바르지 않습니다.');
        validIndex(entry[0], limit, axis === 'row' ? '행' : '열');
        if (!Number.isSafeInteger(entry[1]) || entry[1] < sizeRanges[axis][0] || entry[1] > sizeRanges[axis][1] || sized.has(entry[0])) {
          throw Error('행·열 크기 정보가 올바르지 않습니다.');
        }
        sized.add(entry[0]);
      }
    }
    return sheet;
  }
  function validate(book) {
    if (!book || book.schemaVersion !== 1 || !Array.isArray(book.sheets) || !book.sheets.length) throw Error('기준정보 파일 형식이 올바르지 않습니다.');
    const names = new Set();
    for (const sheet of book.sheets) {
      validateSheet(sheet);
      if (names.has(sheet.name)) throw Error('중복된 시트 이름이 있습니다.');
      names.add(sheet.name);
    }
    return book;
  }
  function cell(sheet, row, column) {
    validateSheet(sheet);
    validIndex(row, sheet.rows, '행');
    validIndex(column, sheet.columns, '열');
    return sheet.cells.find(entry => entry[0] === row && entry[1] === column)?.[2] ?? '';
  }
  function setCell(sheet, row, column, value) {
    validIndex(row, sheet.rows, '행');
    validIndex(column, sheet.columns, '열');
    value = String(value);
    if (value.length > maximumCellLength) throw Error('셀 값은 20,000자 이하로 입력하세요.');
    const next = copy(sheet);
    const index = next.cells.findIndex(entry => entry[0] === row && entry[1] === column);
    if (value === '') {
      if (index >= 0) next.cells.splice(index, 1);
    } else if (index >= 0) next.cells[index][2] = value;
    else next.cells.push([row, column, value]);
    return next;
  }
  function setSize(sheet, axis, index, pixels) {
    const field = axis === 'row' ? 'rowHeights' : axis === 'column' ? 'columnWidths' : null;
    if (!field) throw Error('행 또는 열을 선택하세요.');
    validIndex(index, axis === 'row' ? sheet.rows : sheet.columns, axis === 'row' ? '행' : '열');
    if (!Number.isSafeInteger(pixels) || pixels < sizeRanges[axis][0] || pixels > sizeRanges[axis][1]) throw Error('행·열 크기가 올바르지 않습니다.');
    const next = copy(sheet);
    next[field] = (next[field] || []).filter(entry => entry[0] !== index);
    next[field].push([index, pixels]);
    next[field].sort((a, b) => a[0] - b[0]);
    return next;
  }
  function insert(sheet, axis, before, count = 1) {
    const field = axis === 'row' ? 'rows' : axis === 'column' ? 'columns' : null;
    if (!field) throw Error('행 또는 열을 선택하세요.');
    validIndex(before, sheet[field] + 1, field === 'rows' ? '행' : '열');
    validIndex(count, 100, '추가 개수');
    if (sheet[field] + count > (field === 'rows' ? maximumRows : maximumColumns)) throw Error('시트 크기 제한을 초과합니다.');
    const next = copy(sheet), offset = field === 'rows' ? 0 : 1;
    for (const entry of next.cells) if (entry[offset] >= before) entry[offset] += count;
    const sizeField = axis === 'row' ? 'rowHeights' : 'columnWidths';
    for (const entry of next[sizeField] || []) if (entry[0] >= before) entry[0] += count;
    next[field] += count;
    return next;
  }
  function remove(sheet, axis, first, count = 1) {
    const field = axis === 'row' ? 'rows' : axis === 'column' ? 'columns' : null;
    if (!field) throw Error('행 또는 열을 선택하세요.');
    validIndex(first, sheet[field], field === 'rows' ? '행' : '열');
    validIndex(count, 100, '삭제 개수');
    if (first + count - 1 > sheet[field] || sheet[field] <= count) throw Error('마지막 행이나 열은 삭제할 수 없습니다.');
    const next = copy(sheet), offset = field === 'rows' ? 0 : 1;
    next.cells = next.cells.filter(entry => entry[offset] < first || entry[offset] >= first + count);
    for (const entry of next.cells) if (entry[offset] >= first + count) entry[offset] -= count;
    const sizeField = axis === 'row' ? 'rowHeights' : 'columnWidths';
    if (next[sizeField]) {
      next[sizeField] = next[sizeField].filter(entry => entry[0] < first || entry[0] >= first + count);
      for (const entry of next[sizeField]) if (entry[0] >= first + count) entry[0] -= count;
    }
    next[field] -= count;
    return next;
  }
  function removeIndices(sheet, axis, indices) {
    if (!Array.isArray(indices) || !indices.length) throw Error('삭제할 행 또는 열을 선택하세요.');
    const unique = [...new Set(indices)].sort((a, b) => b - a);
    let next = sheet;
    for (const index of unique) next = remove(next, axis, index);
    return next;
  }
  function removeSheet(book, index) {
    validate(book);
    if (!Number.isSafeInteger(index) || index < 0 || index >= book.sheets.length) throw Error('삭제할 시트를 선택하세요.');
    if (book.sheets.length === 1) throw Error('마지막 시트는 삭제할 수 없습니다.');
    const next = copy(book);
    next.sheets.splice(index, 1);
    return validate(next);
  }
  function columnName(number) {
    let value = number, name = '';
    while (value > 0) {
      value--;
      name = String.fromCharCode(65 + value % 26) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }
  return { validate, validateSheet, cell, setCell, setSize, insert, remove, removeIndices, removeSheet, columnName, copy };
});
