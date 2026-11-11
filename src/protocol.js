/* EaganMatrix live-editing protocol: tables, decoder, encoder. No I/O.
 *
 * Sources (see docs/PROTOCOL.md for detail):
 *  - Haken Audio's HakenMidi.h (the protocol header the Haken Editor and third-party
 *    front ends use), as published in pachde-CHEM src/em/HakenMidi.h.
 *  - Device-verified notes on fw 10.81 from the eagan_mcp project (EaganMatrix Module).
 *  - The "legacy" (pre-10.3x) layout, inferred from older preset archives by eagan_mcp's
 *    preset_file.py. The Osmose runs DSP firmware 10.09, so this is the layout it most
 *    likely speaks. It is NOT yet verified on an Osmose.
 *
 * Two dialects:
 *   modern : ch16 cc40 row / cc41 col / cc43,cc42 decimals / cc44 value / cc45 matOp,
 *            formulas via ch16 cc56=19 + poly-pressure (id,value) pokes, setup via cc56=20.
 *   legacy : ch15 cc102 row / cc103 col / cc116,cc115 decimals / cc104 value / cc110 matOp,
 *            formulas = ch15 cc34 formula#, then bare ch15 cc (some fields packed),
 *            setup ids 64..99 = ch15 cc, ids 35..63 = ch16 cc.
 */
(function (root) {
  'use strict';

  const CH1 = 0, CH15 = 14, CH16 = 15;
  const CC = 0xB0, POLY = 0xA0, CHPRESS = 0xD0, PROG = 0xC0;

  // ---------------------------------------------------------------- matrix layout
  const ROW_NAMES = ['Noise', 'Osc/Filter 1', 'Osc/Filter 2', 'Osc/Filter 3', 'Osc/Filter 4',
    'Osc/Filter 5', 'Bank A', 'Bank B', 'Bank C', 'Audio In L', 'Audio In R', 'Submix L',
    'Submix R', 'Direct +', 'Direct + (2)', 'Direct −', 'Multiply ×'];
  const N_ROWS = 17, N_COLS = 61;

  const COL_NAMES = [];
  ['Master L in', 'Master R in', 'Master col 1', 'Master col 2', 'Master col 3', 'Master col 4',
    'Master col 5', 'Master col 6', 'Master/Dry mix', 'Dry L', 'Dry R', '(separator)']
    .forEach((n, i) => { COL_NAMES[i] = n; });
  for (let k = 0; k < 5; k++) {
    COL_NAMES[12 + 3 * k] = `Osc/Filter ${k + 1} In`;
    COL_NAMES[13 + 3 * k] = `Osc/Filter ${k + 1} F`;
    COL_NAMES[14 + 3 * k] = `Osc/Filter ${k + 1} B`;
  }
  ['A', 'B', 'C'].forEach((b, bi) => {
    for (let i = 0; i < 8; i++) COL_NAMES[27 + 8 * bi + i] = `Bank ${b} col ${i + 1}`;
  });
  for (let k = 0; k < 5; k++) {
    COL_NAMES[51 + 2 * k] = `SG ${k + 1} F`;
    COL_NAMES[52 + 2 * k] = `SG ${k + 1} T`;
  }

  // ---------------------------------------------------------------- cell values
  // Modern ccMatVal codes (HakenMidi.h SSL_ccMatVal). Bit 6 (64) = muted.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUV'.split('');
  const VALUE_LABELS = [''];
  LETTERS.forEach(l => VALUE_LABELS.push(l));          // 1..22
  LETTERS.forEach(l => VALUE_LABELS.push(l + "'"));    // 23..44 (fw 10.30+)
  VALUE_LABELS.push('W', 'X', 'Y', 'z²', '.');          // 45..49 (49 = decimal)
  for (let n = 1; n <= 9; n++) VALUE_LABELS.push(String(n)); // 50..58
  VALUE_LABELS.push('row²', 'row³');                    // 59, 60
  const CODE = { NC: 0, A: 1, V: 22, A_: 23, W: 45, X: 46, Y: 47, ZZ: 48, DEC: 49, ONE: 50, SQ: 59, CU: 60, MUTE: 64 };
  const VALUE_HELP = {
    W: 'Gate: 1 while a key is down', X: 'Pitch (kHz of the played note)', Y: 'Y (Osmose: aftertouch zone)',
    'z²': 'Pressure squared', 'row²': 'Square of the row signal', 'row³': 'Cube of the row signal',
  };
  const isFormulaCode = c => c >= 1 && c <= 44;
  const formulaLetter = n => (n >= 1 && n <= 44) ? VALUE_LABELS[n] : `#${n}`;

  // Legacy firmware has no A'..V', so every code from 23 up sits 22 lower.
  const LEGACY_SHIFT_FROM = 23, LEGACY_SHIFT = 22;
  function legacyToModernCode(v) {
    const mute = v & 64; let c = v & 63;
    if (c >= LEGACY_SHIFT_FROM) c += LEGACY_SHIFT;
    return c | mute;
  }
  function modernToLegacyCode(v) {
    const mute = v & 64; let c = v & 63;
    if (c >= 23 && c <= 44) throw new Error("A'..V' formulas need firmware 10.30 or later");
    if (c >= 45) c -= LEGACY_SHIFT;
    return c | mute;
  }

  /** A cell value: {code, dec} where dec is 1..9999 (only for code 49). */
  function cellLabel(cell) {
    if (!cell) return '';
    const c = cell.code & 63;
    if (c === CODE.DEC) return ('.' + String(cell.dec || 0).padStart(4, '0')).replace(/0+$/, '') || '.0';
    return VALUE_LABELS[c] ?? `?${c}`;
  }
  /** Parse user text -> {code, dec}. Throws on bad input. */
  function parseCellValue(text) {
    let t = String(text).trim();
    if (!t) return { code: 0, dec: 0 };
    const u = t.toUpperCase();
    let i = VALUE_LABELS.findIndex((l, k) => k > 0 && k !== 49 && l.toUpperCase() === u);
    if (i > 0) return { code: i, dec: 0 };
    if (u === 'Z2' || u === 'ZZ' || u === 'Z^2') return { code: CODE.ZZ, dec: 0 };
    if (u === 'ROW2' || u === 'ROW^2') return { code: CODE.SQ, dec: 0 };
    if (u === 'ROW3' || u === 'ROW^3') return { code: CODE.CU, dec: 0 };
    if (/^0?\.\d{1,4}$/.test(t)) {
      const d = parseInt(t.split('.')[1].padEnd(4, '0'), 10);
      if (d === 0) return { code: 0, dec: 0 };
      return { code: CODE.DEC, dec: d };
    }
    throw new Error(`"${text}" is not a matrix value. Use A–V, W, X, Y, z², 1–9, a decimal like .25, row², row³.`);
  }

  // ---------------------------------------------------------------- formulas (s_Form_Poke ids)
  const F = {
    MultX: 1, MultY: 2, MultZ: 3, InitX: 4, InitY: 5, InitZ: 6, AncDom: 7, AncNN: 10,
    NegW: 13, NegBegX: 15, NegEndX: 17, NegBegY: 19, NegEndY: 21, NegBegZ: 23, NegEndZ: 25,
    XMacr: 27, YMacr: 28, ZMacr: 29, FormOp: 38, Blend: 39, SgW: 40, MultW: 41, HeightW: 42,
    HBegX: 43, ZeroX: 44, VBegX: 45, VEndX: 46, Interp: 48, HEndX: 49, ShapeW: 50, VBegY: 51,
    VEndY: 52, HBegY: 53, HEndY: 54, TransY: 55, AncOp: 56, AncVal: 57, VBegZ: 58, VEndZ: 59,
    HBegZ: 60, HEndZ: 61, TransZ: 62, Persist: 63, ScaleW: 66, SWMacr: 67, BlMacForm: 68,
    TransX: 85, SgM: 117, AllW: 124, InitW: 125,
  };
  const SIGN_OF = { 42: 13, 73: 14, 45: 15, 75: 16, 46: 17, 76: 18, 51: 19, 77: 20, 52: 21, 78: 22, 58: 23, 79: 24, 59: 25, 80: 26 };
  const FORMULA_DEFAULTS = { [F.MultW]: 3, [F.MultX]: 3, [F.MultY]: 3, [F.MultZ]: 3, [F.HEndX]: 12, [F.HEndY]: 12, [F.HEndZ]: 12, [F.TransX]: 1, [F.ZeroX]: 60, [F.Interp]: 40 };

  const OPTIONS = {
    op: ['W + X + Y + Z', 'W × (X + Y + Z)', '(W + X + Y) × Z', '(W + X) × (Y + Z)', '(W × X) + (Y × Z)'],
    wMode: ['Constant', 'Gated (key down)', 'SG 1', 'SG 2', 'SG 3', 'SG 4', 'SG 5', 'SG 1b', 'SG 2b', 'SG 3b', 'SG 4b', 'SG 5b', 'Formula Delay tap', 'RMS of row'],
    mult: ['× 0.001', '× 0.01', '× 0.1', '× 1', '× 10', '× 100', '× 1000'],
    multVal: [0.001, 0.01, 0.1, 1, 10, 100, 1000],
    wScale: ['× 1', '× Macro', '× 127 × Macro', '÷ fingers', '× voice #', '1 if voice 1', '÷ polyphony'],
    macro: ['i', 'ii', 'iii', 'iv', 'v', 'vi'].concat(Array.from({ length: 84 }, (_, i) => 'm' + (i + 7))),
    sgShape: ['Ramp up', 'Ramp down', 'Pulse', 'Pulse at end', 'Triangle', 'Hann', 'Gentle S up', 'Steep S up', 'Gentle S down', 'Steep S down', 'Square', 'Sine', 'Sample & hold row'],
    xyMode: ['Continuous', 'Initial', 'Derivative', 'Relative', 'Continuous (no trim)', 'Initial (no trim)', 'Derivative (no trim)', 'Relative (no trim)'],
    zMode: ['Continuous', 'Initial', 'Derivative', 'Release (fast)', 'Release (pressure)'],
    xTrans: ['Octaves', 'kHz', 'Linear', 'Gentle S', 'Squared', 'Square root', '2 step', '3 step', 'Graph', 'Offsets 1', 'Offsets 2', 'Steep S'],
    yzTrans: ['Linear', 'Gentle S', 'Squared', 'Square root', '2 step', '3 step', 'Graph', 'Offsets 1', 'Offsets 2', 'Steep S'],
  };
  const COMPONENTS = {
    X: { vBeg: F.VBegX, vEnd: F.VEndX, hBeg: F.HBegX, hEnd: F.HEndX, mult: F.MultX, mode: F.InitX, trans: F.TransX, macro: F.XMacr },
    Y: { vBeg: F.VBegY, vEnd: F.VEndY, hBeg: F.HBegY, hEnd: F.HEndY, mult: F.MultY, mode: F.InitY, trans: F.TransY, macro: F.YMacr },
    Z: { vBeg: F.VBegZ, vEnd: F.VEndZ, hBeg: F.HBegZ, hEnd: F.HEndZ, mult: F.MultZ, mode: F.InitZ, trans: F.TransZ, macro: F.ZMacr },
  };

  const fget = (p, id) => (p[id] !== undefined ? p[id] : (FORMULA_DEFAULTS[id] ?? 0));
  /** Height slider: OFFSET encoding (device-verified on 10.81): neg flag set -> raw/100 - 1. */
  function heightGet(p, id) {
    const neg = fget(p, SIGN_OF[id]);
    const raw = fget(p, id);
    return neg ? Math.round((raw / 100 - 1) * 100) / 100 : raw / 100;
  }
  function heightSet(p, id, v) {
    v = Math.round(v * 100) / 100;
    if (v < 0) { p[SIGN_OF[id]] = 1; p[id] = Math.round((v + 1) * 100); }
    else { p[SIGN_OF[id]] = 0; p[id] = Math.min(127, Math.round(v * 100)); }
  }

  function formulaSummary(p) {
    if (!p) return '(not loaded)';
    const parts = [];
    const wMode = fget(p, F.SgW), wH = heightGet(p, F.HeightW), wM = OPTIONS.multVal[fget(p, F.MultW) & 7];
    if (wH !== 0) {
      let s = `W ${OPTIONS.wMode[wMode] || '?'} ${wH}`;
      if (wM !== 1) s += `×${wM}`;
      if (wMode >= 2 && wMode <= 11) s += ` [${OPTIONS.sgShape[fget(p, F.ShapeW)] || 'S&H'}]`;
      const sc = fget(p, F.ScaleW); if (sc) s += ` ${OPTIONS.wScale[sc]}${sc <= 2 ? ' ' + OPTIONS.macro[fget(p, F.SWMacr)] : ''}`;
      parts.push(s);
    }
    for (const k of ['X', 'Y', 'Z']) {
      const c = COMPONENTS[k];
      const b = heightGet(p, c.vBeg), e = heightGet(p, c.vEnd);
      if (b === 0 && e === 0) continue;
      const m = OPTIONS.multVal[fget(p, c.mult) & 7];
      parts.push(`${k} ${b}→${e}${m !== 1 ? '×' + m : ''}`);
    }
    const op = fget(p, F.FormOp);
    if (op) parts.push(OPTIONS.op[op]);
    return parts.length ? parts.join(' · ') : 'zero (no effect yet)';
  }

  // ---- legacy formula packing (derived from archives; see eagan_mcp preset_file.py)
  const LEGACY_PACK = {
    39: [[F.BlMacForm, 0, 3], [F.Blend, 3, 4]],
    40: [[F.SgW, 0, 4], [F.InitW, 4, 1], [F.AllW, 5, 1]],
    41: [[F.MultW, 0, 3], ['scaler', 3, 4]],
    43: [[F.HBegX, 0, 4], [F.MultX, 4, 3]],
    49: [[F.HEndX, 0, 4], [F.InitX, 4, 3]],
    53: [[F.HBegY, 0, 4], [F.MultY, 4, 3]],
    54: [[F.HEndY, 0, 4], [F.InitY, 4, 3]],
    56: [[F.AncOp, 0, 4], [F.AncDom, 4, 3]],
    60: [[F.HBegZ, 0, 4], [F.MultZ, 4, 3]],
    61: [[F.HEndZ, 0, 4], [F.InitZ, 4, 3]],
  };
  const NEG_PRIMARY = [13, 15, 17, 19, 21, 23, 25];   // cc71, MSB first
  const NEG_SECONDARY = [14, 16, 18, 20, 22, 24, 26]; // cc72
  const LEGACY_CONSUMED = new Set([...NEG_PRIMARY, ...NEG_SECONDARY, F.ScaleW, F.SWMacr, F.AncNN]);
  Object.values(LEGACY_PACK).forEach(fs => fs.forEach(([id]) => { if (typeof id === 'number') LEGACY_CONSUMED.add(id); }));
  const LEGACY_MATRIX_CC = new Set([102, 103, 104, 110, 115, 116]);

  /** Legacy ch15 cc map -> modern pairs. */
  function legacyUnpack(raw) {
    const p = {};
    for (const [ccs, value] of Object.entries(raw)) {
      const cc = +ccs;
      if (LEGACY_PACK[cc]) {
        for (const [id, shift, width] of LEGACY_PACK[cc]) {
          const field = (value >> shift) & ((1 << width) - 1);
          if (id === 'scaler') {
            // 1..6 = "× macro i..vi"; higher values are not understood yet, so leave them alone.
            if (field >= 1 && field <= 6) { p[F.ScaleW] = 1; p[F.SWMacr] = field - 1; } else if (!field) { p[F.ScaleW] = 0; }
          } else p[id] = field;
        }
      } else if (cc === 71 || cc === 72) {
        const ids = cc === 71 ? NEG_PRIMARY : NEG_SECONDARY;
        ids.forEach((id, bit) => { p[id] = (value >> (6 - bit)) & 1; });
      } else if (cc === F.AncVal) {
        p[F.AncNN] = (value & 64) ? 1 : 0; p[F.AncVal] = value & 63;
      } else p[cc] = value;
    }
    return p;
  }
  /** Modern pairs -> legacy ch15 cc map (complete). */
  function legacyPack(p) {
    const out = {};
    for (const [cc, fields] of Object.entries(LEGACY_PACK)) {
      let v = 0;
      for (const [id, shift, width] of fields) {
        let field;
        if (id === 'scaler') field = fget(p, F.ScaleW) === 1 ? Math.min(15, fget(p, F.SWMacr) + 1) : 0;
        else field = fget(p, id);
        v |= (field & ((1 << width) - 1)) << shift;
      }
      out[cc] = v & 127;
    }
    out[71] = NEG_PRIMARY.reduce((a, id, bit) => a | ((fget(p, id) & 1) << (6 - bit)), 0);
    out[72] = NEG_SECONDARY.reduce((a, id, bit) => a | ((fget(p, id) & 1) << (6 - bit)), 0);
    out[F.AncVal] = (fget(p, F.AncVal) & 63) | (fget(p, F.AncNN) ? 64 : 0);
    for (const [ids, v] of Object.entries(p)) {
      const id = +ids;
      if (LEGACY_CONSUMED.has(id) || id === F.AncVal || LEGACY_MATRIX_CC.has(id) || id === 34) continue;
      out[id] = v & 127;
    }
    return out;
  }

  // ---------------------------------------------------------------- setup (s_Mat_Poke ids)
  const SETUP = { Poly: 39, MastCol1: 27, OscType1: 72, OscOpt1: 77, BankA: 91, BankB: 92, BankC: 93, SgType1: 100 };
  const OSC_TYPES = { 0: 'DSF oscillator', 1: 'Integrated DSF osc', 18: 'PWM oscillator', 2: 'Jenny oscillator', 3: 'Phase oscillator', 4: 'Seeded noise', 5: 'Low pass', 6: 'High pass', 7: 'Band pass', 8: 'Band reject', 9: 'All pass', 10: 'Low shelf', 11: 'High shelf', 12: 'Low pass 1-pole', 13: 'High pass 1-pole', 19: 'Ladder low pass', 14: 'Multiplier', 15: 'tanh', 16: 'Bit crush', 17: 'Granulate delay' };
  const BANK_AB_TYPES = { 0: 'BiqBank', 1: 'BiqGraph', 2: 'BiqMouth', 3: 'SineBank', 4: 'SineSpray', 5: 'WaveBank', 6: 'HarMan', 7: 'ModMan', 8: 'CVC', 9: 'Kinetic', 10: 'Additive' };
  const BANK_C_TYPES = { 0: 'Voice Delay', 1: 'Summed Delay', 2: 'Micro Delay', 3: 'Formula Delay', 4: 'SineSpray', 5: 'WaveBank', 6: 'HarMan', 8: 'CVC' };
  const SG_TYPES = { 0: 'Continuous cycle', 1: 'Single cycle', 2: 'Phase from row', 3: 'Dual' };
  // Column labels by bank type (guide sections 6.x; first columns are fixed, the rest assignable).
  const BANK_COL_LABELS = {
    BiqBank: ['In', 'F', '3', '4', '5', '6', '7', '8'], SineBank: ['Amp', 'F', '3', '4', '5', '6', '7', '8'],
    Kinetic: ['In', 'F', '3', '4', '5', '6', '7', '8'],
  };

  // ---------------------------------------------------------------- global cc (sent on ch1; devices report on ch1 or ch16)
  const GLOBAL_CC = { Post: 18, AudIn: 19, Reci1: 20, Reci2: 21, Reci3: 22, Reci4: 23, ReciMix: 24, Pre: 26,
    EqTilt: 83, EqFreq: 84, EqMix: 85, ThrDrv: 90, AtkCut: 91, RatMkp: 92, CoThMix: 93, Reci5: 95, Reci6: 96 };
  const GLOBAL_CC_SET = new Set(Object.values(GLOBAL_CC));
  // Macro i..vi are 0..1 (14-bit, full scale 0x3F80); m7..m90 are -1..1 (14-bit, zero 0x2000).
  const macroName = i => i < 6 ? ['i', 'ii', 'iii', 'iv', 'v', 'vi'][i] : 'm' + (i + 1);
  const macroToValue = (i, raw) => i < 6 ? raw / 0x3F80 : (raw - 0x2000) / 0x2000;
  const macroFromValue = (i, v) => i < 6 ? Math.max(0, Math.min(0x3FFF, Math.round(v * 0x3F80))) : Math.max(0, Math.min(0x3FFF, Math.round(v * 0x2000) + 0x2000));
  /** Macro index -> [frac cc, value cc] on ch1 (see HakenMidi.h ccFracIM48 / ccFracM49M90). */
  function macroCcs(i) {
    if (i < 6) return [86, 12 + i];
    const n = i + 1;                          // m7..m90
    if (n <= 30) return [86, 40 + n - 7];
    if (n <= 48) return [86, 102 + n - 31];
    if (n <= 72) return [97, 40 + n - 49];
    return [97, 102 + n - 73];
  }

  // ---------------------------------------------------------------- state
  function newState() {
    return {
      cells: new Map(),      // key row*64+col -> {code, dec}
      formulas: {},          // num -> {pairs:{id:value}, legacyRaw?:{cc:v}}
      setup: {},             // s_Mat_Poke id -> value
      name: '', text: '', firmware: null, hardware: null, presetId: null,
      kinet: [],             // Kinetic properties (stream 11), 24 bytes per bank: A at 0, B at 24
      biqsin: [],            // BiqBank/SineBank properties (stream 12), same layout
      legacyRaw: { 15: {}, 16: {} }, // older-firmware settings by channel and cc, replayed as-is
      graphs: { 2: [], 3: [], 4: [] },  // BiqGraph graphs: 2 = mode amplitudes, 3 / 4 = offset graphs (48 values 0..96)
      conv: [],              // convolution settings (stream 14)
      detune: {},            // app only: per-column detune (kHz) included in the column's dial constant
      globals: {},           // Master section and other global cc (pre, post, recirculator, EQ, compressor) by cc number
      macros: {},            // macro index 0..89 (i = 0) -> 14-bit raw value
    };
  }
  const key = (r, c) => r * 64 + c;
  const unkey = k => [Math.floor(k / 64), k % 64];

  // ---------------------------------------------------------------- decoder
  /** Feeds raw MIDI bytes; mutates `state`; calls onEvent({type,...}). */
  class Decoder {
    constructor(state, onEvent) {
      this.s = state; this.on = onEvent || (() => {});
      this.dialect = 'auto';   // 'auto' | 'modern' | 'legacy'
      this.pending = [];       // messages buffered until the dialect is known
      this.m = { row: 0, col: 0, hi: 0, lo: 0 };   // modern matrix cursor
      this.l = { row: 0, col: 0, hi: 0, lo: 0, form: null }; // legacy cursor
      this.stream = null; this.formSel = null; this.textBuf = [];
      this.fwHi = null;
    }
    setDialect(d) { this.dialect = d; if (d !== 'auto') this._flush(); }
    _decide(d, why) {
      if (this.dialect !== 'auto') return;
      this.dialect = d; this.on({ type: 'dialect', dialect: d, why }); this._flush();
    }
    _flush() { const p = this.pending; this.pending = []; p.forEach(m => this._handle(m)); }

    feed(bytes) {
      const st = bytes[0] & 0xF0, ch = bytes[0] & 0x0F;
      if (this.dialect === 'auto') {
        // Version first: it settles the dialect outright.
        if (st === CC && ch === CH16 && bytes[1] === 102) this.fwHi = bytes[2];
        if (st === CC && ch === CH16 && bytes[1] === 103 && this.fwHi !== null) {
          const fw = (this.fwHi << 7) | bytes[2];
          this._decide(fw >= 1030 ? 'modern' : 'legacy', `firmware ${fmtFw(fw)}`);
        } else if (st === CC && ch === CH15 && (bytes[1] === 102 || bytes[1] === 103 || bytes[1] === 104)) {
          this._decide('legacy', 'matrix data seen on channel 15');
        } else if (st === CC && ch === CH16 && bytes[1] === 45 && (bytes[2] === 125 || bytes[2] === 126)) {
          this._decide('modern', 'matrix start on channel 16');
        } else if (st === POLY && ch === CH16) {
          this._decide('modern', 'stream data as poly pressure');
        }
        if (this.dialect === 'auto') { this.pending.push(bytes); if (this.pending.length > 20000) this.pending.shift(); this._handleCommon(bytes); return; }
      }
      this._handle(bytes);
    }

    // Messages whose meaning does not depend on the dialect (safe to act on before deciding).
    _handleCommon(b) {
      const st = b[0] & 0xF0, ch = b[0] & 0x0F;
      if (st !== CC || ch !== CH16) return;
      const [, cc, v] = b;
      if (cc === 102) this.s._fwHi = v;
      if (cc === 103 && this.s._fwHi !== undefined) { this.s.firmware = (this.s._fwHi << 7) | v; this.on({ type: 'firmware', firmware: this.s.firmware }); }
      if (cc === 104) { this.s.hardware = (v >> 2) & 31; this.on({ type: 'hardware', hardware: this.s.hardware }); }
      if (cc === 118) this.on({ type: 'pong' });
    }

    /** Global cc: Master settings and macros, reported on ch1 (live) or ch16 (preset load). */
    _global(ch, cc, v) {
      if (cc === 86 || cc === 97) { this.frac = { cc, v }; return true; }
      let idx = null;
      if (cc >= 12 && cc <= 17) idx = cc - 12;
      else if (ch === CH1 && this.frac && cc >= 40 && cc <= 63) idx = (this.frac.cc === 86 ? 6 : 48) + cc - 40;
      else if (ch === CH1 && this.frac && cc >= 102 && cc <= 119) idx = (this.frac.cc === 86 ? 30 : 72) + cc - 102;
      if (idx !== null) {
        const lo = this.frac ? this.frac.v : 0; this.frac = null;
        this.s.macros[idx] = (v << 7) | lo; this.on({ type: 'macro', index: idx });
        return true;
      }
      if (GLOBAL_CC_SET.has(cc)) { this.s.globals[cc] = v; this.on({ type: 'global', cc }); return true; }
      return false;
    }

    _handle(b) {
      const st = b[0] & 0xF0, ch = b[0] & 0x0F;
      if (ch === CH1 && st === CC) { this._global(CH1, b[1], b[2]); return; }
      if (ch === CH16) {
        if (st === CC) {
          this._handleCommon(b);
          if ((b[1] >= 12 && b[1] <= 26) || (b[1] >= 83 && b[1] <= 97 && b[1] !== 87 && b[1] !== 88 && b[1] !== 89)) { if (this._global(CH16, b[1], b[2])) return; }
          return this.dialect === 'legacy' ? this._ch16CcLegacy(b[1], b[2]) : this._ch16CcModern(b[1], b[2]);
        }
        if (st === POLY) return this._sData([b[1], b[2]]);
        if (st === CHPRESS) return this._sData([b[1]]);
        if (st === PROG) { this.on({ type: 'program', program: b[1] }); return; }
      }
      if (ch === CH15 && st === CC && this.dialect === 'legacy') return this._ch15CcLegacy(b[1], b[2]);
    }

    _clearAll() {
      this.s.cells.clear(); this.s.formulas = {}; this.l.form = null; this.formSel = null;
      this.on({ type: 'clear' });
    }
    _setCell(r, c, code, dec) {
      if (r < 0 || r >= N_ROWS || c < 0 || c >= N_COLS || c === 11) return;
      const k = key(r, c);
      if ((code & 63) === 0) this.s.cells.delete(k);
      else this.s.cells.set(k, { code, dec: (code & 63) === CODE.DEC ? dec : 0 });
      this.on({ type: 'cell', row: r, col: c });
    }

    _ch16CcModern(cc, v) {
      const m = this.m;
      switch (cc) {
        case 40: m.row = v; break;
        case 41: m.col = v; break;
        case 43: m.hi = v; m.lo = 0; break;
        case 42: m.lo = v; break;
        case 44: this._setCell(m.row, m.col, v, m.hi * 100 + m.lo); m.hi = m.lo = 0; break;
        case 45:
          if (v === 125) this._clearAll();
          else if (v >= 103 && v <= 105) this._clearCols(27 + 8 * (v - 103), 35 + 8 * (v - 103));
          else if (v === 124) this.on({ type: 'refreshEnd' });
          break;
        case 34: this.formSel = v; this.on({ type: 'formSel', formula: v }); break;
        case 56: this._streamSelect(v); break;
      }
    }
    _ch16CcLegacy(cc, v) {
      if (cc === 56) return this._streamSelect(v);
      if (cc >= 35 && cc <= 63 && cc !== 56 && cc !== 57) this.s.legacyRaw[16][cc] = v;
      if (cc === 62) { this.s.setup[62] = v & 7; this.on({ type: 'setup', id: 62 }); }   // recirculator type (+64 = extend), inferred
    }
    _ch15CcLegacy(cc, v) {
      const l = this.l;
      switch (cc) {
        case 102: l.row = v; return;
        case 103: l.col = v; return;
        case 116: l.hi = v; l.lo = 0; return;
        case 115: l.lo = v; return;
        case 104: this._setCell(l.row, l.col, legacyToModernCode(v), l.hi * 100 + l.lo); l.hi = l.lo = 0; return;
        case 110:
          if (v === 125) this._clearAll();
          else if (v >= 103 && v <= 105) this._clearCols(27 + 8 * (v - 103), 35 + 8 * (v - 103));
          return;
        case 34: l.form = v; this._formula(v); this.on({ type: 'formSel', formula: v }); return;
      }
      if (l.form !== null) {
        const f = this._formula(l.form);
        f.legacyRaw = f.legacyRaw || {};
        f.legacyRaw[cc] = v;
        f.pairs = legacyUnpack(f.legacyRaw);
        this.on({ type: 'formula', formula: l.form });
      } else if (LEGACY_SETUP_OK.has(cc)) {
        this.s.setup[cc] = v; this.on({ type: 'setup', id: cc });
      } else {
        // Other older-firmware settings: their numbering does not match the modern ids, so keep them raw.
        this.s.legacyRaw[15][cc] = v;
      }
    }
    _clearCols(a, b) {
      for (const k of [...this.s.cells.keys()]) { const c = k % 64; if (c >= a && c < b) this.s.cells.delete(k); }
      this.on({ type: 'clear' });
    }
    _formula(n) { return this.s.formulas[n] || (this.s.formulas[n] = { pairs: {} }); }

    _streamSelect(v) {
      this._endText();
      this.stream = v === 127 ? null : v;
      if (v === 0 || v === 1) this.textBuf = [];
      if (v === 11) this.s.kinet = [];
      if (v === 12) this.s.biqsin = [];
      if (v >= 2 && v <= 4) this.s.graphs[v] = [];
      if (v === 14) this.s.conv = [];
      if (v === 16 || v === 17) this.macroStream = [];
    }
    _endText() {
      if (this.stream === 0 || this.stream === 1) {
        const t = String.fromCharCode(...this.textBuf.filter(c => c >= 32 || c === 10)).trim();
        if (this.stream === 0) { this.s.name = t; this.on({ type: 'name', name: t }); }
        else { this.s.text = t; this.on({ type: 'text' }); }
      }
      this.textBuf = [];
    }
    _sData(bytes) {
      switch (this.stream) {
        case 0: case 1: this.textBuf.push(...bytes); break;
        case 19: if (bytes.length === 2 && this.formSel) { this._formula(this.formSel).pairs[bytes[0]] = bytes[1]; this.on({ type: 'formula', formula: this.formSel }); } break;
        case 20: if (bytes.length === 2) { this.s.setup[bytes[0]] = bytes[1]; this.on({ type: 'setup', id: bytes[0] }); } break;
        case 11: this.s.kinet.push(...bytes); this.on({ type: 'props', stream: 'kinet' }); break;   // positional arrays
        case 12: this.s.biqsin.push(...bytes); this.on({ type: 'props', stream: 'biqsin' }); break;
        case 2: case 3: case 4: this.s.graphs[this.stream].push(...bytes); this.on({ type: 'graph', graph: this.stream }); break;
        case 21: case 22: case 23: if (bytes.length === 2) { this.s.graphs[this.stream - 19][bytes[0]] = bytes[1]; this.on({ type: 'graph', graph: this.stream - 19 }); } break;
        case 14: this.s.conv.push(...bytes); this.on({ type: 'conv' }); break;
        case 26: if (bytes.length === 2) { this.s.conv[bytes[0]] = bytes[1]; this.on({ type: 'conv' }); } break;
        case 16: case 17: {    // macro high / low 7 bits, one per macro from i
          const hi = this.stream === 16; this.macroStream = this.macroStream || [];
          for (const b of bytes) {
            const i = this.macroStream.length; this.macroStream.push(b);
            const cur = this.s.macros[i] || 0;
            this.s.macros[i] = hi ? (b << 7) | (cur & 127) : (cur & ~127) | b;
          }
          this.on({ type: 'macro' }); break;
        }
        case 24: if (bytes.length === 2) { this.s.kinet[bytes[0]] = bytes[1]; this.on({ type: 'props', stream: 'kinet' }); } break;   // pokes
        case 25: if (bytes.length === 2) { this.s.biqsin[bytes[0]] = bytes[1]; this.on({ type: 'props', stream: 'biqsin' }); } break;
      }
    }
  }

  // ---------------------------------------------------------------- encoder
  const ccMsg = (ch, cc, v) => [CC | ch, cc & 127, v & 127];
  const polyMsg = (ch, a, b) => [POLY | ch, a & 127, b & 127];

  const Encoder = {
    ping(tick) { return [ccMsg(CH16, 116, tick ? 85 : 42)]; },
    requestConfig() { return [ccMsg(CH16, 109, 16)]; },          // ccTask configToMidi
    matRefresh() { return [ccMsg(CH16, 45, 124)]; },             // ccMatOp matRefresh
    selectPreset(category, index) {                               // ch16 bank + program change
      return [ccMsg(CH16, 0, category), ccMsg(CH16, 32, index >> 7), [PROG | CH16, index & 127]];
    },
    setCell(dialect, row, col, cell) {
      const code = cell ? cell.code : 0, dec = cell ? cell.dec : 0;
      const isDec = (code & 63) === CODE.DEC;
      if (dialect === 'legacy') {
        const out = [ccMsg(CH15, 103, col), ccMsg(CH15, 102, row)];
        if (isDec) out.push(ccMsg(CH15, 116, Math.floor(dec / 100)), ccMsg(CH15, 115, dec % 100));
        out.push(ccMsg(CH15, 104, modernToLegacyCode(code)));
        return out;
      }
      const out = [ccMsg(CH16, 41, col), ccMsg(CH16, 40, row), ccMsg(CH16, 45, 115)];
      if (isDec) out.push(ccMsg(CH16, 43, Math.floor(dec / 100)), ccMsg(CH16, 42, dec % 100));
      out.push(ccMsg(CH16, 44, code & 63));
      if (code & CODE.MUTE) out.push(ccMsg(CH16, 45, 122));
      return out;
    },
    setMute(dialect, row, col, cell, muted) {
      if (dialect === 'legacy') return this.setCell(dialect, row, col, { code: (cell.code & 63) | (muted ? 64 : 0), dec: cell.dec });
      return [ccMsg(CH16, 41, col), ccMsg(CH16, 40, row), ccMsg(CH16, 45, muted ? 122 : 123)];
    },
    selectCell(dialect, row, col) {
      if (dialect === 'legacy') return [];
      return [ccMsg(CH16, 41, col), ccMsg(CH16, 40, row), ccMsg(CH16, 45, 115)];
    },
    /** Formula param changes. `changed` = {id:value}; `full` = complete pairs after the change. */
    formulaChanges(dialect, num, changed, full, prevFull, selectRowCol) {
      if (dialect === 'legacy') {
        const before = prevFull ? legacyPack(prevFull) : {}, after = legacyPack(full); // prevFull null = state unknown, send everything
        const out = [ccMsg(CH15, 34, num)];
        // Neg-flag bitmasks (cc71/72) go before the heights they qualify.
        const order = Object.keys(after).map(Number).sort((a, b) => ((b === 71 || b === 72) - (a === 71 || a === 72)) || a - b);
        for (const cc of order) if (before[cc] !== after[cc]) out.push(ccMsg(CH15, cc, after[cc]));
        return out.length > 1 ? out : [];
      }
      const out = [];
      // No cell select first: ccFormSel is all a poke needs (seen on an Osmose 10.52), and a select makes
      // the device stream the whole formula back on every edit, ~95 messages per knob step.
      out.push(ccMsg(CH16, 34, num));
      // sign flag before its height, as the Editor does
      const ids = Object.keys(changed).map(Number).sort((a, b) => (SIGN_ID_SET.has(b) - SIGN_ID_SET.has(a)));
      for (const id of ids) out.push(ccMsg(CH16, 56, 19), polyMsg(CH16, id, changed[id]));
      return out;
    },
    setSetup(dialect, id, value) {
      if (dialect === 'legacy') {
        // Older firmware: only the bank types are known to sit on the channel-15 cc of the same number
        // (seen in 10.09 preset files). Other ids overlap formula fields there, so they are not sent.
        if (LEGACY_SETUP_OK.has(id)) return [ccMsg(CH15, id, value)];
        if (id === 62) return [ccMsg(CH16, 62, value & 7)];   // recirculator type: inferred from 10.09 files, untested
        throw new Error(`setting ${id} is not known for older firmware (10.09), so it was not sent`);
      }
      return [ccMsg(CH16, 56, 20), polyMsg(CH16, id, value)];
    },
    /** Kinetic or BiqBank/SineBank property (e.g. an assignable column's function).
     *  Modern: a single poke (stream 24 / 25). Legacy: resend the whole positional stream (11 / 12),
     *  the way a preset file carries it. The legacy form is inferred from archives, not device-tested. */
    setBankProp(dialect, which, id, value, current) {
      if (dialect === 'legacy') {
        if (!current || current.length < 48) throw new Error('the device has not sent these properties yet');
        const a = current.slice(0, 48); a[id] = value;
        return [ccMsg(CH16, 56, which === 'kinet' ? 11 : 12), ...a.map(b => [CHPRESS | CH16, (b || 0) & 127]), ccMsg(CH16, 56, 127)];
      }
      return [ccMsg(CH16, 56, which === 'kinet' ? 24 : 25), polyMsg(CH16, id, value)];
    },
    /** Several properties at once ([[id, value], ...]): one poke stream, or one legacy replay. */
    setBankProps(dialect, which, pairs, current) {
      if (dialect === 'legacy') {
        if (!current || current.length < 48) throw new Error('the device has not sent these properties yet');
        const a = current.slice(0, 48); pairs.forEach(([id, v]) => a[id] = v);
        return [ccMsg(CH16, 56, which === 'kinet' ? 11 : 12), ...a.map(b => [CHPRESS | CH16, (b || 0) & 127]), ccMsg(CH16, 56, 127)];
      }
      return [ccMsg(CH16, 56, which === 'kinet' ? 24 : 25), ...pairs.map(([id, v]) => polyMsg(CH16, id, v))];
    },
    /** Master and other global cc: front ends transmit these on ch1. */
    setGlobal(cc, v) { return [ccMsg(CH1, cc, v)]; },
    /** Macro i..m90 to a value (0..1 for i..vi, -1..1 for m7..m90). */
    setMacro(i, value) {
      const raw = macroFromValue(i, value), [fcc, vcc] = macroCcs(i);
      return [ccMsg(CH1, fcc, raw & 127), ccMsg(CH1, vcc, raw >> 7)];
    },
    /** One point of a graph (g = 2 main, 3 / 4 offsets). Legacy replays the whole 48-value stream. */
    setGraph(dialect, g, id, value, current) {
      if (dialect === 'legacy') {
        const a = Array.from({ length: 48 }, (_, i) => (current && current[i]) || 0); a[id] = value;
        return [ccMsg(CH16, 56, g), ...a.map(b => [CHPRESS | CH16, b & 127]), ccMsg(CH16, 56, 127)];
      }
      return [ccMsg(CH16, 56, 19 + g), polyMsg(CH16, id, value)];
    },
    /** Convolution setting (s_Conv_Poke). Older firmware lays this stream out differently, so it is not sent there. */
    setConv(dialect, id, value) {
      if (dialect === 'legacy') throw new Error('convolution settings are not known for older firmware (10.09)');
      return [ccMsg(CH16, 56, 26), polyMsg(CH16, id, value)];
    },
    clearMatrix(dialect) { return dialect === 'legacy' ? [ccMsg(CH15, 110, 125)] : [ccMsg(CH16, 45, 125)]; },
  };
  const SIGN_ID_SET = new Set(Object.values(SIGN_OF));
  const LEGACY_SETUP_OK = new Set([91, 92, 93]);

  // ---------------------------------------------------------------- MIDI helpers
  function fmtFw(fw) { return fw == null ? '?' : `${Math.floor(fw / 100)}.${String(fw % 100).padStart(2, '0')}`; }
  const HARDWARE = { 1: 'Continuum (light, full)', 2: 'Continuum (light, half)', 3: 'Continuum (classic, full)', 4: 'Continuum (classic, half)', 5: 'ContinuuMini', 6: 'Osmose', 7: 'Slim 22', 8: 'Slim 46', 9: 'Slim 70', 10: 'EaganMatrix Module', 11: 'Continuum (full, UP)', 12: 'Continuum (half, UP)', 13: 'EaganMatrix Micro' };

  const CH16_CC_NAMES = { 0: 'BankH', 32: 'BankL', 34: 'FormSel', 35: 'FormCopy', 40: 'Row', 41: 'Col', 42: 'MatDecLo', 43: 'MatDecHi', 44: 'MatVal', 45: 'MatOp', 56: 'Stream', 72: 'PolyDsp', 102: 'VersHi', 103: 'VersLo', 104: 'CVCHi/hw', 109: 'Task', 110: 'DInfo', 111: 'LedAes', 112: 'Store', 114: 'DspUse', 116: 'Ping', 118: 'Pong' };
  const CH15_LEGACY_NAMES = { 34: 'FormSel', 102: 'Row', 103: 'Col', 104: 'MatVal', 110: 'MatOp', 115: 'MatDecLo', 116: 'MatDecHi' };
  function describe(bytes) {
    const st = bytes[0] & 0xF0, ch = (bytes[0] & 15) + 1;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    let d = '';
    if (st === CC) {
      const nm = ch === 16 ? CH16_CC_NAMES[bytes[1]] : ch === 15 ? CH15_LEGACY_NAMES[bytes[1]] : null;
      d = `ch${ch} cc${bytes[1]}${nm ? ' ' + nm : ''} = ${bytes[2]}`;
    } else if (st === POLY) d = `ch${ch} sData ${bytes[1]}, ${bytes[2]}`;
    else if (st === CHPRESS) d = `ch${ch} chPress ${bytes[1]}`;
    else if (st === PROG) d = `ch${ch} program ${bytes[1]}`;
    else if (st === 0x90) d = `ch${ch} note on ${bytes[1]} vel ${bytes[2]}`;
    else if (st === 0x80) d = `ch${ch} note off ${bytes[1]}`;
    else if (st === 0xE0) d = `ch${ch} bend ${(bytes[2] << 7 | bytes[1]) - 8192}`;
    return { hex, text: d };
  }

  /** Standard MIDI File -> array of [status,d1,d2] channel messages (track order merged by time). */
  function parseSmf(buf) {
    const u = new Uint8Array(buf); let p = 0;
    const rd32 = () => { const v = (u[p] << 24 | u[p + 1] << 16 | u[p + 2] << 8 | u[p + 3]) >>> 0; p += 4; return v; };
    const rd16 = () => { const v = u[p] << 8 | u[p + 1]; p += 2; return v; };
    const tag = () => String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
    if (tag() !== 'MThd') throw new Error('Not a MIDI file');
    p += 4; const hlen = rd32(); rd16(); const ntrk = rd16(); rd16(); p += hlen - 6;
    const events = []; let seq = 0;
    for (let t = 0; t < ntrk && p < u.length; t++) {
      if (tag() !== 'MTrk') break; p += 4; const len = rd32(); const end = p + len;
      let time = 0, running = 0;
      while (p < end) {
        let dt = 0, b; do { b = u[p++]; dt = (dt << 7) | (b & 127); } while (b & 128);
        time += dt;
        let st = u[p];
        if (st & 0x80) p++; else st = running;
        if (st === 0xFF) { p++; let l = 0; do { b = u[p++]; l = (l << 7) | (b & 127); } while (b & 128); p += l; continue; }
        if (st === 0xF0 || st === 0xF7) { let l = 0; do { b = u[p++]; l = (l << 7) | (b & 127); } while (b & 128); p += l; continue; }
        running = st;
        const n = ((st & 0xF0) === 0xC0 || (st & 0xF0) === 0xD0) ? 1 : 2;
        const msg = [st]; for (let i = 0; i < n; i++) msg.push(u[p++]);
        events.push({ time, seq: seq++, msg });
      }
      p = end;
    }
    events.sort((a, b) => a.time - b.time || a.seq - b.seq);
    return events.map(e => e.msg);
  }

  const api = {
    CH1, CH15, CH16, ROW_NAMES, COL_NAMES, N_ROWS, N_COLS, VALUE_LABELS, VALUE_HELP, CODE, LETTERS,
    isFormulaCode, formulaLetter, cellLabel, parseCellValue, legacyToModernCode, modernToLegacyCode,
    F, SIGN_OF, OPTIONS, COMPONENTS, fget, heightGet, heightSet, formulaSummary, legacyPack, legacyUnpack,
    SETUP, OSC_TYPES, BANK_AB_TYPES, BANK_C_TYPES, SG_TYPES, BANK_COL_LABELS, HARDWARE,
    newState, key, unkey, Decoder, Encoder, describe, parseSmf, fmtFw,
    GLOBAL_CC, macroName, macroToValue, macroFromValue, macroCcs,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
