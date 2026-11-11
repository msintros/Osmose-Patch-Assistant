// Modulators, macros, Master effects, graphs, Delete key and hover help (offline, modern protocol).
const { chromium } = require('playwright'); const assert = require('assert');
const SHOTS = process.env.SHOTS || '/tmp';
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await pg.addInitScript(() => { navigator.requestMIDIAccess = async () => ({ inputs: new Map(), outputs: new Map() }); });
  await pg.goto('file://' + __dirname + '/../dist/osmose-patcher.html'); await pg.waitForTimeout(250);
  await pg.selectOption('#dialectSel', 'modern');
  const mark = () => pg.evaluate(() => window.osmosePatcher.capture.length);
  const sentSince = n => pg.evaluate(n => window.osmosePatcher.capture.slice(n).filter(e => e.dir === 'out').map(e => e.b), n);
  const dragTo = async (from, to) => {
    const a = await pg.locator(from).boundingBox(), c = await pg.locator(to).boundingBox();
    await pg.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await pg.mouse.down();
    await pg.mouse.move(c.x + 2, c.y + 2, { steps: 8 }); await pg.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await pg.mouse.up(); await pg.waitForTimeout(150);
  };

  // A filter to modulate.
  await pg.click('.pitem[data-key="osc:filter"]'); await pg.waitForTimeout(100);

  // 1. Pluck envelope: one formula + one shape generator, single cycle, gate trigger, rate from decay.
  let n0 = await mark();
  await pg.click('.pitem[data-key="mod:pluck"]'); await pg.waitForTimeout(150);
  let sent = await sentSince(n0);
  const st = await pg.evaluate(() => { const o = window.osmosePatcher, m = [...o.mods.values()][0], S = o.state;
    return { m, sgType: S.setup[100], trig: S.cells.get(13 * 64 + 52), rate: [13, 14, 15].map(r => S.cells.get(r * 64 + 51)) }; });
  console.log('pluck module:', JSON.stringify(st));
  assert.strictEqual(st.m.g, 'pluck'); assert.strictEqual(st.m.sg, 1); assert.strictEqual(st.sgType, 1); assert.strictEqual(st.trig.code, 45);
  assert(sent.some(m => m[0] === 0xBF && m[1] === 34 && m[2] === st.m.letter), 'formula selected');
  assert(sent.some(m => m[0] === 0xAF && m[1] === 40 && m[2] === 2), 'W source = SG 1');
  // SG 1 is now taken: a raw shape generator goes to slot 2.
  assert.match(await pg.$eval('.pitem[data-key="sg"] small', e => e.textContent), /SG 2/);

  // 2. Cable it to the filter cutoff: the letter goes on a Direct row, drawn from the pluck module.
  await dragTo('.port.out[data-src="m:mod1"] circle', '.port.in[data-col="13"] circle');
  const cell = await pg.evaluate(() => window.osmosePatcher.state.cells.get(13 * 64 + 13));
  console.log('pluck → cutoff cell:', JSON.stringify(cell), '| mod cables:', await pg.locator('.cable.mod path.vis').count());
  assert.strictEqual(cell.code, st.m.letter);
  assert.strictEqual(await pg.locator('.cable.mod path.vis').count(), 1);

  // 3. Changing Decay rewrites the SG rate; changing Amount pokes the formula height.
  await pg.locator('.node[data-node="mod1"] .headhit').click(); await pg.waitForTimeout(100);
  n0 = await mark();
  await pg.locator('#inspector .ctl', { hasText: 'Decay' }).locator('input[type=number]').fill('2');
  await pg.locator('#inspector .ctl', { hasText: 'Decay' }).locator('input[type=number]').dispatchEvent('change'); await pg.waitForTimeout(120);
  const rate = await pg.evaluate(() => { const S = window.osmosePatcher.state; return [13, 14, 15].map(r => S.cells.get(r * 64 + 51)); });
  console.log('rate cells after decay 2 s:', JSON.stringify(rate));
  assert.strictEqual(rate[1].code, 49); assert.strictEqual(rate[1].dec, 5000);     // 0.5 Hz
  n0 = await mark();
  await pg.locator('#inspector .ctl', { hasText: 'Amount' }).locator('input[type=number]').fill('0.5');
  await pg.locator('#inspector .ctl', { hasText: 'Amount' }).locator('input[type=number]').dispatchEvent('change'); await pg.waitForTimeout(120);
  sent = await sentSince(n0);
  console.log('amount 0.5 sent:', JSON.stringify(sent));
  assert(sent.some(m => m[0] === 0xAF && m[1] === 42 && m[2] === 50), 'HeightW = 50');

  // 4. LFO takes SG 2, continuous.
  await pg.click('.pitem[data-key="mod:lfo"]'); await pg.waitForTimeout(150);
  const lfo = await pg.evaluate(() => { const o = window.osmosePatcher; return { m: o.mods.get('mod2'), t: o.state.setup[101] }; });
  console.log('lfo:', JSON.stringify(lfo));
  assert.strictEqual(lfo.m.sg, 2); assert.strictEqual(lfo.t, 0);

  // 5. Macro ii: its knob sends ch1 cc86 + cc13; a cable makes a "constant × macro ii" formula.
  await pg.click('.pitem[data-key="macro:1"]'); await pg.waitForTimeout(150);
  await pg.click('#layoutBtn'); await pg.waitForTimeout(150);
  n0 = await mark();
  const kb = await pg.locator('.knob[data-knob="macro1:value"] circle.face').boundingBox();
  await pg.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await pg.mouse.down(); await pg.mouse.move(kb.x + kb.width / 2, kb.y - 90, { steps: 5 }); await pg.mouse.up(); await pg.waitForTimeout(120);
  sent = await sentSince(n0);
  console.log('macro knob sent (last 2):', JSON.stringify(sent.slice(-2)));
  assert.deepStrictEqual(sent.slice(-2).map(m => [m[0], m[1]]), [[0xB0, 86], [0xB0, 13]]);
  await pg.evaluate(() => window.osmosePatcher.connect('m:macro1', 14)); await pg.waitForTimeout(120);
  const mc = await pg.evaluate(() => { const S = window.osmosePatcher.state; const c = S.cells.get(13 * 64 + 14); return { c, p: S.formulas[c.code & 63].pairs }; });
  console.log('macro cable formula: ScaleW', mc.p[66], 'macro', mc.p[67]);
  assert.strictEqual(mc.p[66], 1); assert.strictEqual(mc.p[67], 1);
  await pg.screenshot({ path: SHOTS + '/r4-mods.png' });

  // 6. Hover help shows after a short delay.
  await pg.click('#layoutBtn'); await pg.waitForTimeout(150);   // fit the whole patch in view
  const lab = await pg.locator('.node[data-node="osc1"] text.plabel').nth(2).boundingBox();
  await pg.mouse.move(lab.x + 5, lab.y + 5); await pg.waitForTimeout(800);
  const tip = await pg.textContent('#tip'); console.log('tip:', tip);
  assert.match(tip, /Width/); assert.strictEqual(await pg.$eval('#tip', e => e.classList.contains('on')), true);
  await pg.screenshot({ path: SHOTS + '/r4-tip.png' });

  // 7. Master: recirculator window sends ch1 cc for its dials; convolution pokes stream 26.
  await pg.locator('.node[data-node="master"] .hbtn').first().dispatchEvent('pointerdown'); await pg.waitForTimeout(150);
  console.log('dialog:', await pg.textContent('#dlg h2'));
  n0 = await mark();
  const r4 = pg.locator('#dlg .ctl', { hasText: 'Decay' }).locator('input[type=number]');
  await r4.fill('90'); await r4.dispatchEvent('change'); await pg.waitForTimeout(80);
  sent = await sentSince(n0); console.log('decay sent:', JSON.stringify(sent));
  assert.deepStrictEqual(sent, [[0xB0, 23, 90]]);
  await pg.screenshot({ path: SHOTS + '/r4-recirc.png' });
  await pg.click('#dlg .dlghead button');
  await pg.locator('.node[data-node="master"] .hbtn').nth(1).dispatchEvent('pointerdown'); await pg.waitForTimeout(150);
  n0 = await mark();
  await pg.locator('#dlg .row', { hasText: 'Material' }).first().locator('select').selectOption('8'); await pg.waitForTimeout(60);
  sent = await sentSince(n0); console.log('conv sent:', JSON.stringify(sent));
  assert.deepStrictEqual(sent, [[0xBF, 56, 26], [0xAF, 4, 8]]);
  await pg.click('#dlg .dlghead button');

  // 8. BiqGraph graph editor: painting pokes stream 21 (main graph).
  await pg.click('.pitem[data-key="bank:BiqGraph"]'); await pg.waitForTimeout(150);
  await pg.click('#inspector button:has-text("Edit graphs")'); await pg.waitForTimeout(150);
  n0 = await mark();
  const gb = await pg.locator('#dlg svg.graph').boundingBox();
  await pg.mouse.move(gb.x + gb.width * 0.03, gb.y + gb.height * 0.5); await pg.mouse.down(); await pg.mouse.move(gb.x + gb.width * 0.2, gb.y + gb.height * 0.3, { steps: 6 }); await pg.mouse.up(); await pg.waitForTimeout(100);
  sent = await sentSince(n0); console.log('graph sent:', sent.length, 'msgs, first', JSON.stringify(sent.slice(0, 2)));
  assert(sent.length >= 4 && sent[0][1] === 56 && sent[0][2] === 21);
  await pg.screenshot({ path: SHOTS + '/r4-graph.png' });
  await pg.click('#dlg .dlghead button');

  // 8b. BiqGraph settings: mode count (setup 70 for Bank A) and filter type (deflate, 99).
  const rowLabels = await pg.$$eval('#inspector .row label', ls => ls.map(l => l.textContent));
  console.log('BiqGraph settings:', rowLabels.join(' | '));
  assert(rowLabels.includes('Modes') && rowLabels.includes('Filter type'));
  n0 = await mark();
  await pg.locator('#inspector .row', { hasText: 'Modes' }).first().locator('select').selectOption('2'); await pg.waitForTimeout(80);
  sent = await sentSince(n0); console.log('modes sent:', JSON.stringify(sent));
  assert.deepStrictEqual(sent, [[0xBF, 56, 20], [0xAF, 70, 2]]);
  assert.strictEqual(await pg.$$eval('#inspector .row:has(label:text-is("Modes")) option', o => o.length), 6);
  // HarMan in Bank B gets a spectral set (setup 65).
  await pg.click('.pitem[data-key="bank:HarMan"]'); await pg.waitForTimeout(150);
  n0 = await mark();
  await pg.locator('#inspector .row', { hasText: 'Spectral set' }).locator('select').selectOption('8'); await pg.waitForTimeout(80);
  sent = await sentSince(n0); console.log('spectral set sent:', JSON.stringify(sent));
  assert.deepStrictEqual(sent, [[0xBF, 56, 20], [0xAF, 65, 8]]);

  // 8c. Clicking a module's body selects it; Jenny picks its phase source by moving slots.
  for (const k of ['osc:0', 'osc:2', 'osc:3']) { await pg.click(`.pitem[data-key="${k}"]`); await pg.waitForTimeout(80); }
  const slots = () => pg.evaluate(() => [72, 73, 74, 75].map(i => window.osmosePatcher.state.setup[i]));
  console.log('slots 1-4 types:', JSON.stringify(await slots()));
  assert.deepStrictEqual(await slots(), [5, 0, 2, 3]);
  // A dial on the Phase oscillator (slot 4) should travel with it.
  const kb4 = await pg.locator('.knob[data-knob="c21"] circle.face').boundingBox();
  await pg.mouse.move(kb4.x + kb4.width / 2, kb4.y + kb4.height / 2); await pg.mouse.down(); await pg.mouse.move(kb4.x + kb4.width / 2, kb4.y - 40, { steps: 4 }); await pg.mouse.up(); await pg.waitForTimeout(100);
  const colsOf = () => pg.evaluate(() => [...window.osmosePatcher.state.cells.keys()].map(k => k % 64).filter(c => c >= 15 && c <= 23));
  const before = await colsOf(); console.log('osc cols with cells before:', JSON.stringify(before));
  assert(before.includes(21));
  const jb = await pg.locator('.node[data-node="osc3"] rect.body').boundingBox();
  await pg.mouse.click(jb.x + jb.width / 2, jb.y + jb.height - 8); await pg.waitForTimeout(120);
  assert.strictEqual(await pg.textContent('#inspector h2'), 'Jenny oscillator');
  await pg.locator('#inspector .row', { hasText: 'Phase from' }).locator('select').selectOption('4'); await pg.waitForTimeout(150);
  console.log('slots after phase-from 4:', JSON.stringify(await slots()));
  assert.deepStrictEqual(await slots(), [5, 3, 2, 0]);
  const after8c = await colsOf(); console.log('osc cols with cells after:', JSON.stringify(after8c));
  assert(!after8c.includes(21) && after8c.includes(15));
  assert.match(await pg.textContent('.node[data-node="osc3"] text.sub'), /phase from slot 2/);
  await pg.screenshot({ path: SHOTS + '/r6-jenny.png' });
  // A new DSF oscillator follows pitch (X on Direct + into its Freq); Key tracking into Freq does the same.
  const fx = await pg.evaluate(() => window.osmosePatcher.state.cells.get(13 * 64 + 22));
  assert.strictEqual(fx && fx.code, 46);
  await pg.click('.pitem[data-key="mod:keytrack"]'); await pg.waitForTimeout(120);
  const kt = await pg.evaluate(() => [...window.osmosePatcher.mods.values()].find(m => m.g === 'keytrack').id);
  await pg.evaluate(c => { const S = window.osmosePatcher.state; S.cells.delete(13 * 64 + c); }, 16);
  await pg.evaluate(id => window.osmosePatcher.connect('m:' + id, 16), kt); await pg.waitForTimeout(100);
  const kx = await pg.evaluate(() => window.osmosePatcher.state.cells.get(13 * 64 + 16));
  console.log('key tracking → Phase freq cell:', JSON.stringify(kx), '|', await pg.textContent('#status'));
  assert.strictEqual(kx && kx.code, 46);

  // 8d. A modulator with something in its In is a VCA: osc → Pressure → Master L in puts the oscillator on
  // the L-in column and Pressure's letter on that column's × row.
  await pg.click('.pitem[data-key="mod:pressure"]'); await pg.waitForTimeout(120);
  const pr = await pg.evaluate(() => [...window.osmosePatcher.mods.values()].find(m => m.g === 'pressure'));
  await pg.evaluate(id => { window.osmosePatcher.connect('m:' + id, 0); }, pr.id); await pg.waitForTimeout(80);
  let lc = await pg.evaluate(() => { const S = window.osmosePatcher.state; return [13, 16, 2].map(r => S.cells.get(r * 64 + 0) || null); });
  console.log('pressure → L in (direct):', JSON.stringify(lc));
  assert.strictEqual(lc[0].code, pr.letter); assert.strictEqual(lc[1], null);
  await pg.evaluate(id => { window.osmosePatcher.connect(2, 'mi:' + id); }, pr.id); await pg.waitForTimeout(120);
  lc = await pg.evaluate(() => { const S = window.osmosePatcher.state; return [13, 16, 2].map(r => S.cells.get(r * 64 + 0) || null); });
  console.log('osc 2 → pressure In → L in:', JSON.stringify(lc));
  assert.strictEqual(lc[0], null); assert.strictEqual(lc[1].code, pr.letter); assert.strictEqual(lc[2].code, 50);
  assert.strictEqual(await pg.locator('.port.in[data-col="mi:' + pr.id + '"]').count(), 1);
  const gate = () => pg.evaluate(l => { const p = window.osmosePatcher.state.formulas[l].pairs; return [p[40], p[38]]; }, pr.letter);
  assert.deepStrictEqual(await gate(), [1, 1], 'as a VCA, Pressure is gated by W');
  // Removing the In cable turns it back into a plain modulator.
  await pg.evaluate(() => document.dispatchEvent(new Event('noop')));
  const before8d = await pg.evaluate(() => window.osmosePatcher.capture.length);
  await pg.evaluate(id => window.osmosePatcher.disconnectModIn(id, 2), pr.id); await pg.waitForTimeout(120);
  lc = await pg.evaluate(() => { const S = window.osmosePatcher.state; return [13, 16, 2].map(r => S.cells.get(r * 64 + 0) || null); });
  console.log('after removing In:', JSON.stringify(lc));
  assert.strictEqual(lc[0].code, pr.letter); assert.strictEqual(lc[1], null); assert.strictEqual(lc[2], null);
  assert.deepStrictEqual(await gate(), [0, 0], 'plain Pressure again');
  // Several scaled outputs, then the source module deleted: nothing of it stays behind.
  await pg.evaluate(id => { const o = window.osmosePatcher; o.connect('m:' + id, 1); o.connect(2, 'mi:' + id); }, pr.id); await pg.waitForTimeout(120);
  lc = await pg.evaluate(() => { const S = window.osmosePatcher.state; return [[16, 0], [16, 1], [2, 0], [2, 1]].map(([r, c]) => (S.cells.get(r * 64 + c) || {}).code ?? null); });
  console.log('L and R scaled:', JSON.stringify(lc)); assert.deepStrictEqual(lc, [pr.letter, pr.letter, 50, 50]);
  await pg.locator('.node[data-node="osc2"]  rect.body').dispatchEvent('pointerdown'); await pg.keyboard.press('Delete'); await pg.waitForTimeout(150);
  const left = await pg.evaluate(id => ({ ins: window.osmosePatcher.mods.get(id).ins, row2: [...window.osmosePatcher.state.cells.keys()].filter(k => Math.floor(k / 64) === 2).length }), pr.id);
  console.log('after deleting slot 2:', JSON.stringify(left)); assert.deepStrictEqual(left, { ins: [], row2: 0 });

  // 9. Delete removes the selected module (and its cables).
  pg.on('dialog', d => d.accept());
  await pg.locator('.node[data-node="mod1"]  rect.body').dispatchEvent('pointerdown'); await pg.waitForTimeout(80);
  await pg.keyboard.press('Delete'); await pg.waitForTimeout(150);
  const after = await pg.evaluate(() => ({ has: window.osmosePatcher.mods.has('mod1'), cell: window.osmosePatcher.state.cells.get(13 * 64 + 13) || null }));
  console.log('after Delete:', JSON.stringify(after));
  assert.strictEqual(after.has, false); assert.strictEqual(after.cell, null);

  console.log('errors:', errors); assert.deepStrictEqual(errors, []);
  await b.close(); console.log('modulators browser test OK');
})().catch(e => { console.error(e); process.exit(1); });
