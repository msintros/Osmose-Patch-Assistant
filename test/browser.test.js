// Browser test with a fake Web MIDI device that answers "configToMidi" with a real modern capture.
const { chromium } = require('playwright'); const fs = require('fs'); const EM = require('../src/protocol.js');
const assert = require('assert');
const fixture = EM.parseSmf(fs.readFileSync(__dirname + '/fixtures/bowed-biqbank.mid'));
const SHOTS = process.env.SHOTS || '/tmp';
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await pg.addInitScript((fixture) => {
    window.__sent = [];
    const input = { id: 'i1', name: 'Osmose Port 2', onmidimessage: null }; window.__input = input; window.__fixture = fixture;
    const output = { id: 'o1', name: 'Osmose Port 2', send(m) { window.__sent.push(Array.from(m));
      if (m[0] === 0xBF && m[1] === 109 && m[2] === 16) setTimeout(() => fixture.forEach(x => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(x) })), 20); } };
    navigator.requestMIDIAccess = async () => ({ inputs: new Map([['i1', input]]), outputs: new Map([['o1', output]]), onstatechange: null });
  }, fixture);
  // Everything the app sends (also while not connected) is in its MIDI log capture.
  const sentSince = n => pg.evaluate(n => window.osmosePatcher.capture.slice(n).filter(e => e.dir === 'out' && e.b[1] !== 116).map(e => e.b), n);
  const mark = () => pg.evaluate(() => window.osmosePatcher.capture.length);
  await pg.goto('file://' + __dirname + '/../dist/osmose-patcher.html');
  await pg.waitForTimeout(300);

  // 1. Empty start: only Master (the Control sources stay behind the scenes).
  const startNodes = await pg.$$eval('.node[data-node]', ns => ns.map(n => n.dataset.node));
  console.log('start nodes:', startNodes.join(','));
  assert.deepStrictEqual(startNodes.sort(), ['master']);
  await pg.screenshot({ path: SHOTS + '/r3-empty.png' });

  await pg.selectOption('#dialectSel', 'modern');
  // 2. Add a Low pass filter from the side strip: goes to slot 1 and sends its type.
  let n0 = await mark();
  await pg.click('.pitem[data-key="osc:filter"]'); await pg.waitForTimeout(150);
  console.log('add low pass sent:', JSON.stringify(await sentSince(n0)));
  assert.deepStrictEqual((await sentSince(n0)).slice(-2), [[0xBF, 56, 20], [0xAF, 72, 5]]);
  const labels = await pg.$$eval('.node[data-node="osc1"] text.plabel', t => t.map(x => x.firstChild.nodeValue));
  console.log('low pass inputs:', labels.join(' | '));
  assert.deepStrictEqual(labels, ['In', 'Cutoff', 'Width']);

  // 3. Turn its Width knob: writes a constant on the Direct + (2) row into column 14.
  n0 = await mark();
  const kb = await pg.locator('.knob[data-knob="c14"] circle.face').boundingBox();
  await pg.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await pg.mouse.down();
  await pg.mouse.move(kb.x + kb.width / 2, kb.y - 45, { steps: 6 }); await pg.mouse.up(); await pg.waitForTimeout(120);
  const knobSent = await sentSince(n0);
  console.log('knob sent:', JSON.stringify(knobSent));
  const st = await pg.evaluate(() => { const S = window.osmosePatcher.state; const c = S.cells.get(14 * 64 + 14); return c; });
  console.log('row 14 col 14 cell:', JSON.stringify(st));
  assert(st && st.code === 49 && st.dec > 0, 'knob should leave a decimal constant');
  assert(knobSent.some(m => m[0] === 0xBF && m[1] === 40 && m[2] === 14), 'row 14 selected');
  assert.strictEqual(await pg.locator('.cable path.vis').count(), 0, 'dial values are not drawn as cables');

  // 4. Fill the 5 Osc/Filter slots, then the strip must refuse a sixth.
  for (const k of ['osc:0', 'osc:filter', 'osc:filter', 'osc:filter']) { await pg.click(`.pitem[data-key="${k}"]`); await pg.waitForTimeout(60); }
  const dis = await pg.$eval('.pitem[data-key="osc:14"]', e => [e.disabled, e.dataset.tip.split("\n").pop()]);
  console.log('sixth osc:', dis.join(' / '));
  assert.strictEqual(dis[0], true);
  // Bank C only takes delays and B-aliases; BiqBank goes to A first, then B, then is refused.
  n0 = await mark();
  await pg.click('.pitem[data-key="bank:BiqBank"]'); await pg.waitForTimeout(60);
  // A new BiqBank gets the firmware defaults: columns 3..7 = sF, B, sB, C, sA.
  const biqDef = await sentSince(n0);
  assert(biqDef.some(m => m[0] === 0xBF && m[1] === 56 && m[2] === 25), 'BiqSin poke');
  assert(biqDef.some(m => m[0] === 0xAF && m[1] === 18 && m[2] === 1) && biqDef.some(m => m[0] === 0xAF && m[1] === 22 && m[2] === 8), 'column defaults');
  const newBiq = await pg.$$eval('.node[data-node="bankA"] text.plabel', t => t.map(x => x.firstChild.nodeValue));
  console.log('new BiqBank columns:', newBiq.join(' | '));
  assert.deepStrictEqual(newBiq.slice(2), ['sF spread', 'B width', 'sB width spread', 'C centre', 'sA amp spread', '—']);
  await pg.click('.pitem[data-key="bank:BiqMouth"]'); await pg.waitForTimeout(60);
  const biq3 = await pg.$eval('.pitem[data-key="bank:ModMan"]', e => [e.disabled, e.dataset.tip.split("\n").pop()]);
  console.log('third A/B bank:', biq3.join(' / '));
  assert.strictEqual(biq3[0], true);
  assert.strictEqual(await pg.$eval('.pitem[data-key="bank:VoiceDelay"]', e => e.disabled), false);

  // 5. Cable a Pressure modulator to the Cutoff input of slot 1.
  await pg.click('.pitem[data-key="mod:pressure"]'); await pg.waitForTimeout(100);
  await pg.evaluate(() => window.osmosePatcher.connect('m:mod1', 13)); await pg.waitForTimeout(150);
  console.log('cables after connect:', await pg.locator('.cable path.vis').count(), '| inspector:', await pg.textContent('#inspector h2'));
  await pg.screenshot({ path: SHOTS + '/r3-built.png' });

  // 6. Connect to the fake device: the preset replaces the patch and modules are placed from its cells.
  await pg.click('#connectBtn'); await pg.waitForTimeout(1100);
  // Connecting pushes the screen to the Osmose (a matrix clear goes out first); Read patch brings the preset in.
  assert((await pg.evaluate(() => window.__sent)).some(m => m[0] === 0xBF && m[1] === 45 && m[2] === 125), 'connect sends the screen patch');
  await pg.click('#readBtn'); await pg.waitForTimeout(900);
  const devNodes = await pg.$$eval('.node[data-node]', ns => ns.map(n => n.dataset.node));
  console.log('device preset:', await pg.textContent('#presetName'), '| nodes:', devNodes.join(','), '| cables:', await pg.locator('.cable path.vis').count());
  const kin = await pg.$$eval('.node[data-node="bankA"] text.plabel', t => t.map(x => x.firstChild.nodeValue));
  const biq = await pg.$$eval('.node[data-node="bankB"] text.plabel', t => t.map(x => x.firstChild.nodeValue));
  console.log('Bank A (Kinetic):', kin.join(' | ')); console.log('Bank B (BiqBank):', biq.join(' | '));
  assert.strictEqual(kin[4], 'Mass'); assert.strictEqual(biq[2], 'sF spread'); assert.strictEqual(biq[7], '—');
  await pg.screenshot({ path: SHOTS + '/r3-device.png' });

  // 7. Module settings: open Bank B, change assignable column 8 to "R even/odd" → BiqSin poke (stream 25).
  await pg.locator('.node[data-node="bankB"] .headhit').click(); await pg.waitForTimeout(150);
  const sel = pg.locator('#inspector .ctl.assign select[data-sel="47"]');
  // C centre is already on column 6, so column 8 can't take it.
  const dis8 = await sel.evaluate(s => [...s.options].filter(o => o.disabled).map(o => o.textContent));
  console.log('column 8 disabled options:', dis8.join(', '));
  assert(dis8.includes('C centre (on another column)') && dis8.length === 5);
  n0 = await mark();
  await sel.selectOption('4'); await pg.waitForTimeout(100);
  const pokeSent = await sentSince(n0);
  console.log('assign poke:', JSON.stringify(pokeSent));
  assert.deepStrictEqual(pokeSent, [[0xBF, 56, 25], [0xAF, 47, 4]]);
  const col8 = (await pg.$$eval('.node[data-node="bankB"] text.plabel', t => t.map(x => x.firstChild.nodeValue)))[7];
  console.log('Bank B col 8 now:', col8); assert.strictEqual(col8, 'R even/odd');
  // Column 8's slider is the Even/odd property itself (-1..1): setting it pokes property id 28, and the
  // Properties list shows the same value (no second, additive slider).
  const c8 = pg.locator('#inspector .ctl.assign:has(select[data-sel="47"]) input[type=number]');
  assert.deepStrictEqual(await c8.evaluate(i => [i.min, i.max]), ['-1', '1']);
  n0 = await mark();
  await c8.fill('0.5'); await c8.dispatchEvent('change'); await pg.waitForTimeout(150);
  const c8Sent = await sentSince(n0); console.log('column 8 slider → property:', JSON.stringify(c8Sent));
  assert.deepStrictEqual(c8Sent, [[0xBF, 56, 25], [0xAF, 28, 75]]);
  assert.strictEqual(await pg.locator('#inspector .ctl:has(label:text-is("Even/odd (col 8)")) input[type=number]').inputValue(), '0.5');
  assert.strictEqual(await pg.locator('#inspector .ctl:not(.assign) label', { hasText: 'R even/odd' }).count(), 0, 'no separate Controls slider');
  // The node's dial for column 8 shows the property too.
  const k8 = await pg.locator('.knob[data-knob="c42"]').getAttribute('data-tip');
  console.log('column 8 dial:', k8.split('\n').pop()); assert(/Now 0\.5 \(-1 to 1\)/.test(k8));
  // Properties: Spread (sF) = 1 → raw 50 on Bank B (id 25).
  n0 = await mark();
  const sp = pg.locator('#inspector .ctl:has(label:text-is("Spread (col 3)"))').locator('input[type=number]');
  await sp.fill('1'); await sp.dispatchEvent('change'); await pg.waitForTimeout(100);
  const propSent = await sentSince(n0); console.log('property poke:', JSON.stringify(propSent));
  assert.deepStrictEqual(propSent, [[0xBF, 56, 25], [0xAF, 25, 50]]);
  await pg.screenshot({ path: SHOTS + '/r3-inspector.png' });

  // 7b. A macro the preset names can be removed, and stays removed; macros are listed in order.
  const macroNodes = () => pg.$$eval('.node[data-node^="macro"]', ns => ns.map(n => n.dataset.node).join(','));
  console.log('macros before:', await macroNodes());
  assert.strictEqual(await macroNodes(), 'macro0,macro1,macro2,macro3');
  pg.on('dialog', d => d.accept());
  await pg.locator('.node[data-node="macro1"]  rect.body').dispatchEvent('pointerdown'); await pg.waitForTimeout(80);
  await pg.keyboard.press('Delete'); await pg.waitForTimeout(150);
  console.log('macros after deleting ii:', await macroNodes());
  assert.strictEqual(await macroNodes(), 'macro0,macro2,macro3');

  // 8. Outside a read, what the Osmose sends (echoes, a new preset) does not change the patch on screen.
  await pg.waitForTimeout(2500);
  const nodesBefore = await pg.$$eval('.node[data-node]', ns => ns.map(n => n.dataset.node).join(','));
  await pg.evaluate(() => { window.__fixture.forEach(x => window.__input.onmidimessage({ data: new Uint8Array(x) })); });
  await pg.waitForTimeout(300);
  const nodesAfter = await pg.$$eval('.node[data-node]', ns => ns.map(n => n.dataset.node).join(','));
  const col8After = (await pg.$$eval('.node[data-node="bankB"] text.plabel', t => t.map(x => x.firstChild.nodeValue)))[7];
  console.log('unsolicited preset ignored:', nodesBefore === nodesAfter, col8After);
  assert.strictEqual(nodesAfter, nodesBefore); assert.strictEqual(col8After, 'R even/odd');

  console.log('errors:', errors);
  assert.deepStrictEqual(errors, []);
  await b.close();
  console.log('browser test OK');
})().catch(e => { console.error(e); process.exit(1); });
