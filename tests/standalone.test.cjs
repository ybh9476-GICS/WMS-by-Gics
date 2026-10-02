const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const model = require('../js/floor-plan-reference-model.js');
const drawing = require('../js/floor-plan-model.js');
const seed = require('../data/wms-reference-seed.json');
const values = new Map([
  ['wms-by-gics-reference-data-v1', 'original reference untouched'],
  ['wms-floor-plan-editor-draft-v2:custom-1789604650974', 'original drawing untouched']
]);
const window = {
  WmsFloorPlanReferenceModel: model, WmsFloorPlanModel: drawing,
  localStorage: { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value) }
};
const sandbox = { window, crypto, DOMException };
for (const file of ['data/wms-reference-seed.js','js/floor-plan-reference-store.js','js/floor-plan-rack-master.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'), sandbox);
}
(async () => {
  assert.equal(JSON.stringify(window.WMS_REFERENCE_SEED), JSON.stringify(seed));
  const store = window.WmsFloorPlanReferenceStore, master = window.WmsRackMaster;
  const types = await master.load();
  assert.equal(types.length, 5);
  const before = await store.load();
  const saved = await master.save(types[0], '독립 랙', {
    code: 'LOCAL-TEST', placement: {w:4,h:4,bayGap:0,rowGap:0}, canWrite: () => true
  });
  assert.equal(saved.id, 'LOCAL-TEST');
  assert.equal((await master.load()).length, 6);
  const after = await store.load();
  assert.deepEqual(after.book.sheets.filter(s=>s.name!=='랙타입 마스터'), before.book.sheets.filter(s=>s.name!=='랙타입 마스터'));
  assert.equal(window.WMS_REFERENCE_SEED.sheets.find(s=>s.name==='랙타입 마스터').rows,9);
  const snapshot=values.get(store.key);
  await assert.rejects(master.save(types[0],'duplicate',{code:'LOCAL-TEST',canWrite:()=>true}),/이미 사용/);
  await assert.rejects(master.save(types[0],'denied'),/저장할 수 없습니다/);
  assert.equal(values.get(store.key),snapshot);
  await assert.rejects(store.save(before.book,before.revision),/다른 탭/);
  assert.equal(values.get('wms-by-gics-reference-data-v1'),'original reference untouched');
  assert.equal(values.get('wms-floor-plan-editor-draft-v2:custom-1789604650974'),'original drawing untouched');
  const bad=model.copy(after.book);bad.sheets.find(s=>s.name==='랙타입 마스터').cells[2][2]='잘못된 헤더';
  await store.save(bad,after.revision);
  await assert.rejects(master.load(),/열 구성/);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  for(const [,relative] of html.matchAll(/(?:src|href)="([^"]+)"/g)){
    assert.ok(!relative.includes('..')&&!path.isAbsolute(relative)&&!/^\w+:/.test(relative));
    assert.ok(fs.existsSync(path.join(root,relative)),relative);
  }
  const editor=fs.readFileSync(path.join(root,'js/floor-plan-editor.js'),'utf8');
  assert.ok(!editor.includes('wms-floor-plan-editor-draft-'));
  assert.ok(!editor.includes('navigateToMenu'));
  assert.ok(!html.includes('role-permissions.js'));
  console.log('Standalone: local seed, isolated storage, local rack writes, duplicate/conflict guards and relative assets passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
