(function (root, factory) {
  const store = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = store;
  if (root) root.WmsFloorPlanReferenceStore = store;
})(typeof window === 'undefined' ? null : window, function (root) {
  'use strict';
  const key = 'gics-standalone-reference-data-v1';
  const defaultName = '새 기준정보';
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
      return { book: root.WmsFloorPlanReferenceModel.validate(value.book), name: name(value.name), revision: value.revision, source: 'browser' };
    }
    return { book: await seed(), name: defaultName, revision: null, source: 'seed' };
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
  return { load, save, key, name };
});
