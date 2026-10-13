const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const M=require('../js/floor-plan-reference-model.js'),F=require('../js/floor-plan-reference-file.js');
const window={WmsFloorPlanReferenceModel:M};
vm.runInNewContext(fs.readFileSync('js/floor-plan-reference-store.js','utf8'),{window});
const book=window.WmsFloorPlanReferenceStore.upgrade(require('../data/wms-reference-seed.json'));
fs.writeFileSync('output/reference-before-repair.tbl',F.serializeTbl(book));
const sheet=name=>book.sheets.find(s=>s.name===name);
const set=(s,r,c,v)=>{const old=s.cells.find(x=>x[0]===r&&x[1]===c);if(old)old[2]=String(v);else s.cells.push([r,c,String(v)]);};
const mappings=[['FA01','AMR-001'],['FA02','AMR-002'],['FA03','AMR-003'],['SH01','4SHUTTLE-001'],['SH02','4SHUTTLE-002'],['SH03','4SHUTTLE-003']];
mappings.forEach(([id,code],i)=>{set(sheet('3D 연결'),9+i,1,'floor-plan');set(sheet('3D 연결'),9+i,2,id);set(sheet('3D 연결'),9+i,4,code);});
for(const [r,b]of [[2,'B02'],[3,'B03'],[4,'B01']])set(sheet('운영 경로'),r,4,b);
const edits=JSON.parse(fs.readFileSync('output/location-code-migration.json','utf8')),codes=new Map(edits.map(e=>[e.old,e.code]));
assert.equal(edits.length,640);assert.equal(new Set(codes.values()).size,640);
for(const e of edits){const s=sheet('로케이션 마스터');assert.equal(M.cell(s,e.row,1),e.old);for(let c=2;c<=6;c++)assert.equal(Number(M.cell(s,e.row,c))||M.cell(s,e.row,c),Number(e.values[c-1])||e.values[c-1]);set(s,e.row,1,e.code);set(s,e.row,5,1);set(s,e.row,7,e.depth);}
set(sheet('로케이션 마스터'),2,1,'현재 floor-plan 도면의 랙·단·베이·셀 코드입니다. 기존 깊이 1~4를 랙열 1~4로 대응했으며 최대수량은 유지했습니다.');
const inv=sheet('재고 현황'),beforeStock=JSON.stringify(inv.cells.filter(c=>c[0]>=5&&c[1]>1));
let stockCount=0;for(const cell of inv.cells){if(cell[0]>=5&&cell[1]===1){assert.ok(codes.has(cell[2]));cell[2]=codes.get(cell[2]);stockCount++;}}
assert.equal(stockCount,640);assert.equal(JSON.stringify(inv.cells.filter(c=>c[0]>=5&&c[1]>1)),beforeStock);
const jobs=sheet('작업지시');for(let r=2;r<=jobs.rows;r++){const route=M.cell(jobs,r,18);if(!route)continue;const incoming=route!=='OUT01',buffer=route==='OUT01'?'B01':route==='IN01'?'B02':'B03',station=route==='OUT01'?'S01':route==='IN01'?'S02':'S03',dock=route==='OUT01'?'D03':route==='IN01'?'D01':'D02';set(jobs,r,10,incoming?buffer:station);set(jobs,r,11,incoming?station:buffer);set(jobs,r,9,`3D 모의 운행: ${incoming?`${dock} → ${buffer} → ${station}`:`${station} → ${buffer} → ${dock}`}`);}
for(const r of [5,6]){assert.match(M.cell(jobs,r,9),/^UI 예시/);set(jobs,r,4,'취소');set(jobs,r,9,'모의 운행 제외 · '+M.cell(jobs,r,9)+' (미배치 장비, 운영 경로 없음)');}
const status=sheet('설비 상태 정보');set(status,3,13,'B01');set(status,4,11,'B02');set(status,5,11,'B03');
M.validate(book);const text=F.serializeTbl(book);assert.equal(JSON.stringify(F.parseTbl(text)),JSON.stringify(book));
fs.writeFileSync('output/floor-plan-reference-fixed.tbl',text);
console.log(JSON.stringify({sheets:book.sheets.length,locations:edits.length,stockRecords:stockCount,inventoryValuesUnchanged:true,equipmentMappings:mappings.length,operatingRoutes:3,excludedUiExamples:['TR-004','TR-005']}));
