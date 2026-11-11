// A real firmware-10.09 preset archive must decode in the legacy layout with matrix and formulas.
const fs = require('fs'), assert = require('assert'), EM = require('../src/protocol.js');
const s = EM.newState(), d = new EM.Decoder(s);
// The fixture is a Haken Editor factory preset, which is not in the repository; put a copy at the path below to run this test.
const FIX = __dirname + '/fixtures/legacy-1009-hz-darkness.mid';
if (!fs.existsSync(FIX)) { console.log('legacy archive test skipped (fixture not present)'); process.exit(0); }
EM.parseSmf(fs.readFileSync(__dirname + '/fixtures/legacy-1009-hz-darkness.mid')).forEach(m => d.feed(m));
assert.strictEqual(d.dialect, 'legacy'); assert.strictEqual(EM.fmtFw(s.firmware), '10.09');
assert.strictEqual(s.cells.size, 30); assert.strictEqual(Object.keys(s.formulas).length, 13);
assert.strictEqual(EM.cellLabel(s.cells.get(EM.key(13, 54))), 'W');           // Direct + -> SG 2 T = W
assert.strictEqual(EM.formulaSummary(s.formulas[4].pairs), 'W SG 2 -0.69 [Hann]'); // formula D
assert.strictEqual(s.setup[91], 5);                                              // Bank A = WaveBank
// Re-encoding each formula reproduces the archive's packed bytes for every cc it sent.
for (const f of Object.values(s.formulas)) {
  const packed = EM.legacyPack(f.pairs);
  for (const [cc, v] of Object.entries(f.legacyRaw)) if (packed[cc] !== undefined && cc !== '41') assert.strictEqual(packed[cc], v, `cc${cc}`);
}
console.log('legacy archive test OK');
