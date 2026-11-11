const fs=require('fs'), EM=require('../src/protocol.js');
for (const f of fs.readdirSync(__dirname+'/fixtures').filter(f=>f.endsWith('.mid'))) {
  const msgs=EM.parseSmf(fs.readFileSync(__dirname+'/fixtures/'+f));
  const s=EM.newState(); const ev=[];
  const d=new EM.Decoder(s,e=>{ if(e.type==='dialect'||e.type==='name') ev.push(e)});
  msgs.forEach(m=>d.feed(m));
  console.log(f, msgs.length,'msgs', d.dialect, JSON.stringify(ev), 'cells', s.cells.size, 'formulas', Object.keys(s.formulas).length, 'setup', Object.keys(s.setup).length);
  const cells=[...s.cells].slice(0,8).map(([k,c])=>{const [r,cc]=EM.unkey(k);return `${EM.ROW_NAMES[r]}->${EM.COL_NAMES[cc]}=${EM.cellLabel(c)}`});
  console.log('  ',cells.join(' | '));
  for (const [n,f] of Object.entries(s.formulas).slice(0,3)) console.log('   ',EM.formulaLetter(+n), EM.formulaSummary(f.pairs));
  console.log('   banks', s.setup[91], s.setup[92], s.setup[93], 'osc', [72,73,74,75,76].map(i=>s.setup[i]));
}
