const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const drawing = JSON.parse(fs.readFileSync(path.join(root, 'output/floor-plan.gics'), 'utf8'));
const reference = JSON.parse(fs.readFileSync(path.join(root, 'output/floor-plan-reference-fixed.tbl'), 'utf8'));
if (drawing.format !== 'gics-floor-plan' || drawing.version !== 1 || !drawing.plan) throw Error('기본 .gics 도면 형식이 올바르지 않습니다.');
if (reference.format !== 'wms-by-gics-reference-table' || reference.version !== 1 || !reference.book) throw Error('기본 .tbl 기준정보 형식이 올바르지 않습니다.');
const output = 'window.WMS_DEMO_SEED = ' + JSON.stringify({plan: drawing.plan, book: reference.book}) + ';\n';
fs.writeFileSync(path.join(root, 'data/wms-demo-seed.js'), output);
