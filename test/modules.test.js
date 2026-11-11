// Module catalog: slot rules, dial encoding, type-aware input labels.
const assert = require('assert'); const fs = require('fs');
const EM = require('../src/protocol.js'); global.EM = EM;
const M = require('../src/modules.js');

// Dials: every value in range round-trips through the matrix constants.
for (let i = -900; i <= 900; i += 7) {
  const v = i / 100, S = EM.newState();
  for (const [r, c] of M.dialWrites(S, 20, v)) if (c) S.cells.set(EM.key(r, 20), c);
  assert.strictEqual(M.dialValue(S, 20), Math.round(v * 10000) / 10000, 'dial ' + v);
}
// A formula already on row 15 is left alone; the value still fits using rows 14 and 13.
{ const S = EM.newState(); S.cells.set(EM.key(15, 20), { code: 3, dec: 0 });
  const w = M.dialWrites(S, 20, 2.37); assert(!w.some(([r]) => r === 15));
  for (const [r, c] of w) if (c) S.cells.set(EM.key(r, 20), c); else S.cells.delete(EM.key(r, 20));
  assert.strictEqual(M.dialValue(S, 20), 2.37); }

// Slots: 5 osc/filters, Jenny needs a master oscillator to its left, bank slot rules, 5 SGs.
const items = Object.fromEntries(M.paletteItems().map(i => [i.key, i]));
{ const S = EM.newState(), placed = new Set(['master']);
  assert.ok(M.findSlot(items['osc:2'], placed, S).error, 'Jenny alone');
  placed.add('osc1'); S.setup[72] = 0;
  assert.deepStrictEqual(M.findSlot(items['osc:2'], placed, S), { slotId: 'osc2', wire: 2 });
  S.setup[72] = 5; assert.ok(M.findSlot(items['osc:2'], placed, S).error, 'Jenny after a filter');
  for (let k = 2; k <= 5; k++) placed.add('osc' + k);
  assert.ok(M.findSlot(items['osc:0'], placed, S).error, 'sixth osc');
  assert.strictEqual(M.findSlot(items['bank:VoiceDelay'], placed, S).slotId, 'bankC');
  placed.add('bankA'); assert.strictEqual(M.findSlot(items['bank:BiqBank'], placed, S).slotId, 'bankB');
  placed.add('bankB'); assert.ok(M.findSlot(items['bank:BiqBank'], placed, S).error);
  assert.strictEqual(M.findSlot(items['bank:WaveBank'], placed, S).slotId, 'bankC');
  for (let k = 1; k <= 5; k++) assert.strictEqual(M.findSlot(items.sg, placed, S).slotId, 'sg' + k), placed.add('sg' + k);
  assert.ok(M.findSlot(items.sg, placed, S).error); }

// Labels follow the device's type and column assignments (Bowed BiqBank: A = Kinetic, B = BiqBank).
{ const S = EM.newState(), d = new EM.Decoder(S);
  EM.parseSmf(fs.readFileSync(__dirname + '/fixtures/bowed-biqbank.mid')).forEach(m => d.feed(m));
  const defs = M.slotDefs();
  const A = M.describeNode(defs.bankA, S).inputs.map(i => i.label), B = M.describeNode(defs.bankB, S).inputs.map(i => i.label);
  assert.deepStrictEqual(A.slice(0, 5), ['Force', 'Bow speed', 'Stiction', 'Freq', 'Mass']);
  assert.deepStrictEqual(B, ['In', 'Freq', 'sF spread', 'B width', 'sB width spread', 'C centre', 'sA amp spread', '—']);
  assert.deepStrictEqual(M.describeNode(defs.osc5, S).inputs.map(i => i.label), ['In', 'Cutoff', 'Width']); // type 5 = low pass
  // Legacy archive: Bank C summed delay.
  const hz = __dirname + '/fixtures/legacy-1009-hz-darkness.mid';   // a Haken factory preset, kept out of the repository
  if (fs.existsSync(hz)) {
    const L = EM.newState(), dl = new EM.Decoder(L);
    EM.parseSmf(fs.readFileSync(hz)).forEach(m => dl.feed(m));
    assert.strictEqual(M.describeNode(defs.bankC, L).title, 'Summed delay');
    assert.strictEqual(M.describeNode(defs.bankA, L).title, 'WaveBank');
  } }

// Bank property pokes.
assert.deepStrictEqual(EM.Encoder.setBankProp('modern', 'biqsin', 47, 5), [[0xBF, 56, 25], [0xAF, 47, 5]]);
{ const cur = Array(48).fill(0); const m = EM.Encoder.setBankProp('legacy', 'kinet', 13, 3, cur);
  assert.deepStrictEqual(m[0], [0xBF, 56, 11]); assert.strictEqual(m.length, 50); assert.deepStrictEqual(m[14], [0xDF, 3]); }
assert.throws(() => EM.Encoder.setSetup('legacy', 72, 5));
assert.deepStrictEqual(EM.Encoder.setSetup('legacy', 91, 5), [[0xBE, 91, 5]]);
console.log('modules test OK');
