/* Osmose Patcher: modular-style front end for the EaganMatrix. Depends on protocol.js (EM). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const svg = ['svg', 'g', 'rect', 'circle', 'path', 'text', 'line', 'title'].includes(tag);
    const e = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(k => k != null && e.append(k.nodeType ? k : document.createTextNode(k)));
    return e;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('osmosePatcher.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('osmosePatcher.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ======================================================================= state
  let S = EM.newState();
  let dec;
  let userDialect = store.get('dialect', 'auto');
  let selected = null;            // {kind:'cable', row, col} | {kind:'node', id} | {kind:'formula', num}
  let portName = '';
  const editing = { until: 0 };   // suppress inspector re-render while the user drags a slider

  function makeDecoder() {
    dec = new EM.Decoder(S, onDeviceEvent);
    if (userDialect !== 'auto') dec.setDialect(userDialect);
  }
  makeDecoder();

  /** Dialect used for sending. */
  function dialect() {
    if (userDialect !== 'auto') return userDialect;
    if (dec.dialect !== 'auto') return dec.dialect;
    if (S.hardware === 6 || /osmose/i.test(portName)) return 'legacy';
    if (S.firmware != null) return S.firmware >= 1030 ? 'modern' : 'legacy';
    return 'legacy';
  }

  // ======================================================================= modules in the patch
  const MOD = EMModules, MODS = EMMods;
  const DEFS = MOD.slotDefs();
  const START = ['master'];   // the Control sources (Direct / Multiply rows) stay behind the scenes
  let placed = new Set(START);       // hardware slot ids shown in the patch
  let mods = new Map();              // modulators and macros: id -> {id, kind:'gesture'|'macro', g, letter, sg, params, index}
  const positions = store.get('positions3', {});   // node id -> [x, y], once a module has been placed or dragged
  const COL_X = { controls: 30, source: 30, mod: 30, macro: 300, osc: 570, bank: 860, sg: 860, master: 1150 };
  const ownedSgs = () => new Set([...mods.values()].filter(m => m.sg).map(m => 'sg' + m.sg));
  const ownedLetters = () => new Map([...mods.values()].filter(m => m.letter).map(m => [m.letter, m]));

  /** Slots whose rows or columns carry a cell. */
  function touchedSlots() {
    const t = new Set(), byCol = new Map(), byRow = new Map(), owned = ownedSgs();
    for (const d of Object.values(DEFS)) { if (d.kind === 'controls') continue; d.cols.forEach(c => byCol.set(c, d.id)); d.rows.forEach(r => byRow.set(r, d.id)); }
    for (const k of S.cells.keys()) {
      const [r, c] = EM.unkey(k);
      if (byCol.has(c) && !owned.has(byCol.get(c))) t.add(byCol.get(c));
      const cell = S.cells.get(k);
      const hidden = MOD.isDialCell(r, cell) && isDialInput(c);
      if (byRow.has(r) && !hidden) t.add(byRow.get(r));
    }
    return t;
  }
  function syncPlaced() {
    for (const id of touchedSlots()) placed.add(id);
    // Macro modules: one for each macro that a macro cable uses or that the preset names.
    for (const cell of S.cells.values()) {
      const n = cell.code & 63; if (!EM.isFormulaCode(n)) continue;
      const m = MODS.macroOf(S.formulas[n]?.pairs);
      if (m !== null && m < 90) ensureMacro(m, true);
    }
    // Macros the preset names appear too, unless you removed them.
    for (const idx of Object.keys(MODS.macroNames(S.text))) if (!dismissedMacros.has(+idx)) ensureMacro(+idx);
  }
  const dismissedMacros = new Set();   // macros removed from the screen (cleared when a preset is read)
  function ensureMacro(i, used) {
    if (used || !mods.has('macro' + i)) dismissedMacros.delete(i);
    if (!mods.has('macro' + i)) mods.set('macro' + i, { id: 'macro' + i, kind: 'macro', index: i });
  }

  /** Describe a modulator or macro as a node. Rows are its parameters (knobs), no inputs. */
  function describeMod(m) {
    const n = { id: m.id, kind: m.kind === 'macro' ? 'macro' : 'mod', params: [], outputs: [{ src: 'm:' + m.id, label: 'out' }], cols: [], rows: [], mod: m,
      inputs: [{ label: 'In', kind: 'audio', col: 'mi:' + m.id, desc: 'Optional. Plug a signal in here and this module scales it (like a VCA): out = In × this modulator. Leave it empty to use the modulator on its own.' }] };
    if (m.kind === 'macro') {
      const nm = MODS.macroNames(S.text)[m.index];
      n.title = 'Macro ' + EM.macroName(m.index); n.subtitle = nm ? nm.name : (m.index < 6 ? 'Osmose macro control' : 'extra macro');
      n.params = [{ key: 'value', label: nm && nm.lo ? `${nm.lo} → ${nm.hi}` : 'Value', type: 'num', min: m.index < 6 ? 0 : -1, max: 1, step: 0.001,
        desc: 'The macro’s current value. Moving it here moves it on the Osmose.' }];
    } else {
      const g = MODS.GESTURES[m.g];
      n.title = g.name; n.subtitle = `formula ${EM.formulaLetter(m.letter)}` + (m.sg ? ` · shape gen ${m.sg}` : ''); n.desc = g.desc;
      n.params = g.params;
    }
    return n;
  }
  const modParamGet = (m, key) => m.kind === 'macro' ? macroValue(m.index) : m.params[key];

  // ======================================================================= node layout
  const NODE_W = 214, ROW_H = 24, HEAD_H = 42;
  let NODES = [];
  const nodeById = id => NODES.find(n => n.id === id);
  const rowsOf = n => n.mod ? [...n.inputs, ...(n.params || [])] : n.inputs.length ? n.inputs : (n.params || []);
  const headerOut = n => rowsOf(n).length > 0 && n.outputs.length === 1;
  const nodeHeight = n => HEAD_H + Math.max(rowsOf(n).length, headerOut(n) ? 0 : n.outputs.length, 1) * ROW_H + 8;
  function buildNodes() {
    const order = Object.keys(DEFS);
    const ids = [...placed].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    NODES = [];
    // Modules sit wherever they were dragged. One without a spot yet goes under the others in its
    // kind's column (Osc/Filter slot 1 on top), and keeps that spot from then on.
    const all = [];
    for (const id of ids) {
      const n = MOD.describeNode(DEFS[id], S);
      if (n.type?.needsMasterLeft) { const src = MOD.jennySource(S, n.slot, placed); n.subtitle += src ? ` · phase from slot ${src}` : ' · no phase source'; }
      all.push(n);
    }
    const ordered = [...mods.values()].sort((a, b) => (a.kind === 'macro') - (b.kind === 'macro') || (a.kind === 'macro' ? a.index - b.index : 0));
    for (const m of ordered) all.push(describeMod(m));
    const fresh = [];
    for (const n of all) { const p = positions[n.id]; if (p) { n.x = p[0]; n.y = p[1]; NODES.push(n); } else fresh.push(n); }
    let saved = false;
    for (const n of fresh) {
      const x = COL_X[n.kind] ?? 300;
      const below = NODES.filter(o => o.x < x + NODE_W && o.x + NODE_W > x).reduce((y, o) => Math.max(y, o.y + nodeHeight(o) + 18), 24);
      n.x = x; n.y = below; positions[n.id] = [n.x, n.y]; saved = true;
      NODES.push(n);
    }
    if (saved) store.set('positions3', positions);
    indexPorts();
  }
  const srcKey = o => o.src || o.row;           // an output is a matrix row number, or 'm:<id>' for a modulator
  const portIn = new Map(), portOut = new Map(); // col -> {n, i, inp}, src -> {n, i}
  function indexPorts() {
    portIn.clear(); portOut.clear();
    NODES.forEach(n => { n.inputs.forEach((p, i) => portIn.set(p.col, { n, i, inp: p })); n.outputs.forEach((p, i) => portOut.set(srcKey(p), { n, i })); });
  }
  const inXY = col => { const h = portIn.get(col); return h ? [h.n.x, h.n.y + HEAD_H + h.i * ROW_H + ROW_H / 2] : null; };
  const outXY = src => {
    const h = portOut.get(src); if (!h) return null;
    return headerOut(h.n) ? [h.n.x + NODE_W, h.n.y + HEAD_H / 2 - 2] : [h.n.x + NODE_W, h.n.y + HEAD_H + h.i * ROW_H + ROW_H / 2];
  };
  const isControlRow = r => typeof r === 'string' || r >= 13;
  /** Is this column an input that has a dial (so constants into it show as the dial, not as cables)? */
  function isDialInput(col) {
    const h = portIn.get(col);
    if (h) return h.inp.kind === 'ctl';
    // not placed yet: look the slot up directly
    const d = Object.values(DEFS).find(x => x.cols.includes(col));
    if (!d) return false;
    const n = MOD.describeNode(d, S);
    const inp = n.inputs.find(i => i.col === col);
    return !!inp && inp.kind === 'ctl';
  }
  /** Modulators used as a VCA: col -> the modulator whose letter is on that column's × row. */
  function vcaByCol() {
    const out = new Map(), own = ownedLetters();
    for (const [k, c] of S.cells) {
      const [r, col] = EM.unkey(k); if (r !== 16) continue;
      const src = cableSource(16, c);
      if (typeof src === 'string') { const m = mods.get(src.slice(2)); if (m && m.ins && m.ins.length) out.set(col, m); }
    }
    return out;
  }
  /** A signal cell that is really "source → modulator In" (drawn into the modulator, not to the column). */
  const isVcaFeed = (r, c, vb) => { const m = (vb || vcaByCol()).get(c); return !!m && r !== 16 && m.ins.includes(r); };
  const isHiddenCell = (r, c, cell, vb) => (MOD.isDialCell(r, cell) && isDialInput(c)) || isVcaFeed(r, c, vb);
  /** Where a cell's cable is drawn from: a modulator / macro that owns its formula, or its matrix row. */
  function cableSource(r, cell) {
    if (r >= 13 && r <= 16) {
      const n = cell.code & 63;
      if (EM.isFormulaCode(n)) {
        const own = ownedLetters().get(n);
        if (own) return 'm:' + own.id;
        const m = MODS.macroOf(S.formulas[n]?.pairs);
        if (m !== null && mods.has('macro' + m)) return 'm:macro' + m;
      }
    }
    return r;
  }
  const fmtVal = v => { const a = Math.abs(v); return (a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '') || '0'; };

  // ======================================================================= SVG rendering
  const svg = $('#canvas');
  const view = store.get('view', { x: 0, y: 0, k: 1 });
  let gRoot, gNodes, gCables, gPorts, gChips, tempPath;
  function applyView() { gRoot.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`); }
  function toWorld(evt) {
    const r = svg.getBoundingClientRect();
    return [(evt.clientX - r.left - view.x) / view.k, (evt.clientY - r.top - view.y) / view.k];
  }
  function cablePath(a, b) {
    const dx = Math.max(40, Math.abs(b[0] - a[0]) * 0.5);
    return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`;
  }
  // Point along the cable; labels sit near the input end, where cables are spread out.
  function bezMid(a, b, t = 0.72) {
    const dx = Math.max(40, Math.abs(b[0] - a[0]) * 0.5);
    const p0 = a, p1 = [a[0] + dx, a[1]], p2 = [b[0] - dx, b[1]], p3 = b, mt = 1 - t;
    return [0, 1].map(i => mt ** 3 * p0[i] + 3 * mt * mt * t * p1[i] + 3 * mt * t * t * p2[i] + t ** 3 * p3[i]);
  }

  function renderAll() {
    syncPlaced(); buildNodes();
    svg.textContent = '';
    gRoot = el('g'); gCables = el('g'); gNodes = el('g'); gPorts = el('g'); gChips = el('g');
    gRoot.append(gNodes, gCables, gPorts, gChips); // ports above cables so they stay grabbable
    tempPath = el('path', { class: 'tempcable', d: '' });
    gRoot.append(tempPath);
    svg.append(gRoot);
    applyView();
    NODES.forEach(renderNode);
    renderCables();
    renderHeader();
    renderPalette();
    refreshDialog();
  }

  /** A knob. spec: {key, label, desc, min, max, unit, get(), set(v), nudge(steps), type(), text?, blocked?} */
  function knob(spec, y) {
    const v = spec.get();
    const span = spec.max - spec.min, tt = x => Math.max(0, Math.min(1, (x - spec.min) / span));
    const t = tt(v), tz = tt(Math.max(spec.min, Math.min(spec.max, 0)));   // bipolar dials draw their arc from zero
    const cx = NODE_W - 16, cy = y, r = 8.5;
    const ang = a => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const a0 = -0.75 * Math.PI, a1 = a0 + t * 1.5 * Math.PI;
    const [sx, sy] = ang(a0), [ex, ey] = ang(a1), [mx, my] = ang(0.75 * Math.PI);
    const g = el('g', { class: 'knob' + (v !== 0 ? ' set' : '') + (spec.blocked ? ' blocked' : ''), 'data-knob': spec.key,
      'data-tip': `${spec.label}\n${spec.desc ? spec.desc + '\n' : ''}Now ${fmtVal(v)}${spec.unit ? ' ' + spec.unit : ''} (${spec.min} to ${spec.max}). Drag up or down, Shift for fine steps, scroll, or double-click to type.` });
    g.append(el('circle', { class: 'face', cx, cy, r: r + 2 }));
    g.append(el('path', { class: 'track', d: `M${sx},${sy} A${r},${r} 0 1 1 ${mx},${my}` }));
    if (Math.abs(t - tz) > 0.003) {
      const lo = Math.min(t, tz), hi = Math.max(t, tz);
      const [lx, ly] = ang(a0 + lo * 1.5 * Math.PI), [hx, hy] = ang(a0 + hi * 1.5 * Math.PI);
      g.append(el('path', { class: 'arc', d: `M${lx},${ly} A${r},${r} 0 ${(hi - lo) * 1.5 * Math.PI > Math.PI ? 1 : 0} 1 ${hx},${hy}` }));
    }
    g.append(el('line', { class: 'ptr', x1: cx, y1: cy, x2: ex, y2: ey }));
    g.addEventListener('pointerdown', e => startKnobDrag(e, spec));
    g.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); spec.nudge(-Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1)); }, { passive: false });
    const txt = spec.text != null ? spec.text : fmtVal(v);
    return [g, el('text', { class: 'kval' + (v !== 0 || spec.text ? ' set' : ''), x: NODE_W - 30, y: y + 4, 'text-anchor': 'end', text: txt })];
  }
  /** A bank column assigned to a property: its dial is that property's value (the same one as in
   *  the Properties list), and cables into the column add to it. */
  const propGet = inp => MOD.propToValue(inp.prop, S[inp.propStream]?.[inp.propIndex] ?? 0);
  function propSet(inp, v) {
    const raw = MOD.propFromValue(inp.prop, v);
    if (S[inp.propStream]?.[inp.propIndex] === raw) return;
    setBankProp(inp.propStream, inp.propIndex, raw);
  }
  function propKnob(inp) {
    const offset = MOD.dialValue(S, inp.col);
    return { key: 'c' + inp.col, label: inp.label, desc: inp.desc + (offset ? `\nThe matrix also adds ${fmtVal(offset)} to this column (from the preset).` : ''),
      min: inp.min, max: inp.max, step: inp.step, get: () => propGet(inp), set: v => propSet(inp, v),
      nudge: k => propSet(inp, propGet(inp) + k * inp.step), type: () => { const t = prompt(`${inp.label} (${inp.min} to ${inp.max})`, fmtVal(propGet(inp))); if (t !== null && t.trim() !== '' && !isNaN(+t)) propSet(inp, +t); } };
  }
  /** Knob spec for a module input: its constant, stored on the Direct rows. */
  function inputKnob(inp) {
    if (inp.prop) return propKnob(inp);
    const col = inp.col, v = () => coarseDial(col), fol = MOD.followOn(S, col, inp.follow);
    const oct = octaveOf(col), dt = detuneOf(col);
    return { key: 'c' + col, label: inp.label, desc: inp.desc, min: inp.min, max: inp.max, unit: inp.unit, step: inp.step,
      get: v, set: x => setDial(inp, x), nudge: k => nudgeDial(inp, k), type: () => typeDial(inp), blocked: !MOD.dialAvailable(S, col),
      text: fol ? inp.follow.label + (v() ? (v() > 0 ? '+' : '') + fmtVal(v()) : '') + (oct ? ` ${oct > 0 ? '+' : ''}${oct}oct` : '') + (dt ? ' ~' : '') : null };
  }
  // ---- pitch helpers for inputs that follow X: detune (app-side, folded into the dial constant) and
  // octave (a constant on the column's × row: ×0.25, ×0.5, ×2, ×4).
  const detuneOf = col => (S.detune && S.detune[col]) || 0;
  const coarseDial = col => Math.round((MOD.dialValue(S, col) - detuneOf(col)) * 10000) / 10000;
  const OCT_CELLS = { '-2': { code: 49, dec: 2500 }, '-1': { code: 49, dec: 5000 }, '1': { code: 51, dec: 0 }, '2': { code: 53, dec: 0 } };
  function octaveOf(col) {
    const c = S.cells.get(EM.key(16, col)); if (!c) return 0;
    for (const [k, w] of Object.entries(OCT_CELLS)) if ((c.code & 63) === w.code && (c.dec || 0) === w.dec) return +k;
    return 0;
  }
  function setOctave(inp, k) {
    const c = S.cells.get(EM.key(16, inp.col));
    if (c && !octaveOf(inp.col)) { setStatus('This input’s × row is already used (a modulator scales it), so there is no room for an octave shift.', 'warn'); return; }
    setCell(16, inp.col, OCT_CELLS[k] || null);
  }
  function setDetune(inp, d) {
    const coarse = coarseDial(inp.col);
    S.detune = S.detune || {}; S.detune[inp.col] = Math.round(d * 10000) / 10000;
    if (!MOD.dialAvailable(S, inp.col)) return;
    for (const [r, cell] of MOD.dialWrites(S, inp.col, Math.round((coarse + S.detune[inp.col]) * 10000) / 10000)) queueCell(r, inp.col, cell);
    scheduleRender(false);
  }
  /** Knob spec for a modulator parameter or a macro value. */
  function paramKnob(m, p) {
    const get = () => modParamGet(m, p.key);
    const set = x => setModParam(m, p.key, x);
    return { key: m.id + ':' + p.key, label: p.label, desc: p.desc, min: p.min, max: p.max, unit: p.unit, step: p.step, get, set,
      nudge: k => set(get() + k * Math.max(p.step || 0.01, (p.max - p.min) / 100)),
      type: () => { const t = prompt(`${p.label} (${p.min} to ${p.max})`, fmtVal(get())); if (t !== null && t.trim() !== '' && !isNaN(+t)) set(+t); } };
  }

  function renderNode(n) {
    const g = el('g', { class: 'node k-' + n.kind + (selected?.kind === 'node' && selected.id === n.id ? ' sel' : ''), transform: `translate(${n.x},${n.y})`, 'data-node': n.id });
    const h = nodeHeight(n);
    g.append(el('rect', { class: 'body', width: NODE_W, height: h, rx: 8 }));
    g.append(el('rect', { class: 'head', width: NODE_W, height: HEAD_H - 4, rx: 8 }));
    g.append(el('text', { x: 10, y: 16, text: n.title, 'font-weight': 600 }));
    const def = DEFS[n.id];
    const unsent = def && def.typeId && unsentSetup.has(def.typeId);
    g.append(el('text', { class: 'sub' + (unsent ? ' warn' : ''), x: 10, y: 30, text: unsent ? '⚠ type not sent to the device' : n.subtitle }));
    const tip = unsent ? 'Type not sent\nThis firmware’s message for the module type is not known yet, so the Osmose still has its previous type in this slot.'
      : `${n.title}\n${n.desc || n.type?.desc || (n.kind === 'master' ? 'Everything sent to L/R in goes through the Master effects. Use the buttons here for the Global FX and convolution settings.' : '')}\nClick anywhere on the module for its settings.`;
    const hit = el('rect', { class: 'headhit', width: NODE_W, height: HEAD_H - 4, fill: 'transparent', 'data-tip': tip });
    g.append(hit);
    // A click anywhere on a module selects it (ports and dials handle their own clicks); the title bar also drags it.
    g.addEventListener('pointerdown', e => {
      e.stopPropagation(); hideTip();
      if (e.button !== 0) return;
      const [wx, wy] = toWorld(e);
      if (e.target === hit) {
        drag = { kind: 'node', n, ox: wx - n.x, oy: wy - n.y, moved: false }; svg.classList.add('dragging');
        svg.setPointerCapture(e.pointerId);
        gNodes.append(g); gPorts.append(gPorts.querySelector(`[data-nodep="${CSS.escape(n.id)}"]`));   // bring to front
      } else select({ kind: 'node', id: n.id });
    });
    if (n.kind === 'master') {
      // Buttons for the Master effects windows
      [['Global FX', openRecirc, 82, 60], ['Convolution', openConv, 146, 62]].forEach(([label, fn, x, w]) => {
        const b = el('g', { class: 'hbtn', 'data-tip': label === 'Convolution' ? 'Convolution\nThe pre and post convolution (body) settings.' : 'Global FX\nThe recirculator: reverb, delay and echo type and controls.' });
        b.append(el('rect', { x, y: 9, width: w, height: 19, rx: 5 }), el('text', { x: x + w / 2, y: 22, 'text-anchor': 'middle', text: label }));
        b.addEventListener('pointerdown', e => { e.stopPropagation(); fn(); });
        g.append(b);
      });
    }
    const gp = el('g', { class: 'node', transform: `translate(${n.x},${n.y})`, 'data-nodep': n.id });
    n.inputs.forEach((p, i) => {
      const y = HEAD_H + i * ROW_H + ROW_H / 2;
      const info = `${p.label}\n${p.desc || ''}${p.unknownSel ? '\nThe device has not reported what this column is assigned to.' : ''}${typeof p.col === 'number' ? '\nMatrix column: ' + EM.COL_NAMES[p.col] : ''}`;
      const pg = el('g', { class: 'port in ' + p.kind, 'data-col': p.col, 'data-tip': info });
      pg.append(el('circle', { cx: 0, cy: y, r: 6 }));
      pg.append(el('rect', { x: -11, y: y - 10, width: 22, height: 20, fill: 'transparent' }));
      g.append(el('text', { class: 'plabel' + (p.kind === 'none' ? ' unused' : '') + (p.unknownSel ? ' unknown' : ''), x: 12, y: y + 4, text: p.label, 'data-tip': info }));
      if (p.kind === 'ctl' && !p.unassigned) { const [kg, kt] = knob(inputKnob(p), y); gp.append(kg); g.append(kt); }   // knobs sit above cables
      gp.append(pg);
    });
    if (n.params && (n.mod || !n.inputs.length)) n.params.forEach((p, i) => {
      const y = HEAD_H + (i + (n.mod ? n.inputs.length : 0)) * ROW_H + ROW_H / 2;
      g.append(el('text', { class: 'plabel', x: 12, y: y + 4, text: p.label, 'data-tip': `${p.label}\n${p.desc || ''}` }));
      if (p.type === 'num') { const [kg, kt] = knob(paramKnob(n.mod, p), y); gp.append(kg); g.append(kt); }
      else g.append(el('text', { class: 'kval set', x: NODE_W - 12, y: y + 4, 'text-anchor': 'end', text: p.options[modParamGet(n.mod, p.key)] ?? '' }));
    });
    n.outputs.forEach((p, i) => {
      const y = headerOut(n) ? HEAD_H / 2 - 2 : HEAD_H + i * ROW_H + ROW_H / 2;
      const src = srcKey(p);
      const pg = el('g', { class: 'port out ' + (isControlRow(src) ? 'control' : 'audio'), 'data-src': src,
        'data-tip': `${typeof src === 'string' ? n.title : EM.ROW_NAMES[src]} output\nDrag to an input to connect.` });
      pg.append(el('circle', { cx: NODE_W, cy: y, r: 6 }));
      pg.append(el('rect', { x: NODE_W - 11, y: y - 10, width: 22, height: 20, fill: 'transparent' }));
      pg.addEventListener('pointerdown', e => startCableDrag(e, src));
      if (!headerOut(n)) g.append(el('text', { class: 'plabel', x: NODE_W - 12, y: y + 4, 'text-anchor': 'end', text: p.label }));
      gp.append(pg);
    });
    gNodes.append(g); gPorts.append(gp);
  }

  /** Short chip text for a cable: a macro cable shows its amount, a modulator cable its letter. */
  function chipLabel(src, cell) {
    if (typeof src === 'string' && src.startsWith('m:macro')) {
      const p = S.formulas[cell.code & 63]?.pairs;
      const amt = EM.heightGet(p, EM.F.HeightW) * EM.OPTIONS.multVal[EM.fget(p, EM.F.MultW) & 7];
      return '×' + fmtVal(amt);
    }
    return EM.cellLabel(cell);
  }
  function renderCables() {
    gCables.textContent = ''; gChips.textContent = '';
    const vb = vcaByCol();
    // Signals into a modulator's In (they live in the matrix as cells into each column the modulator scales).
    for (const m of mods.values()) for (const r of (m.ins || [])) {
      const a = outXY(r), b = inXY('mi:' + m.id); if (!a || !b) continue;
      const sel = selected?.kind === 'modin' && selected.id === m.id && selected.row === r;
      const g = el('g', { class: 'cable audio' + (sel ? ' sel' : '') }), d = cablePath(a, b);
      const pick = e => { e.stopPropagation(); select({ kind: 'modin', id: m.id, row: r }); };
      g.append(el('path', { class: 'vis', d }), el('path', { class: 'hit', d, onpointerdown: pick }));
      gCables.append(g);
    }
    for (const [k, cell] of S.cells) {
      const [r, c] = EM.unkey(k);
      if (isHiddenCell(r, c, cell, vb)) continue;   // shown as the input's dial, or as a cable into a modulator's In
      const src = cableSource(r, cell);
      const a = outXY(src), b = inXY(c);
      if (!a || !b) continue;
      const sel = selected?.kind === 'cable' && selected.row === r && selected.col === c;
      const cls = 'cable ' + (typeof src === 'string' ? 'mod' : isControlRow(r) ? 'control' : 'audio') + (cell.code & 64 ? ' muted' : '') + (sel ? ' sel' : '');
      const g = el('g', { class: cls });
      const d = cablePath(a, b);
      const pick = e => { e.stopPropagation(); select({ kind: 'cable', row: r, col: c }); };
      g.append(el('path', { class: 'vis', d }), el('path', { class: 'hit', d, onpointerdown: pick }));
      const m = bezMid(a, b), label = (r === 16 ? '× ' : '') + chipLabel(src, cell);
      const w = 10 + label.length * 7.2;
      const chip = el('g', { class: 'chip', transform: `translate(${m[0] - w / 2},${m[1] - 9})`, onpointerdown: pick,
        'data-tip': `${typeof src === 'string' ? portOut.get(src)?.n.title : EM.ROW_NAMES[r]} → ${portIn.get(c)?.inp.label || EM.COL_NAMES[c]}\nValue ${EM.cellLabel(cell)}. Click to edit.` });
      chip.append(el('rect', { width: w, height: 18, rx: 9 }), el('text', { x: w / 2, y: 13, 'text-anchor': 'middle', text: label }));
      gCables.append(g);
      gChips.append(el('g', { class: cls }, chip)); // labels above everything else
    }
  }

  let renderQueued = false;
  function scheduleRender(full) {
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAll(); if (full !== false) renderInspector(); });
  }

  /** Pan just enough to bring a node into view. */
  function ensureVisible(n) {
    if (!n) return;
    const r = svg.getBoundingClientRect(), pad = 20;
    const x0 = n.x * view.k + view.x, y0 = n.y * view.k + view.y, x1 = x0 + NODE_W * view.k, y1 = y0 + nodeHeight(n) * view.k;
    let dx = 0, dy = 0;
    if (x1 > r.width - pad) dx = r.width - pad - x1; if (x0 + dx < pad) dx = pad - x0;
    if (y1 > r.height - pad) dy = r.height - pad - y1; if (y0 + dy < pad) dy = pad - y0;
    if (dx || dy) { view.x += dx; view.y += dy; applyView(); store.set('view', view); }
  }
  /** Zoom and pan so every module is visible. */
  function fitView() {
    if (!NODES.length) return;
    const r = svg.getBoundingClientRect(); if (!r.width) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    NODES.forEach(n => { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + nodeHeight(n)); });
    const pad = 30, k = Math.max(0.3, Math.min(1.2, (r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad - 40) / (y1 - y0)));
    view.k = k; view.x = pad - x0 * k + Math.max(0, (r.width - 2 * pad - (x1 - x0) * k) / 2); view.y = pad - y0 * k;
    applyView(); store.set('view', view);
  }
  // After a preset arrives, fit once the burst of messages settles.
  let fitTimer = null, fitArmed = false;
  function fitSoon(arm) {
    if (arm) fitArmed = true;
    if (!fitArmed) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { fitArmed = false; renderAll(); fitView(); }, 300);
  }

  function renderHeader() {
    $('#presetName').textContent = S.name || '';
    const fw = S.firmware != null ? 'fw ' + EM.fmtFw(S.firmware) : '';
    const hw = S.hardware ? (EM.HARDWARE[S.hardware] || 'hw ' + S.hardware) : '';
    $('#devinfo').textContent = [hw, fw, 'speaking ' + dialectLabel(dialect())].filter(Boolean).join(' · ');
  }
  const dialectLabel = d => d === 'legacy' ? 'legacy protocol (10.09)' : 'modern protocol (10.3x+)';

  // ======================================================================= palette (side strip)
  const paletteState = { q: '', open: store.get('paletteOpen', {}) };
  function renderPalette() {
    const box = $('#palette'); if (!box) return;
    const keepFocus = document.activeElement?.id === 'palQ';
    box.textContent = '';
    box.append(el('h2', { text: 'Add modules' }));
    const oscUsed = [1, 2, 3, 4, 5].filter(k => placed.has('osc' + k)).length;
    const sgUsed = [1, 2, 3, 4, 5].filter(k => placed.has('sg' + k)).length;
    const banks = ['A', 'B', 'C'].map(b => placed.has('bank' + b) ? b : '·').join(' ');
    box.append(el('div', { class: 'usage' },
      el('span', { title: 'The EaganMatrix has 5 Osc/Filter slots' }, el('b', { text: `${oscUsed}/5` }), ' osc/filter'),
      el('span', { title: 'Banks A, B and C (dots are free)' }, el('b', { text: banks }), ' banks'),
      el('span', { title: 'The EaganMatrix has 5 shape generators' }, el('b', { text: `${sgUsed}/5` }), ' shape gens')));
    const q = el('input', { id: 'palQ', type: 'search', placeholder: 'Search…', value: paletteState.q });
    q.addEventListener('input', () => { paletteState.q = q.value; renderPalette(); });
    box.append(q);
    const items = MOD.paletteItems();
    const osm = MOD.osmoseLike(S, portName);
    const needle = paletteState.q.trim().toLowerCase();
    for (const group of MOD.GROUP_ORDER) {
      const list = items.filter(it => it.group === group && (!needle || (it.name + ' ' + group).toLowerCase().includes(needle)));
      if (!list.length) continue;
      const open = needle || paletteState.open[group] !== false;
      const h = el('h3', { class: 'pgroup' + (open ? ' open' : ''), text: group, onclick: () => { paletteState.open[group] = !open; store.set('paletteOpen', paletteState.open); renderPalette(); } });
      box.append(h);
      if (!open) continue;
      for (const it of list) {
        const res = availability(it, osm);
        const where = res.error ? res.short || res.error : it.kind === 'osc' ? `goes in slot ${res.slotId.slice(3)}` : it.kind === 'bank' ? `goes in Bank ${res.slotId.slice(4)}`
          : it.kind === 'sg' ? `becomes SG ${res.slotId.slice(2)}` : it.kind === 'gesture' ? (it.sg ? 'uses a formula and a shape gen' : 'uses one formula') : it.kind === 'macro' ? (it.index === null ? 'next free m macro' : 'add its module') : 'add to the patch';
        box.append(el('button', { class: 'pitem', disabled: !!res.error, 'data-tip': `${it.name}
${it.desc || ''}${res.error ? '\nNot available: ' + res.error : ''}`, 'data-key': it.key, onclick: () => addModule(it) },
          el('span', { text: it.name }), el('small', { text: where })));
      }
    }
    if (keepFocus) { const n = $('#palQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  }
  function availability(it, osm = MOD.osmoseLike(S, portName)) {
    let res = it.kind === 'gesture' || it.kind === 'macro' ? modAvailability(it) : MOD.findSlot(it, new Set([...placed, ...ownedSgs()]), S);
    if (!res.error && it.type?.osmoseUnsupported && osm) res = { error: 'Not available on the Osmose', short: 'not on the Osmose' };
    return res;
  }
  /** Put a new module's top-left corner at `at` (world coordinates), or under its column when not given. */
  function placeAt(id, at) { if (at) { positions[id] = [Math.round(at[0]), Math.round(at[1])]; store.set('positions3', positions); } else delete positions[id]; }
  function addModule(it, at) {
    if (it.kind === 'gesture' || it.kind === 'macro') {
      const av = modAvailability(it);
      if (av.error) { setStatus(av.error, 'warn'); return; }
      let id;
      if (it.kind === 'macro') { ensureMacro(av.index); id = 'macro' + av.index; }
      else id = addGesture(it.g).id;
      placeAt(id, at);
      logInfo(`Added ${it.name}`);
      selected = { kind: 'node', id };
      renderAll(); if (!at) ensureVisible(nodeById(id)); renderInspector();
      return;
    }
    const res = MOD.findSlot(it, new Set([...placed, ...ownedSgs()]), S);
    if (res.error) { setStatus(res.error, 'warn'); return; }
    const def = DEFS[res.slotId];
    if (res.wire !== undefined && def.typeId) setSetup(def.typeId, res.wire);
    if (it.kind === 'bank') applyBankDefaults(def, it.type);
    // Like a new oscillator or bank in the Haken Editor, the main Freq input follows the played pitch (X).
    if ((it.kind === 'osc' && it.type.group === 'Oscillators') || it.kind === 'bank') {
      const fi = MOD.describeNode(def, S).inputs.find(i => i.follow === MOD.FOLLOW_X && /^Freq$|^F1$/.test(i.label));
      if (fi && !S.cells.get(EM.key(13, fi.col))) setFollow(fi, true);
    }
    if (it.kind === 'sg' && S.setup[def.typeId] === undefined) S.setup[def.typeId] = 0;
    placeAt(res.slotId, at);
    placed.add(res.slotId);
    logInfo(`Added ${it.name} (${res.slotId})`);
    selected = { kind: 'node', id: res.slotId };
    renderAll(); if (!at) ensureVisible(nodeById(res.slotId)); renderInspector();
  }

  // ======================================================================= right-click menu on the canvas
  const MENU_CATS = [
    ['Oscillators', it => it.group === 'Oscillators'],
    ['Filters', it => it.group === 'Filters'],
    ['Processors', it => it.group === 'Processors'],
    ['Banks', it => it.kind === 'bank'],
    ['Modulation', it => it.group === 'Modulation'],
    ['Macros', it => it.group === 'Macros'],
    ['Sources', it => it.group === 'Sources'],
  ];
  function menuItems() {
    const items = MOD.paletteItems().filter(it => it.key !== 'osc:filter');
    // Each filter type is its own entry here.
    const filters = Object.values(MOD.OSC_FAMILY).filter(t => t.group === 'Filters')
      .map(t => ({ key: 'osc:' + t.value, name: t.name, group: 'Filters', kind: 'osc', type: t, desc: t.desc }));
    const order = MOD.GROUP_ORDER;
    return MENU_CATS.map(([name, test]) => [name, (name === 'Filters' ? filters : items.filter(test))
      .sort((a, b) => a.kind === 'bank' && b.kind === 'bank' ? order.indexOf(a.group) - order.indexOf(b.group) : 0)]);
  }
  let ctxMenu = null;
  function closeMenu() { ctxMenu?.remove(); ctxMenu = null; }
  function openMenu(e) {
    closeMenu(); hideTip();
    const wrap = $('#canvasWrap'), r = wrap.getBoundingClientRect(), at = toWorld(e), osm = MOD.osmoseLike(S, portName);
    const menu = el('div', { class: 'ctxmenu', id: 'ctxMenu' });
    menu.addEventListener('pointerdown', ev => ev.stopPropagation());
    menu.addEventListener('contextmenu', ev => ev.preventDefault());
    menu.append(el('div', { class: 'ctxhead', text: 'Add here' }));
    let sub = null;
    for (const [cat, list] of menuItems()) {
      if (!list.length) continue;
      const row = el('div', { class: 'ctxcat', 'data-cat': cat }, el('span', { text: cat }), el('span', { class: 'arrow', text: '›' }));
      const show = () => {
        menu.querySelectorAll('.ctxcat.open').forEach(x => x.classList.remove('open'));
        row.classList.add('open'); sub?.remove();
        sub = el('div', { class: 'ctxmenu sub' });
        let lastGroup = null;
        for (const it of list) {
          if (cat === 'Banks' && lastGroup !== null && it.group !== lastGroup) sub.append(el('div', { class: 'ctxsep' }));
          lastGroup = it.group;
          const res = availability(it, osm);
          sub.append(el('button', { class: 'ctxitem', disabled: !!res.error, 'data-key': it.key,
            'data-tip': `${it.name}\n${it.desc || it.type?.desc || ''}${res.error ? '\nNot available: ' + res.error : ''}`,
            onclick: () => { closeMenu(); addModule(it, at); } }, it.name));
        }
        menu.append(sub);
        // Beside the category, flipped left or up when it would run off the canvas.
        const mw = menu.offsetWidth, top = row.offsetTop;
        sub.style.left = (menu.offsetLeft + mw + sub.offsetWidth > r.width ? -sub.offsetWidth + 2 : mw - 2) + 'px';
        sub.style.top = Math.max(-menu.offsetTop + 4, Math.min(top - 4, r.height - menu.offsetTop - sub.offsetHeight - 4)) + 'px';
      };
      row.addEventListener('pointerenter', show);
      row.addEventListener('click', show);
      menu.append(row);
    }
    wrap.append(menu);
    const x = e.clientX - r.left, y = e.clientY - r.top;
    menu.style.left = Math.min(x, r.width - menu.offsetWidth - 4) + 'px';
    menu.style.top = Math.min(y, r.height - menu.offsetHeight - 4) + 'px';
    ctxMenu = menu;
  }
  svg.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (e.target === svg || e.target === gRoot) openMenu(e); else closeMenu();
  });
  document.addEventListener('pointerdown', e => { if (ctxMenu && !ctxMenu.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  function removeModule(id) {
    if (mods.has(id)) return removeMod(mods.get(id));
    const def = DEFS[id]; if (!def || def.fixed) return;
    // Anything this module fed into a modulator's In goes too, so it can't come back on a later cable.
    for (const m of mods.values()) for (const r of def.rows) if (m.ins && m.ins.includes(r)) disconnectModIn(m, r);
    const cells = [...S.cells.keys()].map(EM.unkey).filter(([r, c]) => def.rows.includes(r) || def.cols.includes(c));
    cells.forEach(([r, c]) => setCell(r, c, null));
    placed.delete(id); delete positions[id]; store.set('positions3', positions);
    if (selected?.kind === 'node' && selected.id === id) selected = null;
    scheduleRender();
  }

  // ======================================================================= interactions on canvas
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if ((e.target === svg || e.target === gRoot) && e.button === 0) {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
      svg.classList.add('panning'); svg.setPointerCapture(e.pointerId);
    }
  });
  const lastKnob = { key: '', t: 0 };
  function startKnobDrag(e, spec) {
    e.stopPropagation(); hideTip();
    const now = Date.now();
    if (lastKnob.key === spec.key && now - lastKnob.t < 350) { lastKnob.t = 0; spec.type(); return; }
    lastKnob.key = spec.key; lastKnob.t = now;
    drag = { kind: 'knob', spec, sy: e.clientY, v0: spec.get(), moved: false };
    editing.until = Date.now() + 100000;
    svg.setPointerCapture(e.pointerId);
  }
  function startCableDrag(e, src) {
    e.stopPropagation(); hideTip();
    drag = { kind: 'cable', src, from: outXY(src) };
    svg.setPointerCapture(e.pointerId);
  }
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; drag.moved = true; applyView();
    } else if (drag.kind === 'node') {
      const [wx, wy] = toWorld(e), { n } = drag;
      const x = Math.round(wx - drag.ox), y = Math.round(wy - drag.oy);
      if (!drag.moved && Math.abs(x - n.x) + Math.abs(y - n.y) < 3) return;
      drag.moved = true; n.x = x; n.y = y; positions[n.id] = [x, y];
      const sel = `[data-node="${CSS.escape(n.id)}"],[data-nodep="${CSS.escape(n.id)}"]`;
      gRoot.querySelectorAll(sel).forEach(g => g.setAttribute('transform', `translate(${x},${y})`));
      renderCables();
    } else if (drag.kind === 'knob') {
      const { spec } = drag, span = spec.max - spec.min;
      const v = drag.v0 + (drag.sy - e.clientY) * span / 180 * (e.shiftKey ? 0.1 : 1);
      if (Math.abs(drag.sy - e.clientY) > 1) drag.moved = true;
      spec.set(Math.max(spec.min, Math.min(spec.max, v)));
    } else if (drag.kind === 'cable') {
      tempPath.setAttribute('d', cablePath(drag.from, toWorld(e)));
      document.querySelectorAll('.port.in.hot').forEach(p => p.classList.remove('hot'));
      const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.port.in');
      if (t) t.classList.add('hot');
    }
  });
  svg.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag; drag = null; svg.classList.remove('panning', 'dragging');
    if (d.kind === 'pan' && !d.moved) select(null);
    if (d.kind === 'pan') store.set('view', view);
    if (d.kind === 'node') { if (d.moved) { store.set('positions3', positions); scheduleRender(false); } else select({ kind: 'node', id: d.n.id }); }
    if (d.kind === 'knob') {
      editing.until = 0;
      const n = NODES.find(x => x.id === d.spec.key.split(':')[0]) || portIn.get(+d.spec.key.slice(1))?.n;
      if (n && !d.moved) select({ kind: 'node', id: n.id }); else scheduleRender();
    }
    if (d.kind === 'cable') {
      tempPath.setAttribute('d', '');
      const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.port.in');
      if (t) connect(d.src, /^\d+$/.test(t.dataset.col) ? +t.dataset.col : t.dataset.col);
    }
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(2.5, Math.max(0.3, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
    applyView(); store.set('view', view);
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected?.kind === 'cable') { e.preventDefault(); deleteCable(selected.row, selected.col); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected?.kind === 'modin') { e.preventDefault(); disconnectModIn(mods.get(selected.id), selected.row); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected?.kind === 'node') { e.preventDefault(); removeModule(selected.id); }
    if (e.key === 'Escape') select(null);
  });

  function select(s) { selected = s; scheduleRender(); if (s?.kind === 'cable') requestFormulaIfNeeded(s.row, s.col); }

  // ======================================================================= editing operations
  const pendingLetters = new Set();   // letters handed out but not yet in a cell (e.g. a modulator with no cable yet)
  function usedFormulaNumbers() {
    const used = new Set();
    for (const c of S.cells.values()) if (EM.isFormulaCode(c.code & 63)) used.add(c.code & 63);
    return used;
  }
  function freeFormula() {
    const used = usedFormulaNumbers();
    for (const n of ownedLetters().keys()) used.add(n);
    for (const n of pendingLetters) used.add(n);
    const max = dialect() === 'modern' ? 44 : 22;
    for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
    return null;
  }
  function connect(row, col) {
    if (typeof col === 'string' && col.startsWith('mi:')) return connectModIn(row, mods.get(col.slice(3)));
    if (typeof row === 'string') return connectMod(mods.get(row.slice(2)), col);
    const k = EM.key(row, col);
    const existing = S.cells.get(k);
    if (existing && isHiddenCell(row, col, existing)) {
      // The Direct row holds this input's dial value: move the value to the other dial rows first.
      const v = MOD.dialValue(S, col); setCell(row, col, null);
      S.cells.set(k, { code: 63, dec: 0 });                 // placeholder so dialWrites skips this row
      const w = MOD.dialWrites(S, col, v); S.cells.delete(k);
      w.forEach(([r, c]) => setCell(r, col, c));
    } else if (existing) { select({ kind: 'cable', row, col }); return; }
    let cell;
    if (isControlRow(row)) {
      const n = freeFormula();
      if (n) {
        cell = { code: n, dec: 0 };
        // Start the letter from a clean, silent state so leftovers on the device do not surprise you.
        const fresh = {};
        [EM.F.FormOp, EM.F.SgW, EM.F.ScaleW, EM.F.ShapeW].forEach(id => fresh[id] = 0);
        [EM.F.MultW, EM.F.MultX, EM.F.MultY, EM.F.MultZ].forEach(id => fresh[id] = 3);
        [EM.F.HeightW, EM.F.VBegX, EM.F.VEndX, EM.F.VBegY, EM.F.VEndY, EM.F.VBegZ, EM.F.VEndZ].forEach(id => EM.heightSet(fresh, id, 0));
        const prev = S.formulas[n]?.pairs || {};
        S.formulas[n] = { pairs: { ...prev, ...fresh } };
        setCell(row, col, cell);
        sendFormula(n, fresh, S.formulas[n].pairs, null, [row, col]);
      } else cell = { code: EM.CODE.ONE, dec: 0 };
    } else cell = { code: EM.CODE.ONE, dec: 0 };
    if (!S.cells.has(k)) setCell(row, col, cell);
    select({ kind: 'cable', row, col });
    logInfo(`Connected ${EM.ROW_NAMES[row]} → ${EM.COL_NAMES[col]} = ${EM.cellLabel(cell)}`);
  }
  // ---- modulators and macros
  /** Put a formula letter on a free Direct row into col, keeping the input's dial value. Returns the row or null. */
  function placeOnDirect(col, letter) {
    for (const r of [13, 14]) {
      const cur = S.cells.get(EM.key(r, col));
      if (cur && (cur.code & 63) === letter) return r;
      if (cur && !MOD.isDialCell(r, cur)) continue;
      const v = MOD.dialValue(S, col);
      setCell(r, col, { code: letter, dec: 0 });
      for (const [rr, c] of MOD.dialWrites(S, col, v)) setCell(rr, col, c);
      return r;
    }
    return null;
  }
  function connectMod(m, col) {
    if (!m) return;
    // Key tracking into a frequency input means "play in tune": that is X itself, not a scaled formula
    // (a formula's output is linear, so the notes would bunch up like overtones).
    const inp = portIn.get(col)?.inp;
    if (m.kind === 'gesture' && m.g === 'keytrack' && inp?.follow === MOD.FOLLOW_X) {
      setFollow(inp, true);
      setStatus(`${inp.label} now follows the played pitch exactly (X), a semitone per key.`, 'ok');
      return;
    }
    let letter;
    if (m.kind === 'gesture') letter = m.letter;
    else {
      letter = freeFormula();
      if (!letter) { setStatus('No free formula letters left for another macro cable.', 'warn'); return; }
      const pairs = MODS.macroFormula(m.index, 1);
      S.formulas[letter] = { pairs };
      sendFormula(letter, pairs, pairs, null, null);
    }
    if (m.ins && m.ins.length) return placeVca(m, col, letter);
    const r = placeOnDirect(col, letter);
    if (r === null) { setStatus('Both Direct rows into that input already carry cables.', 'warn'); return; }
    pendingLetters.delete(letter);
    logInfo(`Connected ${describeMod(m).title} → ${EM.COL_NAMES[col]} (formula ${EM.formulaLetter(letter)})`);
    select({ kind: 'cable', row: r, col });
  }
  // ---- modulators as VCAs: out = In × modulator. In EaganMatrix terms the In signals go on the
  // destination column's own rows and the modulator's letter on its × (Multiply) row.
  function placeVca(m, col, letter) {
    const cur = S.cells.get(EM.key(16, col));
    if (cur && (cur.code & 63) !== letter) {
      setStatus('That input is already scaled by something else. The Osmose has one × row per input, so only one modulator can scale it.', 'warn');
      if (m.kind === 'macro') { delete S.formulas[letter]; }
      return false;
    }
    setCell(16, col, { code: letter, dec: 0 });
    for (const r of m.ins) if (!S.cells.get(EM.key(r, col))) setCell(r, col, { code: EM.CODE.ONE, dec: 0 });
    pendingLetters.delete(letter);
    const other = [...S.cells.keys()].map(EM.unkey).filter(([r, c]) => c === col && r !== 16 && !m.ins.includes(r) && !MOD.isDialCell(r, S.cells.get(EM.key(r, c))));
    logInfo(`${describeMod(m).title} scales → ${EM.COL_NAMES[col]} (formula ${EM.formulaLetter(letter)} on the × row)`);
    setStatus(other.length ? `Connected. Note: the other ${other.length} cable${other.length > 1 ? 's' : ''} into this input ${other.length > 1 ? 'are' : 'is'} scaled too (the × row multiplies the whole input).` : 'Connected: this input now gets In × the modulator.', other.length ? 'warn' : 'ok');
    select({ kind: 'cable', row: 16, col });
    return true;
  }
  /** Where a modulator's output goes: [row, col] cells drawn from it. */
  const modOuts = m => modCells(m);
  function connectModIn(src, m) {
    if (!m) return;
    if (typeof src === 'string') { setStatus('A modulator’s In takes an audio signal (an oscillator, bank, noise…), not another modulator.', 'warn'); return; }
    if (isControlRow(src)) { setStatus('Plug an audio signal into In. To combine control signals, cable both to the same input.', 'warn'); return; }
    m.ins = m.ins || [];
    if (m.ins.includes(src)) return;
    const wasVca = m.ins.length > 0;
    m.ins.push(src);
    if (wasVca) {
      for (const [r, c] of modOuts(m)) if (r === 16 && !S.cells.get(EM.key(src, c))) setCell(src, c, { code: EM.CODE.ONE, dec: 0 });
    } else {
      // Its direct outputs become scaled ones: the letter moves from the Direct row to the × row.
      for (const [r, c] of modOuts(m)) {
        const cell = S.cells.get(EM.key(r, c)), letter = cell.code & 63;
        setCell(r, c, null);
        for (const [rr, cc] of MOD.dialWrites(S, c, MOD.dialValue(S, c))) setCell(rr, c, cc);
        if (!placeVca(m, c, letter)) { /* × row taken: that output is dropped */ }
      }
    }
    if (!wasVca && m.kind === 'gesture') applyGesture(m, false);
    logInfo(`${EM.ROW_NAMES[src]} → ${describeMod(m).title} In`);
    scheduleRender();
  }
  function disconnectModIn(m, src) {
    const outs = modOuts(m).filter(([r]) => r === 16);
    for (const [, c] of outs) { const k = EM.key(src, c), cell = S.cells.get(k); if (cell) setCell(src, c, null); }
    m.ins = m.ins.filter(r => r !== src);
    if (!m.ins.length) {
      // Back to a plain modulator: its letter moves from the × row to a Direct row.
      for (const [, c] of outs) { const letter = S.cells.get(EM.key(16, c)).code & 63; setCell(16, c, null); placeOnDirect(c, letter); }
      if (m.kind === 'gesture') applyGesture(m, false);
    }
    if (selected?.kind === 'modin') selected = null;
    scheduleRender();
  }
  /** Delete a cable; a scaled (× row) cable also takes its In signals out of that input. */
  function deleteCable(row, col) {
    const cell = S.cells.get(EM.key(row, col));
    if (row === 16 && cell) {
      const src = cableSource(16, cell), m = typeof src === 'string' && mods.get(src.slice(2));
      if (m && m.ins) for (const r of m.ins) if (S.cells.get(EM.key(r, col))) setCell(r, col, null);
    }
    setCell(row, col, null);
  }
  function freeSg() {
    const taken = new Set([...placed, ...ownedSgs()]);
    for (let k = 1; k <= 5; k++) if (!taken.has('sg' + k)) return k;
    return null;
  }
  /** Can this palette item be added now? {ok} or {error, short}. */
  function modAvailability(it) {
    if (it.kind === 'macro') {
      if (it.index === null) {
        if (dialect() === 'legacy') return { error: 'Macros m7 to m90 need newer firmware', short: 'newer firmware only' };
        for (let i = 6; i < 90; i++) if (!mods.has('macro' + i)) return { index: i };
        return { error: 'All macros are in the patch', short: 'all added' };
      }
      return mods.has('macro' + it.index) ? { error: 'Already in the patch', short: 'already added' } : { index: it.index };
    }
    if (!freeFormula()) return { error: 'No free formula letters left', short: 'no free formula' };
    if (it.sg && !freeSg()) return { error: 'All 5 shape generators are in use', short: 'no free shape generator' };
    return {};
  }
  function addGesture(g) {
    const letter = freeFormula(), sg = MODS.GESTURES[g].sg ? freeSg() : null;
    let n = 1; while (mods.has('mod' + n)) n++;
    const m = { id: 'mod' + n, kind: 'gesture', g, letter, sg, params: MODS.defaults(g) };
    mods.set(m.id, m); pendingLetters.add(letter);
    applyGesture(m, true);
    return m;
  }
  /** Write a modulator's formula (and its shape generator settings) from its parameters. */
  function applyGesture(m, full) {
    const out = MODS.GESTURES[m.g].build(m.params, m.sg);
    // As a VCA (something in its In), a modulator that doesn't use W is gated by the key (W = 1 while
    // held): out = W × (…). Without it, a voice whose key is up could still leak a little signal.
    const P = out.pairs;
    if (m.ins && m.ins.length && !P[EM.F.SgW] && !P[EM.F.FormOp] && !EM.heightGet(P, EM.F.HeightW)) {
      P[EM.F.SgW] = 1; EM.heightSet(P, EM.F.HeightW, 1); P[EM.F.MultW] = 3; P[EM.F.FormOp] = 1;
    }
    if (full) {
      S.formulas[m.letter] = { pairs: out.pairs };
      sendFormula(m.letter, out.pairs, out.pairs, null, cellUsing(m.letter));
    } else editFormula(m.letter, p => { for (const k of Object.keys(p)) if (!(k in out.pairs)) delete p[k]; Object.assign(p, out.pairs); });
    if (out.sg && m.sg) {
      const def = DEFS['sg' + m.sg], cur = S.setup[def.typeId] ?? 0;
      if (full || (cur & 3) !== out.sg.type) setSetup(def.typeId, (cur & ~3) | out.sg.type);
      const fcol = def.cols[0], tcol = def.cols[1];
      if (Math.abs(MOD.dialValue(S, fcol) - out.sg.rate) > 1e-4) setSgRate(fcol, out.sg.rate);
      // Restart each note: the gate (W) triggers it. Free running: a constant 1, so it starts with
      // every voice and keeps cycling (with no trigger at all it never starts).
      const t = S.cells.get(EM.key(13, tcol)), want = out.sg.trigger ? 45 : 50;
      if (!t || (t.code & 63) !== want) setCell(13, tcol, { code: want, dec: 0 });
    }
  }
  /** A modulator's shape generator speed: constants into the SG's F column, up to 18 Hz (9 + 9). */
  function setSgRate(col, v) {
    v = Math.round(Math.max(0, Math.min(18, v)) * 100) / 100;
    const want = { 13: null, 14: null, 15: null };
    let rest = v; if (v > 9) { want[13] = { code: 58, dec: 0 }; rest = Math.round((v - 9) * 100) / 100; }
    Object.assign(want, MOD.encodeDial(rest, [14, 15]).cells);
    for (const r of [13, 14, 15]) {
      const cur = S.cells.get(EM.key(r, col)), w = want[r];
      const same = (!cur && !w) || (cur && w && cur.code === w.code && (cur.dec || 0) === (w.dec || 0));
      if (!same) queueCell(r, col, w);
    }
  }
  function setModParam(m, key, v) {
    if (m.kind === 'macro') return setMacroValue(m.index, v);
    const spec = MODS.GESTURES[m.g].params.find(p => p.key === key);
    if (spec.type === 'num') v = Math.round(Math.max(spec.min, Math.min(spec.max, v)) / spec.step) * spec.step;
    v = Math.round(v * 10000) / 10000;
    if (m.params[key] === v) return;
    m.params[key] = v;
    applyGesture(m, false);
    scheduleRender(false);
  }
  function macroValue(i) { const raw = S.macros[i]; return raw === undefined ? 0 : Math.round(EM.macroToValue(i, raw) * 1000) / 1000; }
  const pendingMacros = new Map(); let macroTimer = null;
  function setMacroValue(i, v) {
    v = Math.max(i < 6 ? 0 : -1, Math.min(1, v));
    S.macros[i] = EM.macroFromValue(i, v);
    pendingMacros.set(i, v);
    if (!macroTimer) macroTimer = setTimeout(() => { macroTimer = null; for (const [j, x] of pendingMacros) midiSend(EM.Encoder.setMacro(j, x)); pendingMacros.clear(); }, 30);
    scheduleRender(false);
  }
  /** Cells drawn from a modulator / macro. */
  function modCells(m) {
    const out = [];
    for (const [k, c] of S.cells) { const [r, col] = EM.unkey(k); if (cableSource(r, c) === 'm:' + m.id) out.push([r, col]); }
    return out;
  }
  function removeMod(m) {
    const cells = modCells(m);
    for (const [r, c] of cells) if (r === 16 && m.ins) for (const s2 of m.ins) if (S.cells.get(EM.key(s2, c))) cells.push([s2, c]);
    cells.forEach(([r, c]) => setCell(r, c, null));
    if (m.sg) { const d = DEFS['sg' + m.sg]; for (const [k] of [...S.cells]) { const [r, c] = EM.unkey(k); if (d.cols.includes(c)) setCell(r, c, null); } }
    pendingLetters.delete(m.letter);
    mods.delete(m.id); if (m.kind === 'macro') dismissedMacros.add(m.index);
    if (selected?.kind === 'node' && selected.id === m.id) selected = null;
    scheduleRender();
  }

  /** Swap the contents of two Osc/Filter slots: types, options and every cable and dial. */
  function swapOscSlots(a, b) {
    if (a === b) return;
    const A = DEFS['osc' + a], B = DEFS['osc' + b];
    for (const k of ['typeId', 'optId', 'exId']) {
      const va = S.setup[A[k]] ?? 0, vb = S.setup[B[k]] ?? 0;
      if (va !== vb) { setSetup(A[k], vb); setSetup(B[k], va); }
    }
    const colMap = new Map(), rowMap = new Map([[A.rows[0], B.rows[0]], [B.rows[0], A.rows[0]]]);
    A.cols.forEach((c, i) => { colMap.set(c, B.cols[i]); colMap.set(B.cols[i], c); });
    const moved = new Map();
    for (const [k, c] of S.cells) { const [r, cc] = EM.unkey(k); moved.set(EM.key(rowMap.get(r) ?? r, colMap.get(cc) ?? cc), c); }
    const keys = new Set([...S.cells.keys(), ...moved.keys()]);
    for (const k of keys) { const o = S.cells.get(k), nw = moved.get(k); if (o !== nw) { const [r, c] = EM.unkey(k); setCell(r, c, nw || null); } }
    const ha = placed.has(A.id), hb = placed.has(B.id);
    placed.delete(A.id); placed.delete(B.id);
    if (ha) placed.add(B.id); if (hb) placed.add(A.id);
    if (selected?.kind === 'node') selected = { kind: 'node', id: selected.id === A.id ? B.id : selected.id === B.id ? A.id : selected.id };
    else if (selected?.kind === 'cable') selected = null;
    scheduleRender();
  }
  function moveToSlot(from, to) { swapOscSlots(from, to); logInfo(`Moved slot ${from} to slot ${to}`); }
  /** Make the Jenny in slot j follow the oscillator in slot s, by moving them next to each other. */
  function setJennySource(j, s) {
    if (j > 1) { swapOscSlots(s, j - 1); return; }
    if (s < 5) { swapOscSlots(1, s + 1); return; }
    swapOscSlots(1, 5); swapOscSlots(1, 4);   // Jenny to 5, the oscillator to 4
  }
  function setCell(row, col, cell) {
    const k = EM.key(row, col);
    if (cell && (cell.code & 63)) S.cells.set(k, cell); else S.cells.delete(k);
    try { midiSend(EM.Encoder.setCell(dialect(), row, col, cell)); }
    catch (err) { logInfo('Not sent: ' + err.message); }
    if (!cell && selected?.kind === 'cable' && selected.row === row && selected.col === col) selected = null;
    scheduleRender();
  }
  function setMute(row, col, muted) {
    const k = EM.key(row, col), cell = S.cells.get(k);
    if (!cell) return;
    cell.code = (cell.code & 63) | (muted ? 64 : 0);
    midiSend(EM.Encoder.setMute(dialect(), row, col, cell, muted));
    scheduleRender();
  }
  const unsentSetup = new Set();  // settings shown here that the device could not be told about
  function setSetup(id, value) {
    let msgs;
    try { msgs = EM.Encoder.setSetup(dialect(), id, value); }
    catch (err) {
      S.setup[id] = value;
      if (midi.out) { logInfo('Not sent: ' + err.message); setStatus('Not sent: ' + err.message, 'warn'); unsentSetup.add(id); }
      scheduleRender(); return false;
    }
    S.setup[id] = value; unsentSetup.delete(id); midiSend(msgs);
    scheduleRender();
    return true;
  }
  // ---- dials: a control input's constant value, written as matrix constants on the Direct rows
  const pendingCells = new Map(); // key -> cell|null
  let cellFlushQueued = false;
  function queueCell(row, col, cell) {
    const k = EM.key(row, col);
    if (cell) S.cells.set(k, cell); else S.cells.delete(k);
    pendingCells.set(k, cell);
    if (!cellFlushQueued) {
      cellFlushQueued = true;
      setTimeout(() => {
        cellFlushQueued = false;
        const d = dialect();
        for (const [kk, c] of pendingCells) { const [r, cc] = EM.unkey(kk); try { midiSend(EM.Encoder.setCell(d, r, cc, c)); } catch (err) { logInfo('Not sent: ' + err.message); } }
        pendingCells.clear();
      }, 30);
    }
  }
  const snap = (v, inp) => { const st = Math.max(0.0001, (inp.step || 0.01)); return Math.round(Math.max(inp.min, Math.min(inp.max, v)) / st) * st; };
  function setDial(inp, v) {
    const col = inp.col;
    if (!MOD.dialAvailable(S, col)) { setStatus('The Direct rows into this input are all used by cables, so there is no room for a dial value.', 'warn'); return; }
    v = Math.round((snap(v, inp) + detuneOf(col)) * 10000) / 10000;
    for (const [r, cell] of MOD.dialWrites(S, col, v)) queueCell(r, col, cell);
    scheduleRender(false);
    const f = document.querySelector(`#inspector input[data-dial="${col}"]`); if (f && document.activeElement !== f) f.value = fmtVal(MOD.dialValue(S, col));
  }
  function nudgeDial(inp, steps) {
    const span = inp.max - inp.min;
    setDial(inp, coarseDial(inp.col) + steps * Math.max(inp.step || 0.01, span / 100));
  }
  function typeDial(inp) {
    const t = prompt(`${inp.label} (${inp.min} to ${inp.max}${inp.unit ? ' ' + inp.unit : ''})`, fmtVal(MOD.dialValue(S, inp.col)));
    if (t === null || t.trim() === '' || isNaN(+t)) return;
    setDial(inp, +t);
  }
  /** Turn an input's performance cable on or off (Direct + holding X for pitch, or W for gate). */
  function setFollow(inp, on) {
    const k = EM.key(13, inp.col), cur = S.cells.get(k);
    if (on) {
      const keep = MOD.dialValue(S, inp.col);
      if (cur && !MOD.isDialCell(13, cur)) { alert('The Direct + row into this input already holds ' + EM.cellLabel(cur) + '.'); return; }
      setCell(13, inp.col, { code: inp.follow.code, dec: 0 });
      for (const [r, cell] of MOD.dialWrites(S, inp.col, keep)) queueCell(r, inp.col, cell);
    } else if (cur && (cur.code & 63) === inp.follow.code) setCell(13, inp.col, null);
    scheduleRender();
  }

  function cellUsing(num) {
    for (const [k, c] of S.cells) if ((c.code & 63) === num) return EM.unkey(k);
    return null;
  }
  function sendFormula(num, changed, full, prev, rc) {
    midiSend(EM.Encoder.formulaChanges(dialect(), num, changed, full, prev, rc || cellUsing(num)));
  }
  // Coalesce rapid slider changes into one send per animation frame.
  const pendingFormula = new Map(); // num -> {changed, prev}
  let formulaFlushQueued = false;
  function editFormula(num, mutate) {
    const f = S.formulas[num] || (S.formulas[num] = { pairs: {} });
    const before = { ...f.pairs };
    mutate(f.pairs);
    const changed = {};
    for (const id of Object.keys(f.pairs)) if (f.pairs[id] !== before[id]) changed[id] = f.pairs[id];
    if (!Object.keys(changed).length) return;
    const p = pendingFormula.get(num) || { changed: {}, prev: before };
    Object.assign(p.changed, changed); pendingFormula.set(num, p);
    if (!formulaFlushQueued) {
      formulaFlushQueued = true;
      setTimeout(() => {
        formulaFlushQueued = false;
        for (const [n, q] of pendingFormula) sendFormula(n, q.changed, S.formulas[n].pairs, q.prev);
        pendingFormula.clear();
      }, 25);
    }
    renderCables();
    const sum = $('#fsummary'); if (sum) sum.textContent = EM.formulaSummary(f.pairs);
  }
  function requestFormulaIfNeeded(row, col) {
    const cell = S.cells.get(EM.key(row, col));
    if (!cell || !EM.isFormulaCode(cell.code & 63)) return;
    // Modern firmware streams a formula when its cell is selected; legacy sends all formulas with the preset.
    // Only ask when the app does not know the formula yet: a reply would otherwise overwrite local edits.
    if (dialect() === 'modern' && !S.formulas[cell.code & 63]) { listen(1500, false); midiSend(EM.Encoder.selectCell('modern', row, col)); }
  }

  // ======================================================================= inspector
  function renderInspector() {
    if (Date.now() < editing.until) { clearTimeout(renderInspector.t); renderInspector.t = setTimeout(renderInspector, editing.until - Date.now() + 30); return; }
    const a = $('#inspector'); a.textContent = '';
    if (!selected) return renderHome(a);
    if (selected.kind === 'cable') return renderCable(a, selected.row, selected.col);
    if (selected.kind === 'modin') {
      const m = mods.get(selected.id); if (!m) { selected = null; return renderHome(a); }
      a.append(el('h2', { text: `${EM.ROW_NAMES[selected.row]} → ${describeMod(m).title} In` }));
      a.append(el('p', { text: `${describeMod(m).title} scales this signal on its way to each input its output is cabled to.` }));
      a.append(el('div', { class: 'row' }, el('button', { class: 'danger', onclick: () => disconnectModIn(m, selected.row), text: 'Delete' })));
      return;
    }
    if (selected.kind === 'node') return renderNodePanel(a, nodeById(selected.id));
    if (selected.kind === 'formula') return renderFormulaPanel(a, selected.num);
  }

  function renderHome(a) {
    a.append(el('h2', { text: 'Patch overview' }));
    a.append(el('p', { text: 'Add modules from the strip on the left, or right-click an empty part of the canvas. Drag a module by its title bar to move it. Drag from an output (right edge) to an input (left edge) to connect them. Turn a knob by dragging it up or down, Shift for fine steps, double-click to type a value. Click a module’s title for its settings, or a cable label to change its value. Drag empty space to pan, scroll to zoom.' }));
    const kv = el('div', { class: 'kv' });
    const add = (k, v) => kv.append(el('span', { text: k }), el('span', { text: v }));
    add('Preset', S.name || '—'); add('Connections', String(S.cells.size));
    add('Device', S.hardware ? (EM.HARDWARE[S.hardware] || S.hardware) : (midi.out ? 'connected' : 'not connected'));
    add('Firmware', S.firmware != null ? EM.fmtFw(S.firmware) : '—'); add('Protocol', dialectLabel(dialect()));
    a.append(kv);
    const used = [...usedFormulaNumbers()].sort((x, y) => x - y);
    if (used.length) {
      a.append(el('h3', { text: 'Formulas in use' }));
      if (midi.out && dialect() === 'modern' && used.some(n => !S.formulas[n] || !Object.keys(S.formulas[n].pairs).length))
        a.append(el('div', { class: 'row' }, el('button', { onclick: fetchAllFormulas, text: 'Fetch formulas from device' })));
      const l = el('div', { class: 'list' });
      used.forEach(n => l.append(el('a', { onclick: () => select({ kind: 'formula', num: n }), text: `${EM.formulaLetter(n)}: ${EM.formulaSummary(S.formulas[n]?.pairs)}` })));
      a.append(l);
    }
    if (S.text) { a.append(el('h3', { text: 'Preset text' })); a.append(el('p', { text: S.text })); }
  }

  function connList(filter) {
    const l = el('div', { class: 'list' });
    for (const [k, c] of S.cells) {
      const [r, col] = EM.unkey(k);
      if (!filter(r, col)) continue;
      l.append(el('a', { onclick: () => select({ kind: 'cable', row: r, col }), text: `${EM.ROW_NAMES[r]} → ${EM.COL_NAMES[col]} = ${EM.cellLabel(c)}` }));
    }
    return l.childElementCount ? l : el('p', { text: 'No connections.' });
  }

  function selectRow(label, options, value, onchange, opts = {}) {
    const sl = el('select', { onchange: e => onchange(+e.target.value), disabled: opts.disabled });
    options.forEach(o => sl.append(el('option', { value: o.value, selected: o.value === value, disabled: o.disabled, text: o.text })));
    return el('div', { class: 'row', 'data-tip': opts.title ? `${label}\n${opts.title}` : null }, el('label', { text: label }), sl);
  }
  /** A slider + number row. spec: {label, desc, min, max, step, get(), set(v), disabled, fmt} */
  function sliderRow(spec) {
    const v = spec.get();
    const num = el('input', { type: 'number', step: spec.step, min: spec.min, max: spec.max, value: fmtVal(v), disabled: spec.disabled, 'data-key': spec.key });
    const rng = el('input', { type: 'range', step: spec.step, min: spec.min, max: spec.max, value: v, disabled: spec.disabled });
    let lastSet = null; // a re-render can blur the box and fire a second change for the same value
    num.addEventListener('change', () => { if (num.value !== '' && !isNaN(+num.value) && +num.value !== lastSet) { lastSet = +num.value; spec.set(+num.value); rng.value = num.value; } });
    rng.addEventListener('input', () => { editing.until = Date.now() + 600; num.value = rng.value; spec.set(+rng.value); });
    return el('div', { class: 'ctl', 'data-tip': `${spec.label}\n${spec.desc || ''}` }, el('label', { text: spec.label + (spec.unit ? ` (${spec.unit})` : '') }), rng, num);
  }

  function renderModPanel(a, n) {
    const m = n.mod;
    a.append(el('h2', { text: n.title }));
    if (m.kind === 'macro') {
      const nm = MODS.macroNames(S.text)[m.index];
      a.append(el('p', { text: nm ? `This preset calls it “${nm.name}”${nm.lo ? ` (${nm.lo} to ${nm.hi})` : ''}.` : `Macro ${EM.macroName(m.index)}.` }));
      a.append(sliderRow({ ...paramKnob(m, n.params[0]), label: 'Value' }));
      a.append(el('p', { class: 'muted', text: 'Cable this module to any input to let the macro move it. Each cable has its own amount; click its label to change it.' }));
      const l = el('div', { class: 'list' });
      for (const [r, c] of modCells(m)) l.append(el('a', { onclick: () => select({ kind: 'cable', row: r, col: c }), text: `→ ${portIn.get(c)?.n.title || ''} ${portIn.get(c)?.inp.label || EM.COL_NAMES[c]} ${chipLabel('m:' + m.id, S.cells.get(EM.key(r, c)))}` }));
      a.append(el('h3', { text: 'Cables' }), l.childElementCount ? l : el('p', { text: 'None yet.' }));
    } else {
      const g = MODS.GESTURES[m.g];
      a.append(el('p', { text: g.desc }));
      for (const p of g.params) {
        if (p.type === 'num') a.append(sliderRow(paramKnob(m, p)));
        else a.append(selectRow(p.label, idx(p.options), m.params[p.key], v => { m.params[p.key] = v; applyGesture(m, false); scheduleRender(); }, { title: p.desc }));
      }
      a.append(el('p', { class: 'muted', text: `Writes formula ${EM.formulaLetter(m.letter)}${m.sg ? ` and drives shape generator ${m.sg}` : ''}. Every cable from this module carries the same value.` }));
      a.append(el('div', { class: 'row' }, el('button', { onclick: () => select({ kind: 'formula', num: m.letter }), text: 'Show the formula' })));
      const l = el('div', { class: 'list' });
      for (const [r, c] of modCells(m)) l.append(el('a', { onclick: () => select({ kind: 'cable', row: r, col: c }), text: `→ ${portIn.get(c)?.n.title || ''} ${portIn.get(c)?.inp.label || EM.COL_NAMES[c]}` }));
      a.append(el('h3', { text: 'Cables' }), l.childElementCount ? l : el('p', { text: 'None yet: drag from the output at the top right to an input.' }));
    }
    a.append(el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { class: 'danger', onclick: () => removeModule(m.id), text: 'Remove from patch' })));
  }

  // ---- Master section settings (global cc), recirculator and convolution windows
  const pendingGlobals = new Map(); let globalTimer = null;
  function setGlobal(cc, v) {
    v = Math.max(0, Math.min(127, Math.round(v)));
    S.globals[cc] = v; pendingGlobals.set(cc, v);
    if (!globalTimer) globalTimer = setTimeout(() => { globalTimer = null; for (const [c, x] of pendingGlobals) midiSend(EM.Encoder.setGlobal(c, x)); pendingGlobals.clear(); }, 30);
  }
  const globalRow = (k, label) => sliderRow({ key: 'g' + k.cc, label: label || k.label, desc: k.desc + (S.globals[k.cc] === undefined ? ' (not reported by the device yet)' : ''),
    min: 0, max: 127, step: 1, get: () => S.globals[k.cc] ?? 0, set: v => setGlobal(k.cc, v) });
  function renderMasterSettings(a) {
    const K = MODS.MASTER_KNOBS;
    a.append(el('div', { class: 'row' }, el('button', { onclick: openRecirc, text: 'Global FX…' }), el('button', { onclick: openConv, text: 'Convolution…' })));
    a.append(el('h3', { text: 'Levels' })); K.levels.forEach(k => a.append(globalRow(k)));
    const tanh = (S.setup[16] ?? 0) === 1;
    a.append(el('h3', { text: tanh ? 'Saturation (tanh)' : 'Compressor' }));
    if (dialect() === 'modern') a.append(selectRow('Type', idx(['Compressor', 'Tanh saturation']), tanh ? 1 : 0, v => setSetup(16, v), { title: 'The Master section has either a compressor or a tanh saturator' }));
    K.comp.forEach(k => { const l = k.label[tanh ? 1 : 0]; if (l !== '—') a.append(globalRow(k, l)); });
    a.append(el('h3', { text: 'Tilt EQ' })); K.eq.forEach(k => a.append(globalRow(k)));
  }

  let dialogRender = null;
  function openDialog(title, render) {
    closeDialog();
    const box = el('div', { id: 'dlg', role: 'dialog' },
      el('div', { class: 'dlgcard' }, el('div', { class: 'dlghead' }, el('h2', { text: title }), el('button', { onclick: closeDialog, text: 'Close', 'aria-label': 'Close' })), el('div', { class: 'dlgbody' })));
    box.addEventListener('pointerdown', e => { if (e.target === box) closeDialog(); });
    document.body.append(box);
    dialogRender = render; refreshDialog(true);
  }
  function closeDialog() { $('#dlg')?.remove(); dialogRender = null; }
  function refreshDialog(force) {
    if (!dialogRender) return;
    if (!force && Date.now() < editing.until) return;
    const b = $('#dlg .dlgbody'); if (!b) return;
    const st = b.scrollTop; b.textContent = ''; dialogRender(b); b.scrollTop = st;
  }
  function openRecirc() {
    openDialog('Global FX (recirculator: reverb, delay, echo)', b => {
      const type = S.setup[62] ?? 0, T = MODS.RECIRC_TYPES[type] || MODS.RECIRC_TYPES[0];
      b.append(selectRow('Type', idx(MODS.RECIRC_TYPES.map(t => t.name)), type, v => { setSetup(62, v); refreshDialog(true); }, { title: 'Which effect the recirculator runs. Each type gives the dials below different jobs.' }));
      if (dialect() === 'modern') {
        const cb = el('input', { type: 'checkbox', checked: !S.setup[15], onchange: e => setSetup(15, e.target.checked ? 0 : 1) });
        b.append(el('div', { class: 'row' }, el('label', { text: 'Enabled' }), cb));
      } else b.append(el('div', { class: 'note', text: 'On older firmware the type change uses a message inferred from 10.09 preset files and is not tested yet.' }));
      T.dials.forEach((d, i) => { if (d !== '—') b.append(globalRow({ cc: MODS.RECIRC_CC[i], label: `R${i + 1} ${d}`, desc: MODS.RECIRC_DESC[d] || '' })); });
      b.append(globalRow({ cc: 24, label: 'Mix', desc: 'Dry / wet mix of the recirculator: 0 is off' }));
      b.append(el('p', { class: 'muted', text: 'Two Master columns (Recirc) can add to these dials from the patch, for example a shape generator moving the delay time.' }));
    });
  }
  function openConv() {
    openDialog('Convolution', b => {
      if (dialect() === 'legacy') { b.append(el('div', { class: 'note', text: 'Older firmware (10.09) stores convolution settings in a different layout that is not decoded yet, so they cannot be edited here. The Master columns Conv 1/2 index and mix still work as normal inputs.' })); return; }
      if (!S.conv.length) b.append(el('div', { class: 'note', text: 'The device has not sent its convolution settings yet. Read the patch from the Osmose first.' }));
      const c = S.conv, row = (id, label, desc, max = 127) => sliderRow({ key: 'cv' + id, label, desc, min: 0, max, step: 1, get: () => c[id] ?? 0, set: v => setConvVal(id, v) });
      b.append(el('h3', { text: 'Before the recirculator' }), row(0, 'Index', 'Which response, moving through the four set below (adds to the Conv 1 index column)'), row(1, 'Mix', 'Dry / wet (adds to the Conv 1 mix column)'));
      b.append(el('h3', { text: 'After the recirculator' }), row(2, 'Index', 'Adds to the Conv 2 index column'), row(3, 'Mix', 'Adds to the Conv 2 mix column'));
      for (let i = 0; i < 4; i++) {
        b.append(el('h3', { text: `Response ${i + 1}` }));
        b.append(selectRow('Material', idx(MODS.CONV_IRS), c[4 + i] ?? 6, v => setConvVal(4 + i, v), { title: 'The impulse response: wood, metal, fibre, space…' }));
        b.append(row(8 + i, 'Length', 'Shorter blurs less and can thin the low end'), row(12 + i, 'Tune', '64 is unchanged; lower is duller, higher is brighter'),
          row(16 + i, 'Width', 'Stereo width'), row(20 + i, 'Level L', 'Left level'), row(24 + i, 'Level R', 'Right level'));
      }
      const cb = el('input', { type: 'checkbox', checked: !!c[28], onchange: e => setConvVal(28, e.target.checked ? 1 : 0) });
      b.append(el('div', { class: 'row', 'data-tip': 'Equal power\nKeeps the level steadier when moving between responses' }, el('label', { text: 'Equal power' }), cb));
    });
  }
  function setConvVal(id, v) {
    try { midiSend(EM.Encoder.setConv(dialect(), id, v)); S.conv[id] = v; } catch (err) { setStatus('Not sent: ' + err.message, 'warn'); }
  }

  // ---- BiqGraph graphs
  const GRAPH_NAMES = { 2: 'Mode amplitudes', 3: 'Offset graph 1', 4: 'Offset graph 2' };
  let graphTab = 2;
  const pendingGraph = new Map(); let graphTimer = null;
  function setGraphPoint(g, i, v) {
    const arr = S.graphs[g] || (S.graphs[g] = []);
    for (let j = arr.length; j < 48; j++) arr[j] = g === 2 ? 0 : 48;
    if (arr[i] === v) return;
    arr[i] = v; pendingGraph.set(g * 64 + i, v);
    if (!graphTimer) graphTimer = setTimeout(() => {
      graphTimer = null;
      const d = dialect(), sentFull = new Set();
      for (const [k, x] of pendingGraph) {
        const gg = Math.floor(k / 64), ii = k % 64;
        if (d === 'legacy') { if (!sentFull.has(gg)) { sentFull.add(gg); midiSend(EM.Encoder.setGraph(d, gg, ii, S.graphs[gg][ii], S.graphs[gg])); } }
        else midiSend(EM.Encoder.setGraph(d, gg, ii, x));
      }
      pendingGraph.clear();
    }, dialect() === 'legacy' ? 80 : 30);
  }
  function openGraphs(def) {
    openDialog('BiqGraph graphs', b => {
      const tabs = el('div', { class: 'tabs' });
      [2, 3, 4].forEach(g => tabs.append(el('button', { class: g === graphTab ? 'sel' : '', text: GRAPH_NAMES[g], onclick: () => { graphTab = g; refreshDialog(true); } })));
      b.append(tabs);
      const g = graphTab, arr = S.graphs[g] || [], zero = g === 2 ? 0 : 48;
      const ext = S.setup[def && def.slot === 'B' ? 71 : 70], modes = ext !== undefined && ext < 6 ? (ext + 1) * 8 : 48;
      b.append(el('p', { class: 'muted', text: g === 2 ? 'Loudness of each mode (resonance). The top is 0 dB; each step down is quieter.'
        : `Offsets that a matrix column scales: the ${g === 3 ? '1' : '2'} column (1A / 1F, or 2A / 2B) multiplies this graph. The middle line is no offset.` }));
      if (!arr.length) b.append(el('div', { class: 'note', text: 'The device has not sent this graph yet; drawing starts from a flat line.' }));
      const W = 480, H = 200, bw = W / 48;
      const sv = el('svg', { class: 'graph', viewBox: `0 0 ${W} ${H}`, width: '100%' });
      const yOf = v => H - (v / 96) * H;
      if (g !== 2) sv.append(el('line', { class: 'zero', x1: 0, x2: W, y1: yOf(48), y2: yOf(48) }));
      for (let i = 0; i < 48; i++) {
        const v = arr[i] ?? zero;
        const y0 = yOf(Math.max(v, zero)), y1 = yOf(Math.min(v, zero));
        sv.append(el('rect', { class: 'bar' + (i >= modes ? ' off' : ''), x: i * bw + 1, y: Math.min(y0, y1), width: bw - 2, height: Math.max(1, Math.abs(y1 - y0)) }));
      }
      let last = null;   // fill in the bars between pointer events so a fast stroke leaves no gaps
      const paint = e => {
        const r = sv.getBoundingClientRect();
        const i = Math.max(0, Math.min(47, Math.floor((e.clientX - r.left) / r.width * 48)));
        const v = Math.max(0, Math.min(96, Math.round((1 - (e.clientY - r.top) / r.height) * 96)));
        const from = last || [i, v], steps = Math.abs(i - from[0]);
        for (let s = 0; s <= steps; s++) {
          const j = steps ? from[0] + Math.sign(i - from[0]) * s : i, vv = steps ? Math.round(from[1] + (v - from[1]) * s / steps) : v;
          setGraphPoint(g, j, vv);
          const bar = sv.querySelectorAll('rect.bar')[j];
          const y0 = yOf(Math.max(vv, zero)), y1 = yOf(Math.min(vv, zero));
          bar.setAttribute('y', Math.min(y0, y1)); bar.setAttribute('height', Math.max(1, Math.abs(y1 - y0)));
        }
        last = [i, v];
        $('#graphVal').textContent = `Mode ${i + 1}: ${g === 2 ? v - 96 : v - 48} dB`;
      };
      sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); editing.until = Date.now() + 100000; last = null; paint(e); });
      sv.addEventListener('pointermove', e => { if (e.buttons) paint(e); });
      sv.addEventListener('pointerup', () => { editing.until = 0; });
      b.append(sv, el('div', { id: 'graphVal', class: 'muted', text: `${modes} modes in use${ext === 6 ? ' (variable)' : ''}. Drag across the bars to draw.` }));
      b.append(el('p', { class: 'muted', text: 'Both BiqGraph banks share these graphs. On older firmware every change resends the whole graph.' }));
    });
  }
  const idx = arr => arr.map((t, i) => ({ value: i, text: t }));

  function renderNodePanel(a, n) {
    if (!n) { selected = null; return renderHome(a); }
    if (n.mod) return renderModPanel(a, n);
    const def = DEFS[n.id], osm = MOD.osmoseLike(S, portName);
    let bankProps = null;   // a bank's Properties list goes after its other controls
    a.append(el('h2', { text: n.title }));
    if (n.subtitle) a.append(el('p', { text: n.subtitle }));
    const unknown = id => S.setup[id] === undefined;
    if (def.kind === 'osc') {
      const cur = S.setup[def.typeId] ?? 0;
      const opts = [];
      // The type list stays within the module's family: a Filter module offers every filter type.
      const fam = (MOD.OSC_FAMILY[cur] || MOD.OSC_FAMILY[0]).group;
      Object.values(MOD.OSC_FAMILY).filter(t => t.group === fam).forEach(t => opts.push({ value: t.value, text: t.name }));
      a.append(selectRow(fam === 'Filters' ? 'Filter type' : fam === 'Processors' ? 'Processor' : 'Oscillator', opts, cur, v => setSetup(def.typeId, v)));
      const t = n.type;
      const legacy = dialect() === 'legacy';
      const slotName = k => { const d = DEFS['osc' + k]; return placed.has(d.id) ? (MOD.OSC_FAMILY[S.setup[d.typeId] ?? 0]?.name || 'module') : 'empty'; };
      if (t?.needsMasterLeft) {
        // The firmware's Jenny follows the oscillator to its left; here that is picked by name.
        const src = MOD.jennySource(S, def.slot, placed);
        const cands = [1, 2, 3, 4, 5].filter(k => k !== def.slot && placed.has('osc' + k) && MOD.MASTER_OSC_TYPES.has(S.setup[72 + k - 1] ?? 0));
        const opts = [{ value: 0, text: '— none —', disabled: true }, ...cands.map(k => ({ value: k, text: `${slotName(k)} (slot ${k})` }))];
        a.append(selectRow('Phase from', opts, src || 0, k => setJennySource(def.slot, k),
          { disabled: legacy, title: legacy ? 'Moving modules between slots needs the module types to be sent, which this firmware does not support yet.' : 'The oscillator this Jenny takes its phase from. Picking one moves the modules so it sits in the slot just before the Jenny, as the Osmose requires.' }));
        if (!src) a.append(el('div', { class: 'note', text: cands.length ? 'This Jenny has no DSF, Integrated DSF or Phase oscillator in the slot before it, so it is silent. Pick one above.' : 'A Jenny needs a DSF, Integrated DSF or Phase oscillator to follow. Add one, then pick it above.' }));
      }
      a.append(selectRow('Slot', [1, 2, 3, 4, 5].map(k => ({ value: k, text: k === def.slot ? `Slot ${k}` : `Slot ${k} (${slotName(k)})` })), def.slot, k => moveToSlot(def.slot, k),
        { disabled: legacy, title: legacy ? 'Moving modules between slots needs the module types to be sent, which this firmware does not support yet.' : 'Move this module to another Osc/Filter slot. A module already there swaps places with it; cables move with them.' }));
      if (t?.options?.variant) a.append(selectRow('Variant', idx(t.options.variant), S.setup[def.optId] ?? 0, v => setSetup(def.optId, v)));
      if (t?.options?.cascade) a.append(selectRow('Cascade', idx(MOD.OSC_CASCADE), S.setup[def.optId] ?? 0, v => setSetup(def.optId, v), { title: 'Run the signal through this filter more than once for a steeper slope' }));
      if (t?.options?.extreme) {
        const cb = el('input', { type: 'checkbox', checked: !!S.setup[def.exId], onchange: e => setSetup(def.exId, e.target.checked ? 1 : 0) });
        a.append(el('div', { class: 'row', title: 'Update the filter coefficients at audio rate, for audio-rate modulation of cutoff and width' }, el('label', { text: 'Extreme' }), cb, el('span', { class: 'muted', text: 'audio-rate modulation' })));
      }
    } else if (def.kind === 'bank') {
      const cur = n.type;
      const opts = Object.values(MOD.BANKS).filter(b => b.slots.includes(def.slot))
        .map(b => ({ value: b.key, text: `${b.group}: ${b.name}${b.osmoseUnsupported && osm ? ' (not on Osmose)' : ''}`, disabled: b.osmoseUnsupported && osm }));
      const sl = el('select', { onchange: e => { const nb = MOD.BANKS[e.target.value]; setSetup(def.typeId, nb.value); if (nb !== cur && nb.selectors !== cur?.selectors) applyBankDefaults(def, nb); scheduleRender(); } });
      opts.forEach(o => sl.append(el('option', { value: o.value, selected: cur && o.value === cur.key, disabled: o.disabled, text: o.text })));
      a.append(el('div', { class: 'row' }, el('label', { text: 'Type' }), sl));
      for (const m of MOD.bankModeControls(cur, def)) a.append(selectRow(m.label + (unsentSetup.has(m.id) ? ' (not sent)' : ''), idx(m.options), S.setup[m.id] ?? 0, v => setSetup(m.id, v), { title: m.title }));
      if (cur?.selectors) {
        const which = cur.selectors.stream, arr = S[which], off = def.slot === 'A' ? 0 : 24;
        a.append(el('h3', { text: 'Assignable columns' }));
        a.append(el('div', { class: 'muted small', text: 'Pick a property for each column. Its slider is the property itself; cables into the column add to it.' }));
        if (!arr || n.inputs.every((inp, i) => !inp.assignable || arr[off + cur.selectors.base + (i - cur.selectors.firstCol)] === undefined)) a.append(el('div', { class: 'note', text: 'The device has not sent this bank’s column assignments yet. Read the patch from the Osmose to see them.' }));
        // Each property can drive only one column: options taken by another column are disabled.
        const selIds = n.inputs.map((inp, i) => inp.assignable ? off + cur.selectors.base + (i - cur.selectors.firstCol) : null);
        const assignedTo = {};
        selIds.forEach((id, i) => { if (id !== null && arr?.[id]) assignedTo[arr[id]] = i + 1; });
        n.inputs.forEach((inp, i) => {
          if (!inp.assignable) return;
          const id = selIds[i], mine = arr?.[id] ?? 0;
          const opts = cur.selectors.names.map((t, v) => ({ value: v, text: v && assignedTo[v] && v !== mine ? `${t} (on another column)` : t, disabled: !!(v && assignedTo[v] && v !== mine) }));
          const sl = el('select', { onchange: e => setBankProp(which, id, +e.target.value), 'data-sel': id });
          opts.forEach(o => sl.append(el('option', { value: o.value, selected: o.value === mine, disabled: o.disabled, text: o.text })));
          let ctl;
          if (inp.prop) {
            const row = sliderRow({ key: 'prop' + inp.propIndex, label: inp.label, desc: inp.desc, min: inp.min, max: inp.max, step: inp.step,
              disabled: dialect() === 'legacy' && (!arr || arr.length < 48), get: () => propGet(inp), set: v => propSet(inp, v) });
            row.querySelector('label').replaceWith(sl);
            ctl = row;
          } else {
            ctl = el('div', { class: 'ctl' }, sl, el('span', { class: 'muted small', text: mine ? '' : 'not used' }), el('span'));
          }
          ctl.classList.add('assign');
          ctl.dataset.tip = `Column ${i + 1}\nWhich property this column drives. A property can be on one column only.${inp.prop ? '\n' + inp.desc : ''}`;
          a.append(ctl);
          const offset = MOD.dialValue(S, inp.col);
          if (inp.prop && offset) a.append(el('div', { class: 'note' }, `The matrix also adds ${fmtVal(offset)} to this column (from the preset). `,
            el('a', { onclick: () => setDial({ ...inp, prop: undefined }, 0), text: 'Remove it' })));
        });
        if (cur.selectors.props) bankProps = () => {
          a.append(el('h3', { text: 'Properties' }));
          a.append(el('div', { class: 'muted small', text: 'All of the bank’s values. One that is on a column has the same slider in Assignable columns above; either one changes it.' }));
          for (const p of cur.selectors.props) {
            const id = off + p.id, col = assignedTo[p.id];
            const step = p.note || p.offset !== undefined ? 1 : (p.max - p.min) / 100;
            a.appendChild(sliderRow({ key: 'prop' + id, label: p.label + (col ? ` (col ${col})` : ''), desc: (p.sym ? `${p.sym}: ` : '') + p.desc + (col ? `\nColumn ${col} adds to this.` : ''),
              min: p.min, max: p.max, step, disabled: dialect() === 'legacy' && (!arr || arr.length < 48),
              get: () => MOD.propToValue(p, arr?.[id] ?? 0), set: v => { const raw = MOD.propFromValue(p, v); if (arr?.[id] !== raw) setBankProp(which, id, raw); } })).classList.add('wide');
          }
        };
      }
      if (def.slot !== 'A' && (cur?.key === 'CVC')) a.append(el('div', { class: 'note', text: 'CVC drives control-voltage outputs, which the Osmose does not have.' }));
    } else if (def.kind === 'sg') {
      const cur = S.setup[def.typeId] ?? 0;
      a.append(selectRow('Type', idx(MOD.SG_TYPES), cur & 3, v => setSetup(def.typeId, (cur & ~3) | v), { disabled: dialect() === 'legacy', title: dialect() === 'legacy' ? 'How the older firmware sets this is not known yet' : '' }));
      a.append(el('p', { text: `A formula uses this shape generator when its W source is "SG ${def.slot}".` }));
    } else if (def.kind === 'master') {
      renderMasterSettings(a);
      if (S.firmware != null && S.firmware >= 1060) {
        a.append(el('h3', { text: 'Assignable columns' }));
        for (let i = 0; i < 6; i++) a.append(selectRow(`Column ${i + 3}`, idx(MOD.MAST_ASSIGN), S.setup[27 + i] ?? 0, v => setSetup(27 + i, v)));
      }
    }
    if (def.kind === 'bank' && n.type?.key === 'BiqGraph') a.append(el('div', { class: 'row' }, el('button', { onclick: () => openGraphs(def), text: 'Edit graphs…' })));
    if (def.typeId && unknown(def.typeId) && def.kind !== 'master') a.append(el('p', { class: 'muted', text: 'The device has not reported this module’s type, so the default is shown.' }));

    const ctl = n.inputs.filter(p => p.kind === 'ctl' && !p.assignable);   // assignable bank columns have their sliders above
    if (ctl.length) {
      a.append(el('h3', { text: 'Controls' }));
      for (const inp of ctl) {
        const v = coarseDial(inp.col);
        const num = el('input', { type: 'number', step: inp.step, min: inp.min, max: inp.max, value: fmtVal(v), 'data-dial': inp.col, disabled: !MOD.dialAvailable(S, inp.col) });
        num.addEventListener('change', () => { if (num.value !== '' && !isNaN(+num.value)) setDial(inp, +num.value); });
        const rng = el('input', { type: 'range', step: inp.step, min: inp.min, max: inp.max, value: v, disabled: !MOD.dialAvailable(S, inp.col) });
        rng.addEventListener('input', () => { editing.until = Date.now() + 600; num.value = rng.value; setDial(inp, +rng.value); });
        const row = el('div', { class: 'ctl', 'data-tip': `${inp.label}\n${inp.desc || ''}` }, el('label', { text: inp.label + (inp.unit ? ` (${inp.unit})` : '') }), rng, num);
        a.append(row);
        if (inp.follow) {
          const cb = el('input', { type: 'checkbox', checked: MOD.followOn(S, inp.col, inp.follow), onchange: e => setFollow(inp, e.target.checked) });
          a.append(el('div', { class: 'follow' }, el('label', {}, cb, ` follow ${inp.follow.name} (${inp.follow.label})`), el('span', { class: 'muted', text: inp.follow.code === 46 ? ' the dial adds to it' : '' })));
          if (inp.follow.code === 46) {
            const oc = el('select', { onchange: e => setOctave(inp, e.target.value) });
            [['-2', '−2 octaves'], ['-1', '−1 octave'], ['0', 'none'], ['1', '+1 octave'], ['2', '+2 octaves']].forEach(([v2, t]) => oc.append(el('option', { value: v2, text: t, selected: +v2 === octaveOf(inp.col) })));
            a.append(el('div', { class: 'row', 'data-tip': 'Octave\nShifts this input by whole octaves: its value is multiplied by 0.25, 0.5, 2 or 4 (on the × row), so the pitch it follows stays in tune.' }, el('label', { text: 'Octave' }), oc));
            a.append(sliderRow({ key: 'dt' + inp.col, label: 'Detune (Hz)', desc: 'A fine offset in Hz added to the frequency, for slight detuning or beating against another oscillator. Shift for fine steps on the dial.',
              min: -10, max: 10, step: 0.1, get: () => Math.round(detuneOf(inp.col) * 10000) / 10, set: d => setDetune(inp, d / 1000), disabled: !MOD.dialAvailable(S, inp.col) }));
          }
        }
      }
      a.append(el('p', { class: 'muted', text: 'Dial values are stored as constants on the Direct rows into each input, so they add to any cables you connect there.' }));
    }
    if (bankProps) bankProps();
    const cols = new Set(n.inputs.map(p => p.col)), rows = new Set(n.outputs.map(p => p.row));
    if (n.inputs.length) { a.append(el('h3', { text: 'Cables in' })); a.append(connList((r, c) => cols.has(c) && !isHiddenCell(r, c, S.cells.get(EM.key(r, c))))); }
    if (n.outputs.length) { a.append(el('h3', { text: 'Cables out' })); a.append(connList(r => rows.has(r))); }
    if (!def.fixed) a.append(el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { class: 'danger', onclick: () => removeModule(n.id), text: 'Remove from patch' })));
  }
  /** A newly chosen BiqBank / SineBank / Kinetic gets the firmware's default properties
   *  (BiqBank and SineBank columns 3..7 = sF, B, sB, C, sA), as the Haken Editor does. */
  function applyBankDefaults(def, b) {
    const sel = b && b.selectors; if (!sel || !sel.defaults || def.slot === 'C') return;
    const which = sel.stream, off = def.slot === 'A' ? 0 : 24;
    const arr = S[which] || (S[which] = []);
    const pairs = sel.defaults.map((v, i) => [off + i, v]).filter(([id]) => id !== off);
    try { midiSend(EM.Encoder.setBankProps(dialect(), which, pairs, arr)); } catch (err) { logInfo('Not sent: ' + err.message); }
    pairs.forEach(([id, v]) => arr[id] = v);
  }
  function setBankProp(which, id, v) {
    const arr = S[which] || (S[which] = []);
    try { midiSend(EM.Encoder.setBankProp(dialect(), which, id, v, arr)); } catch (err) { logInfo('Not sent: ' + err.message); }
    arr[id] = v;
    scheduleRender();
  }

  function valueGrid(cell, onPick) {
    const cur = cell ? (cell.code & 63) : 0;
    const used = usedFormulaNumbers();
    const g = el('div', { class: 'vgrid' });
    const btn = (code, label, title) => g.append(el('button', { class: (code === cur ? 'sel ' : '') + (used.has(code) && code !== cur ? 'used' : ''), title, text: label, onclick: () => onPick({ code, dec: 0 }) }));
    for (let n = 1; n <= 22; n++) btn(n, EM.VALUE_LABELS[n], 'Formula ' + EM.VALUE_LABELS[n]);
    if (dialect() === 'modern') for (let n = 23; n <= 44; n++) btn(n, EM.VALUE_LABELS[n], 'Formula ' + EM.VALUE_LABELS[n]);
    [45, 46, 47, 48].forEach(c => btn(c, EM.VALUE_LABELS[c], EM.VALUE_HELP[EM.VALUE_LABELS[c]]));
    for (let c = 50; c <= 58; c++) btn(c, EM.VALUE_LABELS[c], 'Constant ' + EM.VALUE_LABELS[c]);
    [59, 60].forEach(c => btn(c, EM.VALUE_LABELS[c], EM.VALUE_HELP[EM.VALUE_LABELS[c]]));
    return g;
  }

  function renderCable(a, row, col) {
    const cell = S.cells.get(EM.key(row, col));
    if (!cell) { selected = null; return renderHome(a); }
    const src = cableSource(row, cell), to = portIn.get(col);
    const toName = to ? `${to.n.title}: ${to.inp.label}` : EM.COL_NAMES[col];
    if (typeof src === 'string') {
      const m = mods.get(src.slice(2)), n = describeMod(m), letter = cell.code & 63;
      a.append(el('h2', { text: `${n.title} → ${toName}` }));
      if (m.kind === 'macro') {
        const p = S.formulas[letter].pairs;
        a.append(el('p', { text: `Adds the macro times an amount to this input (formula ${EM.formulaLetter(letter)}).` }));
        a.append(sliderRow({ key: 'amt', label: 'Amount', desc: 'Macro at full adds this much (times the range)', min: -1, max: 1, step: 0.01,
          get: () => EM.heightGet(S.formulas[letter].pairs, EM.F.HeightW), set: v => editFormula(letter, q => EM.heightSet(q, EM.F.HeightW, v)) }));
        a.append(selectRow('Range', idx(EM.OPTIONS.mult.slice(0, 6)), EM.fget(p, EM.F.MultW) & 7, v => { editFormula(letter, q => q[EM.F.MultW] = v); scheduleRender(); }, { title: 'Multiplies the amount' }));
      } else a.append(el('p', { text: row === 16
        ? `${n.title} scales what comes into its In (${(m.ins || []).map(r => EM.ROW_NAMES[r]).join(', ')}) on the way to this input: formula ${EM.formulaLetter(letter)} on the × row. Change its settings on the module.`
        : `Carries ${n.title} (formula ${EM.formulaLetter(letter)}). Change its settings on the module.` }));
      a.append(el('div', { class: 'row' }, el('button', { onclick: () => select({ kind: 'node', id: m.id }), text: 'Open the module' }),
        el('button', { onclick: () => select({ kind: 'formula', num: letter }), text: 'Show the formula' }),
        el('button', { class: 'danger', onclick: () => deleteCable(row, col), text: 'Delete' })));
      return;
    }
    a.append(el('h2', { text: `${EM.ROW_NAMES[row]} → ${toName}` }));
    a.append(el('h3', { text: 'Value' }));
    a.append(valueGrid(cell, v => setCell(row, col, { ...v, code: v.code | (cell.code & 64) })));
    const decIn = el('input', { type: 'text', placeholder: '.25', size: 6, value: (cell.code & 63) === 49 ? EM.cellLabel(cell) : '' });
    const applyDec = () => { try { const v = EM.parseCellValue(decIn.value); setCell(row, col, v.code ? { ...v, code: v.code | (cell.code & 64) } : null); } catch (e) { alert(e.message); } };
    decIn.addEventListener('keydown', e => { if (e.key === 'Enter') applyDec(); });
    const mute = el('input', { type: 'checkbox', checked: !!(cell.code & 64), onchange: e => setMute(row, col, e.target.checked) });
    a.append(el('div', { class: 'row' }, el('label', { text: 'Decimal' }), decIn, el('button', { onclick: applyDec, text: 'Set' }),
      el('label', { style: 'min-width:0;margin-left:auto' }, mute, ' Mute'),
      el('button', { class: 'danger', onclick: () => deleteCable(row, col), text: 'Delete' })));
    const code = cell.code & 63;
    if (EM.isFormulaCode(code)) {
      a.append(el('h3', { text: `Formula ${EM.formulaLetter(code)}` }));
      renderFormulaEditor(a, code);
    } else if (EM.VALUE_HELP[EM.cellLabel(cell)]) a.append(el('p', { text: EM.VALUE_HELP[EM.cellLabel(cell)] }));
  }

  function renderFormulaPanel(a, num) {
    a.append(el('h2', { text: `Formula ${EM.formulaLetter(num)}` }));
    renderFormulaEditor(a, num);
  }

  function renderFormulaEditor(a, num) {
    const f = S.formulas[num];
    const users = [];
    for (const [k, c] of S.cells) if ((c.code & 63) === num) users.push(EM.unkey(k));
    if (users.length > 1) a.append(el('div', { class: 'note', text: `Shared by ${users.length} connections. Editing it changes all of them.` }));
    if (!f || !Object.keys(f.pairs).length) {
      a.append(el('div', { class: 'note', text: midi.out ? 'Waiting for the Osmose to send this formula. If nothing arrives, edits below still start it from zero.' : 'Not loaded from a device; editing starts it from zero.' }));
    }
    const p = (f && f.pairs) || {};
    a.append(el('div', { class: 'summary', id: 'fsummary', text: EM.formulaSummary(p) }));
    const edit = fn => { editing.until = Date.now() + 600; editFormula(num, fn); };

    const sel = (label, options, value, onchange) => {
      const s = el('select', { onchange: e => onchange(+e.target.value) });
      options.forEach((o, i) => s.append(el('option', { value: i, selected: i === value, text: o })));
      return el('div', { class: 'row' }, el('label', { text: label }), s);
    };
    const slider = (label, min, max, step, value, onchange) => {
      const r = el('input', { type: 'range', min, max, step, value });
      const n = el('input', { type: 'number', min, max, step, value });
      r.addEventListener('input', () => { n.value = r.value; onchange(+r.value); });
      n.addEventListener('change', () => { r.value = n.value; onchange(+n.value); });
      return el('div', { class: 'slider' }, el('label', { text: label }), r, n);
    };

    a.append(sel('Operator', EM.OPTIONS.op, EM.fget(p, EM.F.FormOp), v => edit(q => q[EM.F.FormOp] = v)));

    // W
    const w = el('div', { class: 'comp' }, el('div', { class: 'title' }, 'W', el('small', { text: 'constant, gate or shape generator' })));
    const wMode = EM.fget(p, EM.F.SgW);
    w.append(sel('Source', EM.OPTIONS.wMode, wMode, v => { edit(q => q[EM.F.SgW] = v); editing.until = 0; scheduleRender(); }));
    w.append(slider('Height', -1, 1.27, 0.01, EM.heightGet(p, EM.F.HeightW), v => edit(q => EM.heightSet(q, EM.F.HeightW, v))));
    w.append(sel('Multiplier', EM.OPTIONS.mult, EM.fget(p, EM.F.MultW) & 7, v => edit(q => q[EM.F.MultW] = v)));
    if (wMode >= 2 && wMode <= 11) w.append(sel('SG shape', EM.OPTIONS.sgShape, Math.min(12, EM.fget(p, EM.F.ShapeW)), v => edit(q => q[EM.F.ShapeW] = v)));
    const scaleOpts = dialect() === 'legacy' ? EM.OPTIONS.wScale.slice(0, 2) : EM.OPTIONS.wScale;
    const sc = EM.fget(p, EM.F.ScaleW);
    w.append(sel('Scale by', scaleOpts, Math.min(sc, scaleOpts.length - 1), v => { edit(q => q[EM.F.ScaleW] = v); editing.until = 0; scheduleRender(); }));
    if (sc === 1 || sc === 2) w.append(sel('Macro', EM.OPTIONS.macro.slice(0, dialect() === 'legacy' ? 6 : 90), EM.fget(p, EM.F.SWMacr), v => edit(q => q[EM.F.SWMacr] = v)));
    a.append(w);

    // X Y Z
    const help = { X: 'pitch / key position', Y: 'Osmose: depth into the aftertouch zone', Z: 'pressure' };
    for (const k of ['X', 'Y', 'Z']) {
      const c = EM.COMPONENTS[k];
      const box = el('div', { class: 'comp' }, el('div', { class: 'title' }, k, el('small', { text: help[k] })));
      box.append(slider('Begin', -1, 1, 0.01, EM.heightGet(p, c.vBeg), v => edit(q => EM.heightSet(q, c.vBeg, v))));
      box.append(slider('End', -1, 1, 0.01, EM.heightGet(p, c.vEnd), v => edit(q => EM.heightSet(q, c.vEnd, v))));
      box.append(sel('Multiplier', EM.OPTIONS.mult, EM.fget(p, c.mult) & 7, v => edit(q => q[c.mult] = v)));
      box.append(sel('Mode', k === 'Z' ? EM.OPTIONS.zMode : EM.OPTIONS.xyMode, EM.fget(p, c.mode), v => edit(q => q[c.mode] = v)));
      box.append(sel('Curve', k === 'X' ? EM.OPTIONS.xTrans : EM.OPTIONS.yzTrans, EM.fget(p, c.trans), v => edit(q => q[c.trans] = v)));
      box.append(sel('Macro', ['none'].concat(EM.OPTIONS.macro.slice(0, dialect() === 'legacy' ? 6 : 90)), EM.fget(p, c.macro), v => edit(q => q[c.macro] = v)));
      box.append(slider('Shelf start', 0, 12, 1, EM.fget(p, c.hBeg), v => edit(q => q[c.hBeg] = v)));
      box.append(slider('Shelf end', 0, 12, 1, EM.fget(p, c.hEnd), v => edit(q => q[c.hEnd] = v)));
      a.append(box);
    }
    if (users.length) {
      a.append(el('h3', { text: 'Used by' }));
      const l = el('div', { class: 'list' });
      users.forEach(([r, c]) => l.append(el('a', { onclick: () => select({ kind: 'cable', row: r, col: c }), text: `${EM.ROW_NAMES[r]} → ${EM.COL_NAMES[c]}` })));
      a.append(l);
    }
  }

  // ======================================================================= device events
  let lastNameTime = 0;
  function onDeviceEvent(e) {
    switch (e.type) {
      case 'dialect': logInfo(`Protocol detected: ${dialectLabel(e.dialect)} (${e.why})`); $('#dialectSel').value === 'auto' && renderHeader(); break;
      case 'name': logInfo(`Preset: ${e.name}`); lastNameTime = Date.now(); scheduleRender(); break;
      case 'hardware': case 'firmware': renderHeader(); break;
      case 'clear': placed = new Set(START); mods = new Map(); dismissedMacros.clear(); pendingLetters.clear(); unsentSetup.clear(); scheduleRender(); fitSoon(true); break;   // a new preset is arriving
      case 'setup': unsentSetup.delete(e.id); scheduleRender(); break;
      case 'cell': case 'props': scheduleRender(); fitSoon(false); break;
      case 'macro': case 'global': case 'graph': case 'conv': case 'text': if (Date.now() >= editing.until) scheduleRender(); break;
      case 'formula': if (Date.now() >= editing.until) scheduleRender(); break;
      case 'pong': setStatus('Osmose answered', 'on'); break;
    }
  }

  // ======================================================================= MIDI
  const midi = { access: null, in: null, out: null, tick: false, timer: null, capture: [], paused: false };
  const logBody = () => $('#logBody');
  function logLine(cls, text) {
    if (midi.paused) return;
    const b = logBody();
    b.append(el('div', { class: cls, text }));
    while (b.childElementCount > 400) b.firstChild.remove();
    b.scrollTop = b.scrollHeight;
  }
  function logInfo(t) { logLine('info', '• ' + t); midi.capture.push({ t: Date.now(), info: t }); }
  function logMsg(dir, bytes) {
    midi.capture.push({ t: Date.now(), dir, b: Array.from(bytes) });
    if (midi.capture.length > 200000) midi.capture.splice(0, 50000);
    if ($('#logFilter').checked && dir === 'in' && (bytes[0] & 0xF0) !== 0xB0 && (bytes[0] & 0x0F) < 14) return; // hide note traffic
    const d = EM.describe(Array.from(bytes));
    logLine(dir, `${dir === 'in' ? '←' : '→'} ${d.hex.padEnd(9)}  ${d.text}`);
  }
  function midiSend(msgs) {
    if (!msgs || !msgs.length) return;
    for (const m of msgs) {
      logMsg('out', m);
      if (midi.out) { try { midi.out.send(m); } catch (err) { logInfo('Send failed: ' + err.message); } }
    }
  }
  /** The app follows what the Osmose sends only while it is reading a preset (Connect, Read patch),
   *  never while you edit: the device echoes edits back, and those echoes fought with local changes.
   *  listen(ms) opens a window that stays open while data keeps arriving. */
  const listening = { until: 0, idle: 0, announce: false, timer: null };
  function listen(ms, announce = true) {
    listening.until = Date.now() + ms; listening.idle = Math.min(ms, 1500); listening.announce = announce;
    clearTimeout(listening.timer); listening.timer = setTimeout(endListen, ms + 50);
  }
  function endListen() {
    if (Date.now() < listening.until) { listening.timer = setTimeout(endListen, listening.until - Date.now() + 50); return; }
    if (listening.announce) { logInfo('Finished reading. Changes made on the Osmose itself are not followed until you press Read patch.'); setStatus('Patch read. Edits now go one way, to the Osmose.', 'on'); }
    listening.announce = false; scheduleRender();
  }
  const isListening = () => Date.now() < listening.until;
  // Outside a read, only the heartbeat answer and firmware/hardware ids are taken in (ch16 cc102–104, 118).
  const isInfoMsg = b => b[0] === 0xBF && [102, 103, 104, 118].includes(b[1]);
  function onMidi(ev) {
    const b = ev.data;
    if (!b || b.length === 0 || b[0] >= 0xF8) return; // real-time
    logMsg('in', b);
    if (b[0] >= 0xF0) return;
    if (isListening()) { const t = Date.now() + listening.idle; if (t > listening.until) listening.until = t; dec.feed(Array.from(b)); }
    else if (isInfoMsg(b)) dec.feed(Array.from(b));
  }

  async function initMidi() {
    if (!navigator.requestMIDIAccess) {
      setStatus('This browser has no Web MIDI. Use Chrome or Edge.', 'warn'); return;
    }
    try {
      midi.access = await navigator.requestMIDIAccess({ sysex: false });
      midi.access.onstatechange = () => fillPorts();
      fillPorts();
      setStatus('MIDI ready. Pick the Osmose port and press Connect.', '');
    } catch (err) {
      setStatus('MIDI access was refused: ' + err.message, 'warn');
    }
  }
  function rankPort(name) {
    const n = name.toLowerCase();
    if (n.includes('haken')) return 4;                              // "Osmose 61 haken": the EaganMatrix port
    if (/osmose play|play/.test(n) && n.includes('osmose')) return 1; // "Osmose 61 osmose play" does not carry EaganMatrix edits
    if (n.includes('osmose') && /port 2|\b2\b/.test(n)) return 3;  // Windows names the Haken port "Osmose Port 2" 
    if (/eaganmatrix|continuu/.test(n)) return 2;
    if (n.includes('osmose')) return 1;
    return 0;
  }
  function fillPorts() {
    const fill = (sel, ports) => {
      const prev = sel.value; sel.textContent = '';
      sel.append(el('option', { value: '', text: '— none —' }));
      const list = [...ports.values()].sort((a, b) => rankPort(b.name) - rankPort(a.name));
      list.forEach(p => sel.append(el('option', { value: p.id, text: p.name })));
      sel.value = [...sel.options].some(o => o.value === prev) && prev ? prev : (list[0] && rankPort(list[0].name) ? list[0].id : '');
    };
    fill($('#inSel'), midi.access.inputs); fill($('#outSel'), midi.access.outputs);
  }
  function connectPorts() {
    disconnect();
    const i = midi.access?.inputs.get($('#inSel').value), o = midi.access?.outputs.get($('#outSel').value);
    if (!i || !o) { setStatus('Pick both an input and an output port.', 'warn'); return; }
    midi.in = i; midi.out = o; portName = i.name;
    i.onmidimessage = onMidi;
    setStatus(`Connected to ${i.name}`, 'on');
    logInfo(`Connected: in "${i.name}", out "${o.name}"`);
    $('#connectBtn').textContent = 'Disconnect';
    heartbeat(true);
    // The patch on screen is the truth: once the firmware has answered the heartbeat, the Osmose's
    // current sound is replaced by it (nothing is stored). Read patch brings a preset in instead.
    midiSend(EM.Encoder.ping(true));
    setTimeout(() => { if (midi.out === o) pushAll(true); }, 900);
    renderHeader();
  }
  function disconnect() {
    if (midi.in) midi.in.onmidimessage = null;
    if (midi.in || midi.out) logInfo('Disconnected');
    midi.in = midi.out = null;
    clearInterval(midi.timer); midi.timer = null;
    $('#connectBtn').textContent = 'Connect';
  }
  function heartbeat(on) {
    clearInterval(midi.timer); midi.timer = null;
    if (on && $('#hbChk').checked) {
      midi.timer = setInterval(() => { if (midi.out) { midi.tick = !midi.tick; const m = EM.Encoder.ping(midi.tick)[0]; try { midi.out.send(m); } catch { } } }, 1000);
    }
  }
  function readFromDevice() {
    if (!midi.out) { setStatus('Not connected.', 'warn'); return; }
    logInfo('Asking the device for its current preset…');
    listen(4000);
    midiSend([...EM.Encoder.ping(true), ...EM.Encoder.requestConfig(), ...EM.Encoder.matRefresh()]);
  }
  /** Modern firmware sends a formula only when a cell holding it is selected, so walk them one by one. */
  function fetchAllFormulas() {
    const cells = new Map();
    for (const [k, c] of S.cells) { const n = c.code & 63; if (EM.isFormulaCode(n) && !cells.has(n)) cells.set(n, EM.unkey(k)); }
    let i = 0; const list = [...cells.values()];
    logInfo(`Fetching ${list.length} formulas…`);
    const step = () => { if (i >= list.length || !midi.out) return; const [r, c] = list[i++]; midiSend(EM.Encoder.selectCell('modern', r, c)); setTimeout(step, 120); };
    step();
  }
  function setStatus(t, cls) { $('#status').textContent = t; $('#dot').className = 'dot ' + (cls || ''); }

  // ======================================================================= files
  function download(name, text, type = 'application/json') {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  /** Save with the system dialog (name and folder) where the browser has one (Chrome, Edge);
   *  otherwise a plain download. Returns the chosen file name, or null if cancelled. */
  async function saveAs(name, text, desc = 'Osmose patch') {
    if (window.showSaveFilePicker) {
      let h;
      try { h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: { 'application/json': ['.json'] } }] }); }
      catch (err) { if (err.name === 'AbortError') return null; download(name, text); return name; }
      const w = await h.createWritable(); await w.write(text); await w.close();
      return h.name;
    }
    download(name, text); return name;
  }
  function stateToJson() {
    return JSON.stringify({
      format: 'osmose-patcher/1', name: S.name, firmware: S.firmware, dialect: dialect(),
      cells: [...S.cells].map(([k, c]) => { const [r, col] = EM.unkey(k); return { row: r, col, value: EM.cellLabel(c), code: c.code, dec: c.dec }; }),
      formulas: Object.fromEntries(Object.entries(S.formulas).map(([n, f]) => [EM.formulaLetter(+n), { num: +n, pairs: f.pairs, summary: EM.formulaSummary(f.pairs) }])),
      setup: S.setup, legacyRaw: S.legacyRaw, kinet: S.kinet, biqsin: S.biqsin, modules: [...placed],
      mods: [...mods.values()], globals: S.globals, macros: S.macros, graphs: S.graphs, conv: S.conv, text: S.text, detune: S.detune,
    }, null, 1);
  }
  function loadJson(obj) {
    if (obj.format !== 'osmose-patcher/1') throw new Error('Not an Osmose Patcher file');
    S = EM.newState(); makeDecoder();
    S.name = obj.name || ''; S.firmware = obj.firmware ?? null; S.setup = obj.setup || {};
    obj.cells.forEach(c => S.cells.set(EM.key(c.row, c.col), { code: c.code, dec: c.dec || 0 }));
    Object.values(obj.formulas || {}).forEach(f => S.formulas[f.num] = { pairs: f.pairs });
    S.kinet = obj.kinet || []; S.biqsin = obj.biqsin || []; if (obj.legacyRaw) S.legacyRaw = obj.legacyRaw;
    placed = new Set([...START, ...(obj.modules || []).filter(id => DEFS[id] && id !== 'controls')]);
    mods = new Map((obj.mods || []).filter(m => m.kind === 'macro' || MODS.GESTURES[m.g]).map(m => [m.id, m]));
    for (const k of ['globals', 'macros', 'graphs', 'conv', 'detune']) if (obj[k]) S[k] = obj[k];
    if (obj.text) S.text = obj.text;
  }
  function importMid(buf, name) {
    const msgs = EM.parseSmf(buf);
    S = EM.newState(); makeDecoder();
    const d = new EM.Decoder(S, () => {}); // auto-detect per file, independent of the live dialect
    msgs.forEach(m => d.feed(m));
    if (d.dialect === 'auto') d.setDialect('modern');
    if (!S.name) S.name = name.replace(/\.mid$/i, '');
    placed = new Set(START); mods = new Map(); pendingLetters.clear();
    logInfo(`Imported ${name}: ${msgs.length} messages, ${S.cells.size} connections, ${Object.keys(S.formulas).length} formulas (${d.dialect} format)`);
    if (!Object.keys(S.formulas).length && S.cells.size) logInfo('This file has no formula data (live captures only include formulas for the selected cell).');
  }
  function pushAll(silent) {
    if (!midi.out) { alert('Connect to the Osmose first.'); return; }
    if (silent !== true && !confirm('Replace the Osmose\'s current (unsaved) patch with what is shown here? Nothing is stored to a preset slot; use Save on the Osmose to keep it.')) return;
    const dlt = dialect();
    const out = [...EM.Encoder.clearMatrix(dlt)];
    // Settings the app shows with a default when the device hasn't said (Global FX on, its type, compressor)
    // go out too, so the Osmose doesn't keep its previous preset's values behind the screen's back.
    const setup = { 15: 0, 16: 0, 62: 0, ...S.setup };
    for (const [id, v] of Object.entries(setup)) { try { out.push(...EM.Encoder.setSetup(dlt, +id, v)); } catch { /* unknown in this dialect */ } }
    for (const [cc, v] of Object.entries(S.globals || {})) out.push(...EM.Encoder.setGlobal(+cc, v));
    for (const [i, raw] of Object.entries(S.macros || {})) { try { out.push(...EM.Encoder.setMacro(+i, EM.macroToValue(+i, raw))); } catch { /* */ } }
    if (dlt === 'legacy' && S.legacyRaw) for (const ch of [15, 16]) for (const [cc, v] of Object.entries(S.legacyRaw[ch] || {})) out.push([0xB0 | (ch - 1), +cc, v]);
    for (const [n, f] of Object.entries(S.formulas)) {
      out.push(...EM.Encoder.formulaChanges(dlt, +n, f.pairs, f.pairs, null, null));
    }
    for (const [k, c] of S.cells) { const [r, col] = EM.unkey(k); try { out.push(...EM.Encoder.setCell(dlt, r, col, c)); } catch (e) { logInfo(e.message); } }
    logInfo(`Sending ${out.length} messages…`);
    // pace the burst a little so the device's receive queue keeps up
    let i = 0; const step = () => { midiSend(out.slice(i, i + 40)); i += 40; if (i < out.length) setTimeout(step, 15); else { logInfo('Patch sent.'); if (silent === true) setStatus('The Osmose now plays the patch shown here (its preset is untouched: pick it again on the Osmose to get it back). Read patch brings a preset in.', 'on'); } };
    step();
  }
  function demoPatch() {
    S = EM.newState(); makeDecoder();
    S.name = 'Demo: simple pressure synth';
    const put = (r, c, label) => S.cells.set(EM.key(r, c), EM.parseCellValue(label));
    S.setup[EM.SETUP.OscType1] = 0;     // Osc 1: DSF oscillator
    S.setup[EM.SETUP.BankA] = 0;        // Bank A: BiqBank
    S.setup[EM.SETUP.SgType1] = 0;
    put(13, 13, 'X');                   // Osc 1 Freq follows pitch
    put(14, 14, '.5');                  // Osc 1 Brightness dial = 0.5
    put(1, 0, 'A'); put(1, 1, 'A');     // Osc 1 → Master L/R through formula A (gate × pressure)
    put(14, 51, '5');                   // SG 1 rate dial = 5 Hz
    put(13, 52, 'W');                   // SG 1 trigger follows the gate
    put(1, 27, '.3');                   // Osc 1 → Bank A In
    put(13, 28, 'X');                   // Bank A Freq follows pitch
    put(6, 0, '.5'); put(6, 1, '.5');
    const A = {}; A[EM.F.SgW] = 1; EM.heightSet(A, EM.F.HeightW, 1); EM.heightSet(A, EM.F.VEndZ, 1); A[EM.F.FormOp] = 2;
    S.formulas[1] = { pairs: A };
    placed = new Set(START); mods = new Map(); pendingLetters.clear();
    selected = null;
  }

  // ======================================================================= toolbar wiring
  $('#connectBtn').addEventListener('click', () => midi.out ? disconnect() : connectPorts());
  $('#readBtn').addEventListener('click', readFromDevice);
  $('#hbChk').addEventListener('change', () => heartbeat(!!midi.out));
  $('#dialectSel').value = userDialect;
  $('#dialectSel').addEventListener('change', e => { userDialect = e.target.value; store.set('dialect', userDialect); dec.setDialect(userDialect === 'auto' ? 'auto' : userDialect); renderHeader(); scheduleRender(); });
  $('#demoBtn').addEventListener('click', () => { demoPatch(); renderAll(); fitView(); renderInspector(); });
  $('#newBtn').addEventListener('click', () => { if (confirm('Clear the patch shown here? (Sends a matrix clear to the device if connected.)')) { S.cells.clear(); S.formulas = {}; mods = new Map(); pendingLetters.clear(); dismissedMacros.clear(); midiSend(EM.Encoder.clearMatrix(dialect())); selected = null; placed = new Set(START); scheduleRender(); } });
  $('#saveBtn').addEventListener('click', async () => {
    try {
      const saved = await saveAs((S.name || 'patch').replace(/[^\w\- ]+/g, '') + '.osmpatch.json', stateToJson());
      if (!saved) return;
      // The file name becomes the patch's name.
      const nm = saved.replace(/(\.osmpatch)?\.json$/i, '');
      if (nm && nm !== S.name) { S.name = nm; renderHeader(); }
      logInfo('Saved ' + saved); setStatus('Saved ' + saved, 'ok');
    } catch (err) { setStatus('Not saved: ' + err.message, 'warn'); }
  });
  $('#pushBtn').addEventListener('click', pushAll);
  $('#layoutBtn').addEventListener('click', () => { for (const k in positions) delete positions[k]; store.set('positions3', positions); store.set('view', { x: 0, y: 0, k: 1 }); Object.assign(view, { x: 0, y: 0, k: 1 }); NODES = []; renderAll(); fitView(); renderInspector(); });
  $('#openBtn').addEventListener('click', () => $('#fileIn').click());
  $('#fileIn').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try {
      if (/\.mid$/i.test(f.name)) importMid(await f.arrayBuffer(), f.name);
      else loadJson(JSON.parse(await f.text()));
      selected = null; renderAll(); fitView(); renderInspector();
    } catch (err) { alert('Could not open that file: ' + err.message); }
  });
  // The left strip can be hidden: the right-click menu on the canvas adds modules too.
  const setPalette = open => { document.querySelector('main').classList.toggle('nopal', !open); $('#paletteBtn').classList.toggle('on', open); store.set('paletteShown', open); };
  $('#paletteBtn').addEventListener('click', () => setPalette(document.querySelector('main').classList.contains('nopal')));
  setPalette(store.get('paletteShown', true));
  $('#logToggle').addEventListener('click', () => { $('#log').classList.toggle('collapsed'); store.set('logOpen', !$('#log').classList.contains('collapsed')); });
  if (!store.get('logOpen', true)) $('#log').classList.add('collapsed');
  $('#logPause').addEventListener('click', e => { midi.paused = !midi.paused; e.target.textContent = midi.paused ? 'Resume' : 'Pause'; });
  $('#logClear').addEventListener('click', () => { logBody().textContent = ''; midi.capture = []; });
  $('#logSave').addEventListener('click', () => saveAs('osmose-capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
    JSON.stringify({ format: 'osmose-capture/1', port: portName, dialect: dialect(), firmware: S.firmware, hardware: S.hardware, messages: midi.capture }), 'MIDI capture').catch(err => setStatus('Not saved: ' + err.message, 'warn')));
  $('#themeBtn').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = t; store.set('theme', t); });
  document.documentElement.dataset.theme = store.get('theme', 'dark');

  // ---- hover help: any element with data-tip shows a box after a short delay
  const tipBox = el('div', { id: 'tip', role: 'tooltip' }); document.body.append(tipBox);
  let tipTimer = null, tipFor = null;
  function hideTip() { clearTimeout(tipTimer); tipTimer = null; tipFor = null; tipBox.classList.remove('on'); }
  document.addEventListener('pointerover', e => {
    const t = e.target.closest?.('[data-tip]');
    if (t === tipFor) return;
    hideTip();
    if (!t || drag || e.buttons) return;
    tipFor = t;
    const x = e.clientX, y = e.clientY;
    tipTimer = setTimeout(() => {
      const [head, ...rest] = t.getAttribute('data-tip').split('\n');
      tipBox.textContent = '';
      tipBox.append(el('b', { text: head }), ...rest.filter(Boolean).map(line => el('div', { text: line })));
      tipBox.classList.add('on');
      const r = tipBox.getBoundingClientRect();
      tipBox.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
      tipBox.style.top = (y + 18 + r.height > window.innerHeight ? y - r.height - 10 : y + 18) + 'px';
    }, 550);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('wheel', hideTip, { passive: true, capture: true });

  renderAll(); renderInspector(); initMidi();
  window.osmosePatcher = { get state() { return S; }, get placed() { return placed; }, get mods() { return mods; }, get selected() { return selected; }, get capture() { return midi.capture; }, midiSend, connect, disconnectModIn: (id, r) => disconnectModIn(mods.get(id), r), dec: () => dec, dialect }; // for debugging from the console
})();
