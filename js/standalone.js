(function () {
  'use strict';
  // This local application has no server, account, or planning-site permission system.
  window.wmsPermissions = Object.freeze({ isAuthenticated: () => true });
  const panel = document.getElementById('editor');
  const viewer = document.getElementById('viewer3d');
  const drawingMenu = { id: 'local-editor', label: 'WMS by Gics', viewType: 'floorPlanEditor' };
  const viewerMenu = { viewType: 'warehouse3d', viewOptions: { loadData: signal => window.WmsWarehouseLocalData.load(signal) } };
  window.wmsStandalone = {
    show(mode) {
      const in3d = mode === 'viewer3d';
      if (!in3d) sessionStorage.setItem('gics-standalone-return-mode', mode === 'reference' ? 'reference' : 'drawing');
      panel.hidden = in3d;
      viewer.hidden = !in3d;
      window.wmsFloorPlanEditor.setActive(panel, !in3d, drawingMenu);
      void window.wmsWarehousePage.setActive(viewer, in3d, viewerMenu);
    }
  };
  try {
    window.wmsStandalone.show('drawing');
  } catch (error) {
    panel.textContent = '에디터를 시작하지 못했습니다. 폴더 안의 파일이 모두 있는지 확인하세요. ' + error.message;
    console.error(error);
  }
})();
