(function () {
  'use strict';
  // This local application has no server, account, or planning-site permission system.
  window.wmsPermissions = Object.freeze({ isAuthenticated: () => true });
  const panel = document.getElementById('editor');
  try {
    window.wmsFloorPlanEditor.setActive(panel, true, {
      id: 'local-editor', label: 'WMS by Gics', viewType: 'floorPlanEditor'
    });
  } catch (error) {
    panel.textContent = '에디터를 시작하지 못했습니다. 폴더 안의 파일이 모두 있는지 확인하세요. ' + error.message;
    console.error(error);
  }
})();
