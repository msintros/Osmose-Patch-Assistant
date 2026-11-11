const EM=require('../src/protocol.js'); const assert=require('assert');
// roundtrip pack/unpack
const p={}; p[EM.F.SgW]=3; p[EM.F.MultW]=1; p[EM.F.ScaleW]=1; p[EM.F.SWMacr]=2; EM.heightSet(p,EM.F.HeightW,-0.2);
EM.heightSet(p,EM.F.VEndY,0.6); p[EM.F.MultY]=4; p[EM.F.HBegY]=3; p[EM.F.InitZ]=1; p[EM.F.FormOp]=1; p[EM.F.ShapeW]=11;
const raw=EM.legacyPack(p); const back=EM.legacyUnpack(raw);
for (const id of Object.keys(p)) assert.strictEqual(EM.fget(back,+id), p[id], 'id '+id);
assert.strictEqual(EM.heightGet(back,EM.F.HeightW), -0.2);
// synthetic legacy stream
const s=EM.newState(); const d=new EM.Decoder(s); d.setDialect('auto');
const send=(arr)=>arr.forEach(m=>d.feed(m));
send([[0xBE,110,125],[0xBE,103,13],[0xBE,102,13],[0xBE,104,24],[0xBE,103,0],[0xBE,102,1],[0xBE,116,50],[0xBE,104,27],[0xBE,91,9]]);
send([[0xBE,34,1],...Object.entries(raw).map(([c,v])=>[0xBE,+c,v])]);
assert.strictEqual(d.dialect,'legacy');
assert.strictEqual(EM.cellLabel(s.cells.get(EM.key(13,13))),'X');
assert.strictEqual(EM.cellLabel(s.cells.get(EM.key(1,0))),'.5');
assert.strictEqual(s.setup[91],9);
assert.strictEqual(EM.heightGet(s.formulas[1].pairs,EM.F.HeightW),-0.2);
// encoder legacy
const out=EM.Encoder.setCell('legacy',1,0,{code:EM.CODE.DEC,dec:2500});
assert.deepStrictEqual(out,[[0xBE,103,0],[0xBE,102,1],[0xBE,116,25],[0xBE,115,0],[0xBE,104,27]]);
assert.deepStrictEqual(EM.Encoder.setCell('legacy',13,13,{code:EM.CODE.X}).pop(),[0xBE,104,24]);
// modern encoder
assert.deepStrictEqual(EM.Encoder.setCell('modern',13,13,{code:EM.CODE.X}),[[0xBF,41,13],[0xBF,40,13],[0xBF,45,115],[0xBF,44,46]]);
const prev={...p}; const next={...p}; EM.heightSet(next,EM.F.HeightW,0.5);
const lch=EM.Encoder.formulaChanges('legacy',1,{},next,prev);
assert.deepStrictEqual(lch,[[0xBE,34,1],[0xBE,71,0],[0xBE,42,50]]);
const mch=EM.Encoder.formulaChanges('modern',1,{13:0,42:50},next,prev);
assert.deepStrictEqual(mch,[[0xBF,34,1],[0xBF,56,19],[0xAF,13,0],[0xBF,56,19],[0xAF,42,50]]);
console.log('legacy + encoder tests OK; legacy pack sample', JSON.stringify(raw));
