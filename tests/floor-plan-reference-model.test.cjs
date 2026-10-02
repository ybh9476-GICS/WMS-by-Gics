const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const model = require('../js/floor-plan-reference-model.js');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'data/wms-reference-seed.json'), 'utf8'));
model.validate(seed);
assert.equal(seed.sheets.length, 13);
assert.equal(seed.sheets.find(sheet => sheet.name === '랙타입 마스터').cells[0][2], '랙타입 마스터');
assert.equal(seed.sheets.find(sheet => sheet.name === '평면도').columns, 115);

const original = { name: '테스트', rows: 4, columns: 4, cells: [[1, 1, 'A'], [2, 2, 'B'], [3, 3, 'C'], [4, 4, 'D']] };
const edited = model.setCell(original, 2, 2, '바뀜');
assert.equal(model.cell(edited, 2, 2), '바뀜');
assert.equal(model.cell(original, 2, 2), 'B');
const sized = model.setSize(model.setSize(original, 'column', 2, 260), 'row', 2, 72);
assert.deepEqual(sized.columnWidths, [[2, 260]]);
assert.deepEqual(sized.rowHeights, [[2, 72]]);
assert.equal(original.columnWidths, undefined);
assert.deepEqual(model.insert(sized, 'column', 2).columnWidths, [[3, 260]]);
assert.deepEqual(model.insert(sized, 'row', 2).rowHeights, [[3, 72]]);
assert.deepEqual(model.remove(sized, 'column', 2).columnWidths, []);
assert.deepEqual(model.remove(sized, 'row', 2).rowHeights, []);
assert.throws(() => model.setSize(original, 'column', 1, 20), /크기/);
assert.throws(() => model.validateSheet({ ...original, columnWidths: [[1, 200], [1, 300]] }), /크기/);
const insertedRow = model.insert(original, 'row', 2);
assert.equal(insertedRow.rows, 5);
assert.equal(model.cell(insertedRow, 3, 2), 'B');
const insertedColumn = model.insert(original, 'column', 2);
assert.equal(insertedColumn.columns, 5);
assert.equal(model.cell(insertedColumn, 2, 3), 'B');
const removedRows = model.removeIndices(original, 'row', [2, 4]);
assert.equal(removedRows.rows, 2);
assert.equal(model.cell(removedRows, 2, 3), 'C');
const removedColumns = model.removeIndices(original, 'column', [1, 3]);
assert.equal(removedColumns.columns, 2);
assert.equal(model.cell(removedColumns, 2, 1), 'B');
assert.throws(() => model.removeIndices(original, 'row', [1, 2, 3, 4]), /마지막/);
const withoutSecondSheet = model.removeSheet(seed, 1);
assert.equal(withoutSecondSheet.sheets.length, 12);
assert.equal(withoutSecondSheet.sheets.some(sheet => sheet.name === seed.sheets[1].name), false);
assert.equal(seed.sheets.length, 13);
assert.throws(() => model.removeSheet({ schemaVersion: 1, sheets: [original] }, 0), /마지막/);
assert.throws(() => model.removeSheet(seed, -1), /시트를 선택/);
assert.equal(model.columnName(27), 'AA');

const values = new Map([['wms-floor-plan-editor-draft-v2:test', 'original drawing']]);
const localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value)
};
const window = {
  WmsFloorPlanReferenceModel: model,
  localStorage,
  WMS_REFERENCE_SEED: seed
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'js/floor-plan-reference-store.js'), 'utf8'), { window });
(async () => {
  const store = window.WmsFloorPlanReferenceStore;
  const initial = await store.load();
  assert.equal(initial.source, 'seed');
  assert.equal(initial.name, '새 기준정보');
  values.set(store.key, JSON.stringify({ schemaVersion: 1, revision: 'legacy', book: seed }));
  assert.equal((await store.load()).name, '새 기준정보');
  values.delete(store.key);
  const modified = model.copy(initial.book);
  modified.sheets[0] = model.setCell(modified.sheets[0], 1, 1, '새 독립 값');
  const saved = await store.save(modified, initial.revision, '내 기준정보');
  const again = await store.load();
  assert.equal(again.revision, saved.revision);
  assert.equal(again.name, '내 기준정보');
  assert.equal(model.cell(again.book.sheets[0], 1, 1), '새 독립 값');
  assert.equal(values.get('wms-floor-plan-editor-draft-v2:test'), 'original drawing');
  await assert.rejects(store.save(modified, initial.revision), /다른 탭/);
  assert.throws(() => store.name('  '), /이름/);
  console.log('Independent reference data: 13-sheet seed, cell/row/column edits, separate persistence and conflict guard passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
