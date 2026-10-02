(function () {
  'use strict';
  const model = window.WmsFloorPlanReferenceModel;
  const store = window.WmsFloorPlanReferenceStore;
  const files = window.WmsFloorPlanReferenceFile;
  const rowBatchSize = 50;
  let excelLibraryPromise;
  function excelLibrary() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (!excelLibraryPromise) excelLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/exceljs.min.js';
      script.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(Error('Excel 파일 모듈을 불러오지 못했습니다.'));
      script.onerror = () => reject(Error('Excel 파일 모듈을 불러오지 못했습니다. 네트워크와 파일 경로를 확인하세요.'));
      document.head.append(script);
    }).catch(error => { excelLibraryPromise = null; throw error; });
    return excelLibraryPromise;
  }
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));

  function mount(host) {
    const listeners = new AbortController();
    let active = false, book = null, referenceName = '새 기준정보', revision = null, index = 0, visibleRows = rowBatchSize, loading = false, saving = false, fileSaving = false;
    let selectionAxis = '', selected = new Set(), selectionAnchor = 0, editing = null, resizing = null, loadToken = 0;
    const lastFileNames = { tbl: '새 기준정보', xlsx: '새 기준정보' };
    host.innerHTML = '<input type="file" data-reference-file="tbl" accept=".tbl" hidden>' +
      '<input type="file" data-reference-file="xlsx" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>' +
      '<aside class="fp-reference-sidebar"><h3>기준 정보 시트</h3><div class="fp-reference-tabs" role="tablist" aria-label="기준 정보 시트"></div></aside>' +
      '<main class="fp-reference-table-area" aria-label="기준정보 표">' +
      '<div class="fp-reference-edit-controls" role="toolbar" aria-label="기준정보 이름과 표 편집">' +
      '<button type="button" class="fp-reference-name" data-reference-command="rename" title="기준정보 이름 변경"><span data-reference-name>새 기준정보</span><span aria-hidden="true">✎</span></button>' +
      '<div class="fp-reference-structure-controls">' +
      '<button type="button" data-reference-command="add-row">행 추가</button><button type="button" data-reference-command="delete-row">선택 행 삭제</button>' +
      '<button type="button" data-reference-command="add-column">열 추가</button><button type="button" data-reference-command="delete-column">선택 열 삭제</button></div></div>' +
      '<div class="fp-reference-grid" data-reference-grid></div><p class="fp-reference-status" data-reference-status role="status"></p></main>';
    const find = selector => host.querySelector(selector);
    const status = (message, error = false) => {
      const element = find('[data-reference-status]');
      element.textContent = message;
      element.dataset.error = String(error);
    };
    const sheet = () => book?.sheets[index];
    function renderTabs() {
      const tabs = find('.fp-reference-tabs');
      tabs.innerHTML = book.sheets.map((item, position) =>
        '<div class="fp-reference-tab-item" role="presentation"><button type="button" role="tab" data-reference-tab="' + position + '" aria-selected="' + (position === index) + '" tabindex="' + (position === index ? '0' : '-1') + '">' + escapeHtml(item.name) + '</button>' +
        '<button type="button" class="fp-reference-delete" data-reference-delete="' + position + '" aria-label="' + escapeHtml(item.name) + ' 시트 삭제" title="' + (book.sheets.length === 1 ? '마지막 시트는 삭제할 수 없습니다' : '시트 삭제') + '" ' + (book.sheets.length === 1 ? 'disabled' : '') + '><span aria-hidden="true">×</span></button></div>'
      ).join('');
    }
    function renderSelection() {
      host.querySelectorAll('[data-reference-select-row],[data-reference-select-column]').forEach(button => {
        const axis = button.dataset.referenceSelectRow ? 'row' : 'column';
        const value = Number(button.dataset.referenceSelectRow || button.dataset.referenceSelectColumn);
        button.setAttribute('aria-pressed', String(selectionAxis === axis && selected.has(value)));
      });
      const amount = selected.size;
      find('[data-reference-command=delete-row]').disabled = saving || selectionAxis !== 'row' || !amount || sheet().rows <= amount;
      find('[data-reference-command=delete-column]').disabled = saving || selectionAxis !== 'column' || !amount || sheet().columns <= amount;
      find('[data-reference-command=add-row]').disabled = saving || sheet().rows >= 10000;
      find('[data-reference-command=add-column]').disabled = saving || sheet().columns >= 1000;
    }
    function renderRows(current, first, last, values) {
      const heights = new Map(current.rowHeights || []);
      return Array.from({ length: last - first + 1 }, (_, offset) => {
        const row = first + offset;
        return '<tr data-reference-table-row="' + row + '"' + (heights.has(row) ? ' style="height:' + heights.get(row) + 'px"' : '') + '><th scope="row"><button type="button" class="fp-reference-select" data-reference-select-row="' + row + '" aria-label="' + row + '행 선택">' + row + '</button><span class="fp-reference-resize-row" data-reference-resize-row="' + row + '" role="separator" aria-orientation="horizontal" aria-label="' + row + '행 높이 조절" aria-valuemin="30" aria-valuemax="400" tabindex="0"></span></th>' +
          Array.from({ length: current.columns }, (_, column) => '<td tabindex="0" data-reference-row="' + row + '" data-reference-column="' + (column + 1) + '" title="' + model.columnName(column + 1) + row + ' · 더블클릭 또는 Enter로 편집">' + escapeHtml(values.get(row + ':' + (column + 1)) || '') + '</td>').join('') + '</tr>';
      }).join('');
    }
    function syncRowResizeLabels(grid, first = 1) {
      const rows = grid.querySelector('tbody').rows;
      for (let position = first - 1; position < rows.length; position++) {
        const handle = rows[position].querySelector('[data-reference-resize-row]');
        handle.setAttribute('aria-valuenow', String(Math.round(handle.closest('tr').getBoundingClientRect().height)));
      }
    }
    function freezeColumnWidths(current, grid) {
      const table = grid.querySelector('table');
      const configured = new Map(current.columnWidths || []);
      const widths = [...table.tHead.rows[0].cells].map((heading, position) => position === 0
        ? Math.ceil(heading.getBoundingClientRect().width)
        : configured.get(position) || Math.max(96, Math.ceil(heading.getBoundingClientRect().width)));
      const group = document.createElement('colgroup');
      widths.forEach(width => {
        const column = document.createElement('col');
        column.style.width = width + 'px';
        group.append(column);
      });
      table.prepend(group);
      table.style.width = widths.reduce((total, width) => total + width, 0) + 'px';
      table.classList.add('fp-reference-sized');
      grid.querySelectorAll('[data-reference-resize-column]').forEach(handle => {
        handle.setAttribute('aria-valuenow', String(widths[Number(handle.dataset.referenceResizeColumn)]));
      });
      syncRowResizeLabels(grid);
    }
    function appendRows() {
      if (!active || !book || visibleRows >= sheet().rows) return;
      const grid = find('[data-reference-grid]');
      if (grid.scrollTop + grid.clientHeight < grid.scrollHeight - 100) return;
      const current = sheet(), first = visibleRows + 1;
      visibleRows = Math.min(current.rows, visibleRows + rowBatchSize);
      const values = new Map(current.cells.map(([row, column, value]) => [row + ':' + column, value]));
      grid.querySelector('tbody').insertAdjacentHTML('beforeend', renderRows(current, first, visibleRows, values));
      syncRowResizeLabels(grid, first);
      renderSelection();
    }
    function renderTable(resetScroll = false) {
      if (!book) return;
      const current = sheet(), last = Math.min(current.rows, visibleRows);
      const grid = find('[data-reference-grid]');
      const scrollTop = resetScroll ? 0 : grid.scrollTop;
      const scrollLeft = resetScroll ? 0 : grid.scrollLeft;
      const values = new Map(current.cells.map(([row, column, value]) => [row + ':' + column, value]));
      const headings = Array.from({ length: current.columns }, (_, offset) => '<th scope="col"><button type="button" class="fp-reference-select" data-reference-select-column="' + (offset + 1) + '" aria-label="' + model.columnName(offset + 1) + '열 선택">' + model.columnName(offset + 1) + '</button><span class="fp-reference-resize-column" data-reference-resize-column="' + (offset + 1) + '" role="separator" aria-orientation="vertical" aria-label="' + model.columnName(offset + 1) + '열 너비 조절" aria-valuemin="96" aria-valuemax="1000" tabindex="0"></span></th>').join('');
      grid.innerHTML = '<table><thead><tr><th scope="col">#</th>' + headings + '</tr></thead><tbody>' + renderRows(current, 1, last, values) + '</tbody></table>';
      freezeColumnWidths(current, grid);
      grid.scrollTop = scrollTop;
      grid.scrollLeft = scrollLeft;
      find('[data-reference-name]').textContent = referenceName;
      renderTabs();
      renderSelection();
      while (grid.clientHeight > 0 && visibleRows < current.rows && grid.scrollHeight <= grid.clientHeight) {
        grid.scrollTop = grid.scrollHeight;
        appendRows();
      }
    }
    async function load(force = false) {
      if (loading || (book && !force)) { if (book) renderTable(); return; }
      loading = true;
      const token = ++loadToken;
      status('독립 기준정보를 불러오는 중…');
      try {
        const loaded = await store.load();
        if (!active || token !== loadToken) return;
        book = loaded.book;
        referenceName = loaded.name;
        revision = loaded.revision;
        lastFileNames.tbl = referenceName;
        lastFileNames.xlsx = referenceName;
        index = Math.min(index, book.sheets.length - 1);
        visibleRows = Math.min(visibleRows, book.sheets[index].rows);
        selectionAxis = ''; selected.clear();
        renderTable();
        status(loaded.source === 'seed' ? '원본 시트에서 복사한 초기 데이터입니다. 첫 수정부터 별도로 저장됩니다. 수식은 자동 계산되지 않습니다.' : '독립 기준정보를 불러왔습니다.');
      } catch (error) { if (active && token === loadToken) status(error.message, true); }
      finally { if (token === loadToken) loading = false; }
    }
    async function saveChange(nextSheet, message, targetIndex = index) {
      if (!book || saving || !window.wmsPermissions?.isAuthenticated()) return false;
      saving = true;
      const next = model.copy(book);
      next.sheets[targetIndex] = nextSheet;
      try {
        model.validate(next);
        const result = await store.save(next, revision, referenceName);
        book = next; revision = result.revision;
        visibleRows = Math.min(visibleRows, sheet().rows);
        selectionAxis = ''; selected.clear();
        renderTable(); status(message);
        return true;
      } catch (error) { status(error.message, true); return false; }
      finally { saving = false; if (book) renderSelection(); }
    }
    async function persistName(nextName, message) {
      nextName = store.name(nextName);
      files.fileName(nextName, 'tbl');
      if (!book || saving || !window.wmsPermissions?.isAuthenticated()) throw Error('기준정보를 불러온 뒤 이름을 변경하세요.');
      if (nextName === referenceName) { status(message); return; }
      saving = true;
      try {
        const result = await store.save(book, revision, nextName);
        revision = result.revision;
        referenceName = nextName;
        lastFileNames.tbl = nextName;
        lastFileNames.xlsx = nextName;
        find('[data-reference-name]').textContent = nextName;
        status(message);
      } finally { saving = false; if (book) renderSelection(); }
    }
    function rename() {
      if (!active || !book || saving || !window.wmsPermissions?.isAuthenticated()) return;
      if (host.querySelector('.fp-reference-rename-dialog')) return;
      const trigger = find('[data-reference-command=rename]');
      const dialog = document.createElement('dialog');
      dialog.className = 'fp-dialog fp-reference-rename-dialog';
      dialog.innerHTML = '<h3>기준정보 이름 변경</h3><label>이름<input type="text" data-reference-new-name maxlength="150" autocomplete="off"></label>' +
        '<p class="fp-dialog-error" role="alert"></p><div class="fp-actions"><button type="button" data-reference-rename-confirm>변경</button><button type="button" data-reference-rename-cancel>취소</button></div>';
      host.append(dialog);
      const input = dialog.querySelector('[data-reference-new-name]');
      input.value = referenceName;
      dialog.querySelector('[data-reference-rename-cancel]').addEventListener('click', () => dialog.close());
      dialog.querySelector('[data-reference-rename-confirm]').addEventListener('click', async () => {
        if (dialog.dataset.busy === 'true') return;
        dialog.dataset.busy = 'true';
        try { await persistName(input.value, '기준정보 이름을 변경했습니다.'); dialog.close(); }
        catch (error) { dialog.querySelector('.fp-dialog-error').textContent = error.message; status(error.message, true); input.focus(); }
        finally { dialog.dataset.busy = 'false'; }
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); dialog.querySelector('[data-reference-rename-confirm]').click(); }
      });
      dialog.addEventListener('close', () => { dialog.remove(); if (active && trigger.isConnected) trigger.focus(); }, { once: true });
      dialog.showModal(); input.focus(); input.select();
    }
    function confirmDeleteSheet(position, trigger) {
      if (!active || !book || saving || !window.wmsPermissions?.isAuthenticated() || !Number.isSafeInteger(position) || position < 0 || position >= book.sheets.length) return;
      if (book.sheets.length === 1) { status('마지막 시트는 삭제할 수 없습니다.', true); return; }
      if (host.querySelector('.fp-reference-delete-dialog')) return;
      const target = book.sheets[position];
      const dialog = document.createElement('dialog');
      dialog.className = 'fp-dialog fp-reference-delete-dialog';
      dialog.innerHTML = '<h3>시트 삭제</h3><p data-reference-delete-message></p><p class="fp-muted">삭제한 시트는 실행 취소할 수 없습니다.</p>' +
        '<p class="fp-dialog-error" role="alert"></p><div class="fp-actions"><button type="button" data-reference-delete-confirm>삭제</button><button type="button" data-reference-delete-cancel>취소</button></div>';
      dialog.querySelector('[data-reference-delete-message]').textContent = '‘' + target.name + '’ 시트를 삭제하겠습니까? 값이 있는 셀 ' + target.cells.length.toLocaleString() + '개도 함께 삭제됩니다.';
      host.append(dialog);
      dialog.querySelector('[data-reference-delete-cancel]').addEventListener('click', () => dialog.close());
      dialog.querySelector('[data-reference-delete-confirm]').addEventListener('click', async () => {
        if (dialog.dataset.busy === 'true' || !active || !window.wmsPermissions?.isAuthenticated()) return;
        dialog.dataset.busy = 'true';
        dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
          const next = model.removeSheet(book, position);
          saving = true;
          const result = await store.save(next, revision, referenceName);
          const wasCurrent = index === position;
          book = next; revision = result.revision;
          if (index > position) index--;
          else if (wasCurrent) index = Math.min(position, book.sheets.length - 1);
          if (wasCurrent) visibleRows = rowBatchSize;
          selectionAxis = ''; selected.clear();
          renderTable(wasCurrent);
          status('‘' + target.name + '’ 시트를 삭제했습니다.');
          dialog.close();
        } catch (error) {
          dialog.querySelector('.fp-dialog-error').textContent = error.message;
          status(error.message, true);
        } finally {
          saving = false;
          dialog.dataset.busy = 'false';
          if (dialog.open) dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
          if (book) renderSelection();
        }
      });
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (active) (trigger.isConnected ? trigger : find('[data-reference-tab="' + index + '"]'))?.focus();
      }, { once: true });
      dialog.showModal();
      dialog.querySelector('[data-reference-delete-cancel]').focus();
    }
    async function fileData(kind) {
      if (kind === 'tbl') return { data: files.serializeTbl(book), type: 'application/json;charset=utf-8' };
      status('Excel 파일을 만드는 중…');
      return { data: await files.exportExcel(book, await excelLibrary()), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    async function saveWithPicker(kind) {
      if (!active || !book || saving || fileSaving || !window.wmsPermissions?.isAuthenticated()) return;
      fileSaving = true;
      let writer = null, wroteFile = false;
      try {
        // The picker must be requested before awaiting cell saves or Excel conversion.
        const handle = await window.showSaveFilePicker({
          id: 'gics-standalone-reference-' + kind,
          suggestedName: files.fileName(lastFileNames[kind], kind),
          startIn: 'desktop',
          types: [{
            description: kind === 'tbl' ? 'WMS by Gics 기준정보' : 'Excel 통합 문서',
            accept: kind === 'tbl' ? { 'application/octet-stream': ['.tbl'] } : { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }
          }],
          excludeAcceptAllOption: true
        });
        if (!active || !window.wmsPermissions?.isAuthenticated()) return;
        if (editing && !await commitEdit()) return;
        if (!handle.name.toLowerCase().endsWith('.' + kind)) throw Error('.' + kind + ' 파일로 저장하세요.');
        const { data } = await fileData(kind);
        writer = await handle.createWritable();
        await writer.write(data);
        await writer.close();
        writer = null;
        wroteFile = true;
        lastFileNames[kind] = handle.name.slice(0, -kind.length - 1);
        if (kind === 'tbl') await persistName(lastFileNames[kind], handle.name + ' 파일에 ' + book.sheets.length + '개 시트를 저장했습니다.');
        else status(handle.name + ' 파일에 ' + book.sheets.length + '개 시트를 저장했습니다.');
      } catch (error) {
        if (writer) try { await writer.abort(); } catch (_) { /* Keep the original error. */ }
        status(error.name === 'AbortError' ? '파일 저장을 취소했습니다.' : wroteFile ? '파일은 저장됐지만 기준정보 이름을 갱신하지 못했습니다: ' + error.message : '파일 저장 실패: ' + error.message, error.name !== 'AbortError');
      } finally { fileSaving = false; }
    }
    function requestSave(kind) {
      if (typeof window.showSaveFilePicker === 'function') void saveWithPicker(kind);
      else status('이 브라우저는 파일 저장창을 지원하지 않습니다. Edge 또는 Chrome에서 http://127.0.0.1:4174/를 열어 저장하세요. 파일은 저장되지 않았습니다.', true);
    }
    async function openFile(kind, file) {
      if (!active || !book || saving || !window.wmsPermissions?.isAuthenticated()) return;
      if (editing && !await commitEdit()) return;
      if (!file.name.toLowerCase().endsWith('.' + kind)) { status('선택한 파일의 확장자가 .' + kind + '이 아닙니다.', true); return; }
      if (file.size > 30000000) { status('30MB 이하의 파일을 사용하세요.', true); return; }
      try {
        status('파일을 확인하는 중…');
        const next = kind === 'tbl' ? files.parseTbl(await file.text()) : await files.importExcel(await file.arrayBuffer(), await excelLibrary());
        const count = next.sheets.reduce((total, sheet) => total + sheet.cells.length, 0);
        if (!active) return;
        if (!window.confirm(file.name + '의 ' + next.sheets.length + '개 시트, 값이 있는 셀 ' + count.toLocaleString() + '개로 현재 기준정보 전체를 덮어쓰겠습니까?\n기존 데이터가 필요하면 먼저 .tbl 파일로 저장하세요.')) {
          status('파일 가져오기를 취소했습니다.'); return;
        }
        saving = true;
        const nextName = file.name.slice(0, -kind.length - 1);
        const result = await store.save(next, revision, nextName);
        book = next; referenceName = nextName; revision = result.revision; index = 0; visibleRows = rowBatchSize; selectionAxis = ''; selected.clear();
        lastFileNames.tbl = nextName; lastFileNames.xlsx = nextName;
        renderTable(true);
        status(file.name + '의 기준정보 ' + next.sheets.length + '개 시트를 열었습니다.');
      } catch (error) { status(error.message, true); }
      finally { saving = false; if (book) renderSelection(); }
    }
    for (const kind of ['tbl', 'xlsx']) {
      find('[data-reference-file=' + kind + ']').addEventListener('change', event => {
        const file = event.target.files[0];
        event.target.value = '';
        if (file) void openFile(kind, file);
      }, { signal: listeners.signal });
    }
    function choose(axis, value, event) {
      if (selectionAxis !== axis) { selectionAxis = axis; selected.clear(); selectionAnchor = value; }
      if (event.shiftKey && selectionAnchor) {
        if (!event.ctrlKey && !event.metaKey) selected.clear();
        for (let item = Math.min(value, selectionAnchor); item <= Math.max(value, selectionAnchor); item++) selected.add(item);
      } else if (event.ctrlKey || event.metaKey) {
        if (selected.has(value)) selected.delete(value); else selected.add(value);
        selectionAnchor = value;
      } else { selected = new Set([value]); selectionAnchor = value; }
      renderSelection();
    }
    function previewResize(state, pixels) {
      state.current = Math.max(state.minimum, Math.min(state.maximum, Math.round(pixels)));
      if (state.axis === 'column') {
        state.target.style.width = state.current + 'px';
        state.table.style.width = state.tableWidth + state.current - state.start + 'px';
      } else state.target.style.height = state.current + 'px';
      state.handle.setAttribute('aria-valuenow', String(state.current));
    }
    function finishResize(commit) {
      const state = resizing;
      if (!state) return;
      resizing = null;
      state.controller.abort();
      document.documentElement.classList.remove('fp-reference-resizing-' + state.axis);
      if (!commit || state.current === state.start || !active || !book) {
        previewResize(state, state.start);
        return;
      }
      let next;
      try { next = model.setSize(sheet(), state.axis, state.index, state.current); }
      catch (error) { previewResize(state, state.start); status(error.message, true); return; }
      void saveChange(next, sheet().name + ' · ' + (state.axis === 'column' ? model.columnName(state.index) + '열 너비' : state.index + '행 높이') + ' 저장 완료').then(saved => {
        if (!saved && active) renderTable();
      });
    }
    function startResize(event) {
      const handle = event.target.closest('[data-reference-resize-row],[data-reference-resize-column]');
      if (!handle || event.button !== 0 || !active || !book || saving || editing || !window.wmsPermissions?.isAuthenticated()) return;
      event.preventDefault();
      event.stopPropagation();
      const axis = handle.dataset.referenceResizeColumn ? 'column' : 'row';
      const index = Number(handle.dataset.referenceResizeColumn || handle.dataset.referenceResizeRow);
      const table = handle.closest('table');
      const target = axis === 'column' ? table.querySelectorAll('col')[index] : handle.closest('tr');
      const start = axis === 'column' ? Math.round(target.getBoundingClientRect().width) : Math.round(target.getBoundingClientRect().height);
      const controller = new AbortController();
      const state = { handle, axis, index, target, table, start, current: start,
        tableWidth: Math.round(table.getBoundingClientRect().width),
        origin: axis === 'column' ? event.clientX : event.clientY,
        minimum: axis === 'column' ? 96 : 30, maximum: axis === 'column' ? 1000 : 400,
        pointerId: event.pointerId, controller };
      resizing = state;
      document.documentElement.classList.add('fp-reference-resizing-' + axis);
      handle.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', move => {
        if (move.pointerId === state.pointerId) previewResize(state, state.start + (axis === 'column' ? move.clientX : move.clientY) - state.origin);
      }, { signal: controller.signal });
      window.addEventListener('pointerup', up => { if (up.pointerId === state.pointerId) finishResize(true); }, { signal: controller.signal });
      window.addEventListener('pointercancel', cancel => { if (cancel.pointerId === state.pointerId) finishResize(false); }, { signal: controller.signal });
    }
    function cancelEdit() {
      if (!editing || editing.busy) return;
      const { cell, value } = editing;
      editing = null;
      if (cell.isConnected) { cell.classList.remove('fp-reference-editing'); cell.textContent = value; cell.focus(); }
    }
    async function commitEdit() {
      if (!editing) return true;
      const state = editing;
      if (state.busy) return false;
      if (state.input.value === state.value) { cancelEdit(); return true; }
      state.busy = true;
      state.input.disabled = true;
      try {
        const current = book.sheets[state.sheetIndex];
        const next = model.setCell(current, state.row, state.column, state.input.value);
        const saved = await saveChange(next, current.name + ' · ' + model.columnName(state.column) + state.row + ' 저장 완료', state.sheetIndex);
        if (!saved) {
          state.busy = false;
          state.input.disabled = false;
          state.input.focus();
          return false;
        }
        if (editing === state) editing = null;
        if (active && index === state.sheetIndex) {
          find('[data-reference-row="' + state.row + '"][data-reference-column="' + state.column + '"]')?.focus();
        }
        return true;
      } catch (error) {
        state.busy = false;
        state.input.disabled = false;
        status(error.message, true);
        state.input.focus();
        return false;
      }
    }
    async function editCell(cell) {
      if (!active || !book || saving || !window.wmsPermissions?.isAuthenticated()) return;
      const row = Number(cell.dataset.referenceRow), column = Number(cell.dataset.referenceColumn);
      if (editing) {
        if (editing.cell === cell) return;
        if (!await commitEdit()) return;
        cell = find('[data-reference-row="' + row + '"][data-reference-column="' + column + '"]');
        if (!cell) return;
      }
      const value = model.cell(sheet(), row, column);
      const input = document.createElement('textarea');
      input.className = 'fp-reference-cell-input';
      input.setAttribute('aria-label', sheet().name + ' ' + model.columnName(column) + row + ' 값');
      input.setAttribute('rows', '1');
      input.maxLength = 20000;
      input.value = value;
      cell.classList.add('fp-reference-editing');
      cell.replaceChildren(input);
      const state = { cell, input, row, column, sheetIndex: index, value, busy: false, composing: false };
      editing = state;
      input.addEventListener('compositionstart', () => { state.composing = true; });
      input.addEventListener('compositionend', () => { state.composing = false; });
      input.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
        else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !state.composing && event.keyCode !== 229) {
          event.preventDefault(); void commitEdit();
        }
      });
      input.addEventListener('blur', () => {
        setTimeout(() => { if (editing === state && !state.busy) void commitEdit(); }, 0);
      });
      input.focus();
      input.select();
    }
    async function changeStructure(command) {
      if (!book || saving || !window.wmsPermissions?.isAuthenticated()) return;
      const current = sheet(), axis = command.includes('row') ? 'row' : 'column', label = axis === 'row' ? '행' : '열';
      if (command.startsWith('add')) {
        const before = selectionAxis === axis && selected.size ? Math.max(...selected) + 1 : (axis === 'row' ? current.rows : current.columns) + 1;
        try {
          if (await saveChange(model.insert(current, axis, before), current.name + ' · ' + label + '을 추가했습니다.')) {
            if (axis === 'row') visibleRows = Math.max(visibleRows, before);
            selectionAxis = axis; selected = new Set([before]); selectionAnchor = before;
            renderTable();
            find('[data-reference-select-' + axis + '="' + before + '"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
        catch (error) { status(error.message, true); }
        return;
      }
      if (selectionAxis !== axis || !selected.size) return;
      const indices = [...selected].sort((a, b) => a - b);
      const cells = current.cells.filter(entry => indices.includes(entry[axis === 'row' ? 0 : 1])).length;
      if (!window.confirm(current.name + ' 시트의 선택한 ' + label + ' ' + indices.length + '개를 삭제하겠습니까? 포함된 값 ' + cells + '개도 삭제됩니다.')) return;
      try { await saveChange(model.removeIndices(current, axis, indices), current.name + ' · ' + label + ' ' + indices.length + '개를 삭제했습니다.'); }
      catch (error) { status(error.message, true); }
    }
    host.addEventListener('click', async event => {
      if (editing && event.target !== editing.input && !editing.input.contains(event.target)) {
        if (!await commitEdit()) return;
      }
      const button = event.target.closest('button');
      if (!active || !button || button.disabled) return;
      if (button.dataset.referenceDelete !== undefined && book) confirmDeleteSheet(Number(button.dataset.referenceDelete), button);
      else if (button.dataset.referenceTab !== undefined && book) {
        index = Number(button.dataset.referenceTab); visibleRows = rowBatchSize; selectionAxis = ''; selected.clear(); renderTable(true);
        status(sheet().name + ' · ' + sheet().rows + '행 × ' + sheet().columns + '열');
      } else if (button.dataset.referenceSelectRow) choose('row', Number(button.dataset.referenceSelectRow), event);
      else if (button.dataset.referenceSelectColumn) choose('column', Number(button.dataset.referenceSelectColumn), event);
      else if (button.dataset.referenceCommand === 'rename') rename();
      else if (/^(add|delete)-(row|column)$/.test(button.dataset.referenceCommand || '')) changeStructure(button.dataset.referenceCommand);
    }, { signal: listeners.signal });
    host.addEventListener('pointerdown', startResize, { signal: listeners.signal });
    find('[data-reference-grid]').addEventListener('scroll', appendRows, { signal: listeners.signal });
    host.addEventListener('dblclick', event => {
      const cell = event.target.closest('[data-reference-row][data-reference-column]');
      if (cell) editCell(cell);
    }, { signal: listeners.signal });
    host.addEventListener('keydown', event => {
      const resizeHandle = event.target.closest('[data-reference-resize-row],[data-reference-resize-column]');
      if (resizeHandle) {
        const axis = resizeHandle.dataset.referenceResizeColumn ? 'column' : 'row';
        const step = axis === 'column' ? (event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0)
          : (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0);
        if (step && active && book && !saving && !editing && window.wmsPermissions?.isAuthenticated()) {
          event.preventDefault();
          const size = Math.max(axis === 'column' ? 96 : 30, Math.min(axis === 'column' ? 1000 : 400, Number(resizeHandle.getAttribute('aria-valuenow')) + step));
          const dimension = Number(resizeHandle.dataset.referenceResizeColumn || resizeHandle.dataset.referenceResizeRow);
          void saveChange(model.setSize(sheet(), axis, dimension, size), sheet().name + ' · 크기 저장 완료').then(saved => {
            if (saved) find('[data-reference-resize-' + axis + '="' + dimension + '"]')?.focus();
          });
        }
        return;
      }
      if (event.target.matches('.fp-reference-cell-input')) return;
      const cell = event.target.closest('[data-reference-row][data-reference-column]');
      if (cell && event.key === 'Enter') { event.preventDefault(); editCell(cell); }
    }, { signal: listeners.signal });
    return {
      openTbl() { if (active) find('[data-reference-file=tbl]').click(); },
      saveTbl() { requestSave('tbl'); },
      importExcel() { if (active) find('[data-reference-file=xlsx]').click(); },
      exportExcel() { requestSave('xlsx'); },
      show() { active = true; host.hidden = false; if (editing?.cell.isConnected) { if (!editing.busy) editing.input.focus(); return; } load(); },
      hide() { finishResize(false); host.querySelector('.fp-reference-save-dialog[open],.fp-reference-rename-dialog[open],.fp-reference-delete-dialog[open]')?.close(); if (editing) void commitEdit(); active = false; loadToken++; loading = false; host.hidden = true; },
      destroy() { finishResize(false); cancelEdit(); active = false; loadToken++; loading = false; listeners.abort(); host.replaceChildren(); }
    };
  }
  window.WmsFloorPlanReferenceData = { mount };
})();
