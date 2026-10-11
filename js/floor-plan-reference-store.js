(function (root, factory) {
  const store = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = store;
  if (root) root.WmsFloorPlanReferenceStore = store;
})(typeof window === 'undefined' ? null : window, function (root) {
  'use strict';
  const key = 'gics-standalone-reference-data-v1';
  const defaultName = '새 기준정보';
  // Additive compatibility upgrade. Existing cells and the imported file stay intact.
  function upgrade(book) {
    book = JSON.parse(JSON.stringify(book));
    const guide = book.sheets.find(sheet => sheet.name === '사용안내');
    const guidance = new Map([
      ['베이 폭, 깊이, 높이, 단수 등 3D 랙 규격을 등록합니다.','평면도에서 선택할 표준 랙 규격을 등록합니다. 이미 배치한 랙의 실제 규격은 도면이 기준입니다.'],
      ['3. 랙배치','3. 3D 연결'],
      ['랙코드, 구역, 랙타입과 평면도 미사용 시의 시작 좌표·방향·베이 수를 입력합니다.','3D 연결 시트에서 도면의 랙 코드에 구역을, 장비 코드에 설비 마스터 코드를 연결합니다.'],
      ['4. 평면도','4. 평면도 에디터'],
      ['셀 1칸은 1m × 1m입니다. 랙코드를 반복 마킹하면 3D의 실제 배치와 크기를 결정합니다.','평면도 에디터에서 크기·위치·회전·경로를 편집합니다. 활성 도면이 3D에 표시됩니다. 기존 평면도·랙배치 시트는 보관용입니다.'],
      ['창고 좌측 하단을 (0, 0)으로 사용합니다.','평면도 에디터와 동일하게 좌측 상단이 (0, 0), 오른쪽이 X+, 아래쪽이 Y+입니다. 단위는 m입니다.']
    ]);
    for(const cell of guide?.cells || []) {
      if(guidance.has(cell[2]))cell[2]=guidance.get(cell[2]);
      if(cell[0]===15&&cell[1]===1&&cell[2]==='평면도')cell[2]='활성 도면';
      if([15,16].includes(cell[0])&&cell[2]==='랙배치')cell[2]='3D 연결';
    }
    if (!book.sheets.some(sheet => sheet.name === '3D 연결')) {
      const cells = [[1,1,'3D View 연결 안내'],[2,1,'배치는 활성 평면도 도면을 사용합니다. 기존 평면도·랙배치·평면도 검증 시트는 보관용입니다.'],
        [3,1,'도면 이름은 *이면 모든 도면에 적용합니다. 도면 이름과 대상 코드가 같은 행을 중복 입력하지 마세요.'],
        [4,1,'도면 이름'],[4,2,'대상 코드'],[4,3,'구역코드'],[4,4,'기준정보 코드'],
        [2,4,'랙: 구역코드 지정 / 장비: 설비 마스터 코드 연결. 빈 기준정보 코드는 도면 대상 코드와 동일합니다.'],
        [3,4,'로케이션 코드가 생성된 랙은 코드로 연결합니다. 미생성 랙은 로케이션 마스터의 랙·랙열·베이·단·깊이로 연결합니다.']];
      const old = book.sheets.find(sheet => sheet.name === '랙배치');
      const rows = new Map();
      for (const [r,c,v] of old?.cells || []) if(r>4 && c<=2) { if(!rows.has(r))rows.set(r,[]);rows.get(r)[c-1]=v; }
      let next = 5; const seen = new Set();
      for (const [code,zone] of rows.values()) if(code && !seen.has(code)) {
        cells.push([next,1,'*'],[next,2,code],[next,3,zone || '']); seen.add(code); next++;
      }
      book.sheets.push({name:'3D 연결',rows:200,columns:4,cells,columnWidths:[[1,180],[2,180],[3,160],[4,480]]});
    }
    const locations = book.sheets.find(sheet => sheet.name === '로케이션 마스터');
    if (locations && !locations.cells.some(([r,,v]) => r===4 && v==='랙열번호')) {
      const column = Math.max(6, locations.columns) + 1;
      if(column<=1000) { locations.columns=column;locations.cells.push([4,column,'랙열번호']); }
    }
    return root.WmsFloorPlanReferenceModel.validate(book);
  }
  function name(value) {
    const text = String(value ?? defaultName).trim();
    if (!text || text.length > 150) throw Error('기준정보 이름은 1~150자로 입력하세요.');
    return text;
  }
  async function seed() {
    if (!root.WMS_REFERENCE_SEED) throw Error('기준정보 초기 데이터 파일을 불러오지 못했습니다.');
    return root.WmsFloorPlanReferenceModel.validate(root.WMS_REFERENCE_SEED);
  }
  async function load() {
    let stored;
    try { stored = root.localStorage.getItem(key); }
    catch (error) { throw Error('기준정보 저장 공간을 읽지 못했습니다: ' + error.message); }
    if (stored) {
      const value = JSON.parse(stored);
      if (value.schemaVersion !== 1 || typeof value.revision !== 'string') throw Error('저장된 기준정보 형식이 올바르지 않습니다. 기존 데이터는 보존했습니다.');
      return { book: upgrade(root.WmsFloorPlanReferenceModel.validate(value.book)), name: name(value.name), revision: value.revision, source: 'browser' };
    }
    return { book: upgrade(await seed()), name: defaultName, revision: null, source: 'seed' };
  }
  async function save(book, previousRevision, referenceName = defaultName) {
    root.WmsFloorPlanReferenceModel.validate(book);
    referenceName = name(referenceName);
    const current = root.localStorage.getItem(key);
    const currentRevision = current ? JSON.parse(current).revision : null;
    if (currentRevision !== previousRevision) throw Error('다른 탭에서 기준정보가 변경되었습니다. 새로고침 후 다시 확인하세요.');
    const revision = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    try { root.localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, revision, name: referenceName, book })); }
    catch (error) { throw Error('기준정보를 저장하지 못했습니다. 브라우저 저장 공간을 확인하세요: ' + error.message); }
    return { revision };
  }
  return { load, save, key, name, upgrade };
});
