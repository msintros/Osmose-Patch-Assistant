const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errors=[]; pg.on('pageerror', e => errors.push(e.message));
  await pg.addInitScript(() => {
    window.__sent = [];
    const input = { id: 'i1', name: 'Osmose Port 2', onmidimessage: null };
    const legacy = [[0xBF,102,7],[0xBF,103,113],[0xBF,104,6<<2],[0xBE,110,125],[0xBE,103,13],[0xBE,102,13],[0xBE,104,24],[0xBE,103,0],[0xBE,102,1],[0xBE,104,1],[0xBE,103,1],[0xBE,102,1],[0xBE,104,1],[0xBE,91,3],
      [0xBF,56,0],[0xD0|15,72],[0xD0|15,105],[0xBF,56,127],[0xBE,34,1],[0xBE,40,1],[0xBE,42,80],[0xBE,61,12+16]];
    const output = { id: 'o1', name: 'Osmose Port 2', send(m) { window.__sent.push(Array.from(m));
      if (m[0]===0xBF && m[1]===109) setTimeout(()=>legacy.forEach(x=>input.onmidimessage({data:new Uint8Array(x)})),20); } };
    navigator.requestMIDIAccess = async () => ({ inputs: new Map([['i1', input]]), outputs: new Map([['o1', output]]) });
  });
  await pg.goto('file://' + __dirname + '/../dist/osmose-patcher.html'); await pg.waitForTimeout(200);
  await pg.click('#connectBtn'); await pg.waitForTimeout(1100); await pg.click('#readBtn'); await pg.waitForTimeout(400);
  console.log('preset', await pg.textContent('#presetName'), '| info', await pg.textContent('#devinfo'), '| cables', await pg.locator('.cable path.vis').count());
  await pg.locator('.cable .chip', { hasText: 'A' }).first().click(); await pg.waitForTimeout(100);
  console.log('summary', await pg.textContent('#fsummary'));
  const n1 = await pg.evaluate(()=>window.__sent.length);
  await pg.locator('.comp .slider input[type=range]').first().fill('0.9'); await pg.waitForTimeout(80);
  console.log('legacy slider send', JSON.stringify(await pg.evaluate(n=>window.__sent.slice(n).filter(m=>m[1]!==116), n1)));
  // Add a filter (slot 2): older firmware has no known message for the type, so it is flagged, not sent.
  const n3 = await pg.evaluate(()=>window.__sent.length);
  await pg.click('.pitem[data-key="osc:filter"]'); await pg.waitForTimeout(120);
  console.log('legacy add filter send', JSON.stringify(await pg.evaluate(n=>window.__sent.slice(n).filter(m=>m[1]!==116), n3)), '| subtitle', await pg.$eval('.node[data-node="osc2"] text.sub', e => e.firstChild.nodeValue));
  // Knob on slot 2 Width (col 17): legacy matrix constants on ch15.
  const n4 = await pg.evaluate(()=>window.__sent.length);
  const kb = await pg.locator('.knob[data-knob="c17"] circle.face').boundingBox();
  await pg.mouse.move(kb.x+kb.width/2, kb.y+kb.height/2); await pg.mouse.down(); await pg.mouse.move(kb.x+kb.width/2, kb.y-30, {steps:3}); await pg.mouse.up(); await pg.waitForTimeout(100);
  console.log('legacy knob send', JSON.stringify(await pg.evaluate(n=>window.__sent.slice(n).filter(m=>m[1]!==116), n4)));
  await pg.click('.pitem[data-key="mod:pressure"]'); await pg.waitForTimeout(100);
  const n2 = await pg.evaluate(()=>window.__sent.length);
  await pg.evaluate(() => window.osmosePatcher.connect('m:mod1', 16)); await pg.waitForTimeout(80);
  console.log('legacy connect send', JSON.stringify(await pg.evaluate(n=>window.__sent.slice(n).filter(m=>m[1]!==116), n2)));
  await pg.screenshot({ path: (process.env.SHOTS || '/tmp') + '/shot4.png' });
  console.log('errors', errors); await b.close();
})();
