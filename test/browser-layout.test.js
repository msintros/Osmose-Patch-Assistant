// Dragging modules by the title bar, and the right-click Add menu.
const { chromium } = require('playwright'); const assert = require('assert');
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await pg.goto('file://' + __dirname + '/../dist/osmose-patcher.html'); await pg.waitForTimeout(250);
  const box = sel => pg.locator(sel).first().boundingBox();
  await pg.click('#layoutBtn'); await pg.waitForTimeout(150);
  const head = '.node[data-node="master"] rect.headhit';
  const b0 = await box(head);
  await pg.mouse.move(b0.x + 20, b0.y + 10); await pg.mouse.down();
  await pg.mouse.move(b0.x - 200, b0.y + 120, { steps: 6 }); await pg.mouse.up(); await pg.waitForTimeout(100);
  const b1 = await box(head);
  console.log('master moved by', Math.round(b1.x - b0.x), Math.round(b1.y - b0.y));
  assert(Math.abs(b1.x - b0.x + 220) < 4 && Math.abs(b1.y - b0.y - 110) < 4);
  assert.strictEqual(await pg.evaluate(() => window.osmosePatcher.selected?.id ?? null), null, 'a drag does not select');
  // Ports and dials moved with it, and the position survives a reload.
  const port = await box('[data-nodep="master"] .port.in');
  assert(port.x < b1.x + 5 && port.x > b1.x - 15);
  await pg.reload(); await pg.waitForTimeout(250);
  const b2 = await box(head); assert(Math.abs(b2.x - b1.x) < 2 && Math.abs(b2.y - b1.y) < 2, 'position kept');
  // A plain click on the title bar selects.
  await pg.mouse.click(b2.x + 20, b2.y + 10); await pg.waitForTimeout(80);
  assert.strictEqual(await pg.evaluate(() => window.osmosePatcher.selected?.id), 'master');

  // Right-click empty canvas → Filters → High pass, placed where clicked.
  const cv = await box('#canvas');
  const at = [cv.x + 60, cv.y + cv.height - 300];
  console.log('target', await pg.evaluate(([x, y]) => document.elementFromPoint(x, y).outerHTML.slice(0, 80), at));
  await pg.mouse.click(at[0], at[1], { button: 'right' }); await pg.waitForTimeout(80);
  assert(await pg.isVisible('#ctxMenu'));
  await pg.hover('#ctxMenu .ctxcat[data-cat="Banks"]');
  const banks = await pg.locator('#ctxMenu .ctxitem').allTextContents();
  console.log('Banks menu:', banks.length, 'items');
  assert(banks.includes('BiqBank resonator') && banks.includes('Kinetic model'));
  await pg.hover('#ctxMenu .ctxcat[data-cat="Filters"]');
  const filters = await pg.locator('#ctxMenu .ctxitem').allTextContents();
  console.log('Filters menu:', filters.join(', '));
  assert(filters.includes('High pass') && filters.includes('Ladder low pass'));
  await pg.click('#ctxMenu .ctxitem[data-key="osc:6"]'); await pg.waitForTimeout(150);
  assert(!(await pg.isVisible('#ctxMenu')));
  const st = await pg.evaluate(() => ({ setup: window.osmosePatcher.state.setup[72] }));
  assert.strictEqual(st.setup, 6, 'slot 1 is a high pass');
  const nb = await box('.node[data-node="osc1"] rect.body');
  console.log('filter placed at', Math.round(nb.x - at[0]), Math.round(nb.y - at[1]), 'from the click');
  assert(Math.abs(nb.x - at[0]) < 3 && Math.abs(nb.y - at[1]) < 3);
  // Modulation, Escape closes.
  await pg.mouse.click(cv.x + 40, cv.y + cv.height - 30, { button: 'right' }); await pg.hover('#ctxMenu .ctxcat[data-cat="Modulation"]');
  assert(await pg.locator('#ctxMenu .ctxitem[data-key="mod:pressure"]').isEnabled());
  await pg.keyboard.press('Escape'); assert(!(await pg.isVisible('#ctxMenu')));
  // Banks list: no group headings, dividers between groups instead.
  await pg.mouse.click(cv.x + 40, cv.y + cv.height - 30, { button: 'right' }); await pg.hover('#ctxMenu .ctxcat[data-cat="Banks"]');
  assert.strictEqual(await pg.locator('#ctxMenu .ctxgroup').count(), 0);
  console.log('bank dividers:', await pg.locator('#ctxMenu .ctxsep').count()); assert(await pg.locator('#ctxMenu .ctxsep').count() >= 5);
  await pg.keyboard.press('Escape');
  // The module list can be hidden, and stays hidden after a reload.
  await pg.click('#paletteBtn'); assert(!(await pg.isVisible('#palette')));
  await pg.reload(); await pg.waitForTimeout(250); assert(!(await pg.isVisible('#palette')));
  await pg.click('#paletteBtn'); assert(await pg.isVisible('#palette'));
  // Save opens the system save dialog; the chosen file name becomes the patch name.
  await pg.evaluate(() => { window.__saved = null; window.showSaveFilePicker = async o => { window.__pick = o.suggestedName;
    return { name: 'My bowed thing.osmpatch.json', createWritable: async () => ({ write: async t => { window.__saved = t; }, close: async () => {} }) }; }; });
  await pg.click('#saveBtn'); await pg.waitForTimeout(150);
  const sv = await pg.evaluate(() => ({ pick: window.__pick, fmt: JSON.parse(window.__saved).format, name: document.querySelector('#presetName').textContent }));
  console.log('save:', JSON.stringify(sv)); assert.strictEqual(sv.fmt, 'osmose-patcher/1'); assert.strictEqual(sv.name, 'My bowed thing');
  // Cancelling the dialog saves nothing and shows no error.
  await pg.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('cancel', 'AbortError'); }; });
  await pg.click('#saveBtn'); await pg.waitForTimeout(100);
  // Reset layout puts master back in its column.
  await pg.click('#layoutBtn'); await pg.waitForTimeout(150);
  assert(errors.length === 0, errors.join('\n'));
  console.log('layout test passed'); await b.close();
})().catch(e => { console.error(e); process.exit(1); });
