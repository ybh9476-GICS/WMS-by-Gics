(function(){
'use strict';
let inflight=false;
const headers=['랙타입코드','랙타입명','베이폭(m)','깊이(m)','전체높이(m)','단수','단당높이(m)','깊이수'],placementHeaders=['배치 가로(m)','배치 세로(m)','베이 사이 간격(m)','랙열 사이 간격(m)'];
function schema(labels){const a=(labels||[]).map(v=>String(v??'').trim());while(a.at(-1)==='')a.pop();return JSON.stringify(a)===JSON.stringify(headers)?8:JSON.stringify(a)===JSON.stringify([...headers,...placementHeaders])?12:0;}
function placementData(values){const result={};for(const k of ['placementW','placementH','bayGap','rowGap']){const v=values?.[k];if(v===undefined||v===null||String(v).trim()==='')continue;result[k]=Number(v);if(!Number.isFinite(result[k]))throw Error("배치 크기·간격은 유효한 숫자로 입력하세요.");}if(Object.keys(result).length){const m=window.WmsFloorPlanModel;if((result.placementW!==undefined&&result.placementW<.01)||(result.placementH!==undefined&&result.placementH<.01))throw Error('배치 가로·세로는 0.01 m 이상으로 입력하세요.');m.read({...m.blank(),width:200,height:200,objects:[{id:'CHECK',kind:'W',x:0,y:0,w:result.placementW??1,h:result.placementH??1,angle:0,locked:false,rackTypeId:'',bayGap:result.bayGap??0,rowGap:result.rowGap??0}]});}return result;}
function stamp(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),v=k=>parts.find(p=>p.type===k).value;return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;}
function uniqueName(name,rows){if(!rows.some(r=>String(r[1]??'').trim()===name))return name;const suffix=' '+stamp();let n=name.slice(0,60-suffix.length)+suffix,i=2;while(rows.some(r=>String(r[1]??'').trim()===n)){const extra=' '+i++;n=name.slice(0,60-suffix.length-extra.length)+suffix+extra;}return n;}
function generateCode(){return 'RACK-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomUUID().slice(0,6).toUpperCase();}
function normalizeCode(code){return String(code??'').trim().toUpperCase();}
function validateCode(code){const id=normalizeCode(code);if(!/^[A-Z][A-Z0-9_-]{0,23}$/.test(id))throw Error('랙타입코드는 영문으로 시작하고 영문·숫자·하이픈(-)·밑줄(_)로 1~24자를 입력하세요.');return id;}
function parseTable(table){
 const columns=table?schema(table.cols?.map(c=>c.label)):0;
 if(!columns)throw Error('랙타입 마스터 열 구성이 변경되었습니다. 기존 목록을 유지합니다.');
 if(!Array.isArray(table.rows)||table.rows.length>20000)throw Error('랙타입 마스터 행 구성을 확인할 수 없습니다.');
 const seen=new Set(),m=window.WmsFloorPlanModel;
 return table.rows.flatMap((row,index)=>{const cells=row.c?.map(c=>c?.v??'')||[];if(cells.every(v=>String(v).trim()===''))return [];try{const id=validateCode(cells[0]);if(seen.has(id))throw Error('랙타입코드가 중복됩니다: '+id);seen.add(id);const numeric=i=>{if(String(cells[i]??'').trim()==='')throw Error(headers[i]+' 값이 없습니다.');return Number(cells[i]);},type={id,name:String(cells[1]??'').trim(),bayWidth:numeric(2),depth:numeric(3),height:numeric(4),levels:numeric(5),levelHeight:numeric(6),depthCount:numeric(7)};return [{...m.read({...m.blank(),rackTypes:[type]}).rackTypes[0],...(columns===12?placementData({placementW:cells[8],placementH:cells[9],bayGap:cells[10],rowGap:cells[11]}):{})}];}catch(error){throw Error('랙타입 마스터 '+(index+5)+'행: '+error.message);}});
}
function prepare(){return Promise.resolve();}
function tableOf(sheet){
 const cells=new Map(sheet.cells.map(([row,column,value])=>[row+':'+column,value]));
 const cell=(row,column)=>cells.get(row+':'+column)??'';
 return {cols:Array.from({length:12},(_,i)=>({label:cell(4,i+1)})),
  rows:Array.from({length:Math.max(0,sheet.rows-4)},(_,i)=>({c:Array.from({length:12},(_,j)=>({v:cell(i+5,j+1)}))}))};
}
function rackSheet(book){
 const index=book.sheets.findIndex(sheet=>sheet.name==='랙타입 마스터');
 if(index<0)throw Error('기준정보에 랙타입 마스터 시트가 없습니다. .tbl 파일을 열어 복원하세요.');
 const sheet=book.sheets[index],table=tableOf(sheet);
 parseTable(table);
 return {index,sheet,table,columns:schema(table.cols.map(c=>c.label))};
}
async function load({signal}={}){
 const saved=await window.WmsFloorPlanReferenceStore.load();
 if(signal?.aborted)throw new DOMException('요청이 취소되었습니다.','AbortError');
 return parseTable(rackSheet(saved.book).table);
}
async function save(type,name,{code,placement,onName=()=>{},canWrite=()=>false}={}){
 if(inflight)throw Error('이미 저장 중입니다. 저장 결과를 기다려주세요.');
 if(!canWrite())throw Error('현재 편집 세션에서 저장할 수 없습니다.');
 name=name.trim();if(!name||name.length>60)throw Error('랙타입명은 1~60자로 입력하세요.');
 inflight=true;
 try{
  const store=window.WmsFloorPlanReferenceStore,model=window.WmsFloorPlanReferenceModel,m=window.WmsFloorPlanModel;
  const saved=await store.load(),book=model.copy(saved.book),target=rackSheet(book);
  const rows=target.table.rows.map(row=>row.c.map(c=>c.v));
  if(target.columns===8&&placement)throw Error('랙타입 마스터에 배치 크기·간격 열이 필요합니다. 저장하지 않았습니다.');
  const exists=id=>rows.some(row=>normalizeCode(row[0])===id);
  let id=code===undefined?generateCode():validateCode(code);
  if(code===undefined){while(exists(id))id=generateCode();}
  else if(exists(id)){const error=Error('랙타입코드 '+id+'는 이미 사용 중입니다. 다른 코드를 입력하세요.');error.duplicateCode=true;throw error;}
  name=uniqueName(name,rows);onName(name);
  const layout=placementData(placement?{placementW:placement.w,placementH:placement.h,bayGap:placement.bayGap,rowGap:placement.rowGap}:type);
  const row=[id,name,m.roundMeters(type.bayWidth),m.roundMeters(type.depth),m.roundMeters(type.height),type.levels,m.roundMeters(type.levelHeight??type.height/type.levels),type.depthCount];
  if(target.columns===12)row.push(...['placementW','placementH','bayGap','rowGap'].map(k=>layout[k]===undefined?'':m.roundMeters(layout[k])));
  const result=parseTable({cols:target.table.cols,rows:[{c:row.map(v=>({v}))}]} )[0];
  const lastRow=target.sheet.cells.reduce((last,[r])=>Math.max(last,r),4),nextRow=lastRow+1;
  if(nextRow>10000)throw Error('랙타입 마스터의 최대 행 수를 초과했습니다.');
  target.sheet.rows=Math.max(target.sheet.rows,nextRow);
  row.forEach((value,i)=>{if(value!=='')target.sheet.cells.push([nextRow,i+1,String(value)]);});
  model.validate(book);
  if(!canWrite())throw Error('편집 세션이 종료되어 저장하지 않았습니다.');
  await store.save(book,saved.revision,saved.name);
  return result;
 }finally{inflight=false;}
}
window.WmsRackMaster={prepare,save,generateCode,validateCode,load,parseTable};
})();
