(function () {
  'use strict';
  // This local application has no server, account, or planning-site permission system.
  window.wmsPermissions = Object.freeze({ isAuthenticated: () => true });
  const panel = document.getElementById('editor');
  const viewer = document.getElementById('viewer3d');
  const drawingMenu = { id: 'local-editor', label: 'WMS by Gics', viewType: 'floorPlanEditor' };
  const viewerMenu = { viewType: 'warehouse3d', viewOptions: { loadData: signal => window.WmsWarehouseLocalData.load(signal, window.wmsFloorPlanEditor.getSnapshot(panel)), onReload: () => window.wmsStandalone.refreshReference() } };
  let simulationKey='',loading=null;
  const key=()=>JSON.stringify([window.wmsFloorPlanEditor.getDocumentId(panel),window.wmsFloorPlanEditor.getSnapshot(panel),localStorage.getItem('gics-standalone-reference-data-v1')]);
  function invalidate(){simulationKey='';window.wmsWarehousePage.dispose(viewer);}
  async function ensureSimulation(){
    if(loading)await loading;
    const next=key();
    if(simulationKey!==next){invalidate();simulationKey=next;loading=window.wmsWarehousePage.setActive(viewer,true,viewerMenu);try{await loading;}finally{loading=null;}}
    if(!window.WmsSimulationSession.snapshot()){simulationKey='';throw Error('모의 운행을 시작하지 못했습니다. 도면과 기준정보를 확인하세요.');}
  }
  window.wmsStandalone = {
    async refreshReference(){
      if(loading)await loading;
      invalidate();
      window.WmsSimulationSession.invalidate('사이트 기준정보를 새로 불러왔습니다. 모의 운행은 초기화되며 재생하면 최신 기준정보를 사용합니다.');
      if(!viewer.hidden)await ensureSimulation();
    },
    checkSimulation(){if(simulationKey&&simulationKey!==key()){invalidate();window.WmsSimulationSession.invalidate('도면 또는 기준정보가 변경되어 모의 운행을 초기화했습니다. 재생하면 변경된 배치에서 새로 시작합니다.');}},
    async playSimulation(){await ensureSimulation();window.WmsSimulationSession.play();},
    show(mode) {
      const in3d = mode === 'viewer3d';
      if (!in3d) sessionStorage.setItem('gics-standalone-return-mode', mode === 'reference' ? 'reference' : 'drawing');
      panel.hidden = in3d;
      viewer.hidden = !in3d;
      window.wmsFloorPlanEditor.setActive(panel, !in3d, drawingMenu);
      if(in3d)void ensureSimulation().catch(error=>console.error(error));
      else window.wmsStandalone.checkSimulation();
    }
  };
  try {
    window.wmsStandalone.show('drawing');
  } catch (error) {
    panel.textContent = '에디터를 시작하지 못했습니다. 폴더 안의 파일이 모두 있는지 확인하세요. ' + error.message;
    console.error(error);
  }
})();
