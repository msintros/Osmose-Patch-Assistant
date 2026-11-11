// Octave / detune on a pitch-following Freq, the Gate modulator, a free-running LFO's trigger,
// and Connect pushing the Global FX defaults (offline, modern protocol, fake device).
const { chromium } = require('playwright'); const assert = require('assert');
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await pg.addInitScript(() => {
    window.__sent = [];
    const input = { id: 'i1', name: 'Osmose Port 2', onmidimessage: null };
    const output = { id: 'o1', name: 'Osmose Port 2', send(m) { window.__sent.push(Array.from(m)); } };
    navigator.requestMIDIAccess = async () => ({ inputs: new Map([['i1', input]]), outputs: new Map([['o1', output]]) });
  });
  await pg.goto('file://' + __dirname + '/../dist/osmose-patcher.html'); await pg.waitForTimeout(250);
  await pg.selectOption('#dialectSel', 'modern');
  const cell = (r, c) => pg.evaluate(([r, c]) => window.osmosePatcher.state.cells.get(r * 64 + c) || null, [r, c]);

  // DSF in slot 1: Freq is column 13 and follows X.
  await pg.click('.pitem[data-key="osc:0"]'); await pg.waitForTimeout(150);
  assert.strictEqual((await cell(13, 13)).code, 46);
  await pg.locator('#inspector .row', { hasText: 'Octave' }).locator('select').selectOption('1'); await pg.waitForTimeout(80);
  console.log('octave +1 → × row:', JSON.stringify(await cell(16, 13)));
  assert.strictEqual((await cell(16, 13)).code, 51);
  await pg.locator('#inspector .row', { hasText: 'Octave' }).locator('select').selectOption('-1'); await pg.waitForTimeout(80);
  assert.deepStrictEqual(await cell(16, 13), { code: 49, dec: 5000 });
  const dt = pg.locator('#inspector .ctl', { hasText: 'Detune (Hz)' }).locator('input[type=number]');
  await dt.fill('2.5'); await dt.dispatchEvent('change'); await pg.waitForTimeout(100);
  const dial = await pg.evaluate(() => [14, 15].map(r => window.osmosePatcher.state.cells.get(r * 64 + 13) || null));
  console.log('detune 2.5 Hz → dial cells:', JSON.stringify(dial));
  assert.deepStrictEqual(dial[0], { code: 49, dec: 25 });
  // The Freq dial itself still reads 0 (detune is kept apart), and setting it keeps the detune.
  const fq = pg.locator('#inspector .ctl', { hasText: 'Freq' }).first().locator('input[type=number]');
  assert.strictEqual(await fq.inputValue(), '0');
  await fq.fill('0.1'); await fq.dispatchEvent('change'); await pg.waitForTimeout(100);
  const total = await pg.evaluate(() => { const S = window.osmosePatcher.state; return [14, 15].map(r => S.cells.get(r * 64 + 13)); });
  console.log('Freq 0.1 + detune → cells:', JSON.stringify(total));
  assert.deepStrictEqual(total[0], { code: 49, dec: 1025 });

  // Gate: W only.
  await pg.click('.pitem[data-key="mod:gate"]'); await pg.waitForTimeout(120);
  const g = await pg.evaluate(() => { const o = window.osmosePatcher, m = [...o.mods.values()].find(x => x.g === 'gate'); return o.state.formulas[m.letter].pairs; });
  assert.strictEqual(g[40], 1); assert.strictEqual(g[42], 100); assert.strictEqual(g[59], 0);

  // LFO, free running: its shape generator's trigger column gets a constant 1; restart each note: W.
  await pg.click('.pitem[data-key="mod:lfo"]'); await pg.waitForTimeout(120);
  const sg = await pg.evaluate(() => [...window.osmosePatcher.mods.values()].find(x => x.g === 'lfo').sg);
  const tcol = 51 + 2 * (sg - 1) + 1;
  console.log('LFO sg', sg, 'trigger cell:', JSON.stringify(await cell(13, tcol)));
  assert.strictEqual((await cell(13, tcol)).code, 50);

  // Connect: the screen goes to the Osmose, including Global FX on (setup 15 = 0).
  await pg.click('#connectBtn'); await pg.waitForTimeout(1300);
  const sent = await pg.evaluate(() => window.__sent);
  const i15 = sent.findIndex((m, i) => m[0] === 0xAF && m[1] === 15 && m[2] === 0 && sent[i - 1][1] === 56 && sent[i - 1][2] === 20);
  console.log('Global FX enable sent on connect:', i15 > 0);
  assert(i15 > 0);

  console.log('errors:', errors); assert.deepStrictEqual(errors, []);
  await b.close(); console.log('pitch browser test OK');
})().catch(e => { console.error(e); process.exit(1); });
