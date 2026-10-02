const assert = require('node:assert/strict');
const seed = require('../data/wms-reference-seed.json');
const ExcelJS = require('../vendor/exceljs.min.js');
const codec = require('../js/floor-plan-reference-file.js');
const model = require('../js/floor-plan-reference-model.js');

(async () => {
  assert.equal(codec.fileName('내 기준정보', 'tbl'), '내 기준정보.tbl');
  assert.equal(codec.fileName('내 기준정보.xlsx', 'tbl'), '내 기준정보.tbl');
  assert.equal(codec.fileName('자료.v1', 'xlsx'), '자료.v1.xlsx');
  assert.throws(() => codec.fileName('CON', 'tbl'), /예약된 이름/);
  assert.throws(() => codec.fileName('../bad', 'tbl'), /사용할 수 없는/);
  assert.deepEqual(codec.parseTbl(codec.serializeTbl(seed)), seed);
  const sized = model.copy(seed);
  sized.sheets[0] = model.setSize(model.setSize(sized.sheets[0], 'column', 1, 420), 'row', 2, 68);
  assert.deepEqual(codec.parseTbl(codec.serializeTbl(sized)).sheets[0].columnWidths, [[1, 420]]);
  assert.deepEqual(codec.parseTbl(codec.serializeTbl(sized)).sheets[0].rowHeights, [[2, 68]]);
  assert.throws(() => codec.parseTbl('{'), /JSON/);
  assert.throws(() => codec.parseTbl(JSON.stringify({ format: 'wrong', version: 1, book: seed })), /\.tbl/);

  const binary = await codec.exportExcel(seed, ExcelJS);
  const restored = await codec.importExcel(binary, ExcelJS);
  assert.equal(restored.sheets.length, seed.sheets.length);
  for (let index = 0; index < seed.sheets.length; index++) {
    const original = seed.sheets[index], imported = restored.sheets[index];
    assert.equal(imported.name, original.name);
    assert.equal(imported.rows, original.rows);
    assert.equal(imported.columns, original.columns);
    assert.deepEqual(imported.cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]), original.cells.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
  const sizedExcel = await codec.importExcel(await codec.exportExcel(sized, ExcelJS), ExcelJS);
  assert.deepEqual(sizedExcel.sheets[0].columnWidths, [[1, 420]]);
  assert.deepEqual(sizedExcel.sheets[0].rowHeights, [[2, 68]]);

  const external = new ExcelJS.Workbook();
  const sheet = external.addWorksheet('외부 시트');
  sheet.getCell('A1').value = '문자';
  sheet.getCell('B2').value = 12.5;
  sheet.getCell('C3').value = { formula: '1+2', result: 3 };
  const externalBook = await codec.importExcel(await external.xlsx.writeBuffer(), ExcelJS);
  assert.deepEqual(externalBook.sheets, [{ name: '외부 시트', rows: 3, columns: 3, cells: [[1, 1, '문자'], [2, 2, '12.5'], [3, 3, '3']] }]);
  await assert.rejects(codec.importExcel(new Uint8Array([1, 2, 3]), ExcelJS), /Excel/);
  console.log('floor-plan-reference-file: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
