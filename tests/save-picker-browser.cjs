const { chromium } = require(process.env.WMS_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const url = process.env.WMS_TEST_URL || pathToFileURL(path.join(root, 'index.html')).href;
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(require('./save-picker-harness.cjs'));
    const page = await context.newPage(), downloads = [], errors = [], checks = [];
    page.on('download', file => downloads.push(file.suggestedFilename()));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const button = action => page.locator('[data-action=' + action + ']');
    const snapshot = () => page.evaluate(() => ({ calls: pickerTest.calls.length, writes: pickerTest.writes, saved: pickerTest.saved.length }));
    async function repeatedSaves(action, kind, notice) {
      const start = await snapshot();
      for (let i = 1; i <= 2; i++) {
        await page.evaluate(name => pickerTest.nextName = name, 'test-' + i + '.' + kind);
        await button(action).click();
        await page.waitForFunction(count => pickerTest.saved.length === count, start.saved + i);
        assert.equal((await snapshot()).calls, start.calls + i, kind + ' must open a picker for each save');
        assert.equal(await page.evaluate(() => pickerTest.saved.at(-1).name), 'test-' + i + '.' + kind);
      }
      const beforeCancel = await snapshot();
      const storage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
      await page.evaluate(() => pickerTest.cancel = true);
      await button(action).click();
      await page.waitForFunction(selector => document.querySelector(selector).textContent.includes('취소했습니다'), notice);
      const afterCancel = await snapshot();
      assert.equal(afterCancel.calls, beforeCancel.calls + 1);
      assert.equal(afterCancel.writes, beforeCancel.writes);
      assert.equal(afterCancel.saved, beforeCancel.saved);
      assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), storage);
      checks.push(kind + ': repeated saves ask for a file each time; cancellation writes nothing');
    }
    await repeatedSaves('export', 'gics', '.fp-notice');
    await button('masterData').click();
    await page.locator('[data-reference-tab]').first().waitFor();
    await repeatedSaves('export', 'tbl', '[data-reference-status]');
    await repeatedSaves('excelExport', 'xlsx', '[data-reference-status]');
    const beforeUnsupported = await snapshot();
    await page.evaluate(() => window.showSaveFilePicker = undefined);
    for (const action of ['export', 'excelExport']) {
      await button(action).click();
      assert.match(await page.locator('[data-reference-status]').innerText(), /저장창을 지원하지 않습니다/);
    }
    await button('drawing').click(); await button('export').click();
    assert.match(await page.locator('.fp-notice').innerText(), /저장창을 지원하지 않습니다/);
    assert.deepEqual(await snapshot(), beforeUnsupported);
    assert.deepEqual(downloads, []); assert.deepEqual(errors, []);
    checks.push('Unsupported browsers show instructions without downloading, writing or reporting success');
    const output = path.join(root, 'output'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'save-picker-checks.json'), JSON.stringify({ url, checks, errors, downloads, nativePicker: 'Mocked in this automated test' }, null, 2));
    checks.forEach(check => console.log('PASS', check));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
