/* Modulators: modules that hide a formula behind a few musical parameters.
 *
 * A modulator owns one formula letter (and, for envelopes and LFOs, one shape generator). Its
 * output cable is that letter placed on a Direct row into the target input. Changing a parameter
 * rewrites the formula. The recipes follow the common techniques in the Osmose Preset Cookbook
 * (Programming Osmose Gestures, and the Tremolo / Vibrato building blocks):
 *   Tap = Z-scaled single-cycle SG pulse; Press = Z only; Aftertouch = Y only; Shake = derivative Z;
 *   Pluck = single-cycle SG ramp down, gated; Sustain = gate with persistence for release;
 *   LFO = continuous SG.
 * Macro modules stand for one macro control each; a cable from a macro is a formula
 * "W constant × macro", recognised again when a preset is read back.
 */
(function (root) {
  'use strict';
  const EM = root.EM;
  const F = EM.F;

  const num = (key, label, min, max, step, def, desc, unit = '') => ({ key, label, type: 'num', min, max, step, def, desc, unit });
  const sel = (key, label, options, def, desc) => ({ key, label, type: 'sel', options, def, desc });
  const RANGE = sel('range', 'Range', ['× 0.001', '× 0.01', '× 0.1', '× 1', '× 10', '× 100'], 3,
    'Multiplies the amount. Noise into a resonator wants tiny values (× 0.001), a frequency in kHz may want × 10.');
  const CURVE = sel('curve', 'Curve', EM.OPTIONS.yzTrans.slice(0, 6), 0, 'How the value follows your finger');
  const AMOUNT = (def = 1) => num('amount', 'Amount', -1, 1, 0.01, def, 'How far the output goes (times the range)');
  const SG_TRIGGER_SHAPES = { 'Pulse': 2, 'Ramp down': 1, 'Triangle': 4, 'Hann': 5, 'Steep S down': 9, 'Gentle S down': 8 };
  const LFO_SHAPES = { 'Sine': 11, 'Triangle': 4, 'Square': 10, 'Ramp up': 0, 'Ramp down': 1, 'Hann': 5, 'Sample & hold': 12 };

  /** A clean formula: every component zero, multipliers × 1, default smoothing. */
  function fresh() {
    const p = {};
    [F.FormOp, F.SgW, F.ScaleW, F.ShapeW, F.SWMacr, F.Persist, F.InitX, F.InitY, F.InitZ, F.TransY, F.TransZ, F.Blend, F.AncOp].forEach(id => p[id] = 0);
    [F.MultW, F.MultX, F.MultY, F.MultZ].forEach(id => p[id] = 3);
    [F.HeightW, F.VBegX, F.VEndX, F.VBegY, F.VEndY, F.VBegZ, F.VEndZ].forEach(id => EM.heightSet(p, id, 0));
    p[F.TransX] = 1; p[F.ZeroX] = 60; p[F.Interp] = 40;
    p[F.HBegX] = 0; p[F.HEndX] = 12; p[F.HBegY] = 0; p[F.HEndY] = 12; p[F.HBegZ] = 0; p[F.HEndZ] = 12;
    return p;
  }
  const h = (p, id, v) => EM.heightSet(p, id, Math.max(-1, Math.min(1, v)));

  // Each gesture: params, whether it needs a shape generator, and build(params, sgSlot) ->
  // { pairs, sg: { type, rate, trigger } } where trigger true = restart on each note (gate).
  const GESTURES = {
    pressure: {
      name: 'Pressure', group: 'Gestures',
      desc: 'Follows how hard you press (Z). Add some aftertouch to keep it rising through the bottom of the key.',
      params: [AMOUNT(), RANGE, CURVE, num('at', 'Aftertouch', 0, 1, 0.01, 0, 'Extra amount added by aftertouch (Y), so the key’s whole travel counts')],
      build(q) {
        const p = fresh(); h(p, F.VEndZ, q.amount); p[F.MultZ] = q.range; p[F.TransZ] = q.curve;
        if (q.at) { h(p, F.VEndY, q.amount * q.at); p[F.MultY] = q.range; p[F.TransY] = q.curve; }
        return { pairs: p };
      },
    },
    aftertouch: {
      name: 'Aftertouch', group: 'Gestures',
      desc: 'Follows the Osmose’s aftertouch zone (Y): nothing until you press into the bottom of the key.',
      params: [AMOUNT(), RANGE, CURVE],
      build(q) { const p = fresh(); h(p, F.VEndY, q.amount); p[F.MultY] = q.range; p[F.TransY] = q.curve; return { pairs: p }; },
    },
    keytrack: {
      name: 'Key tracking', group: 'Gestures',
      desc: 'Rises across the keyboard (X), zero at the centre note. Useful to open a filter or brighten higher notes. Cabled into a Freq input it makes that input follow the played pitch exactly instead.',
      params: [AMOUNT(0.5), RANGE, num('centre', 'Centre note', 24, 96, 1, 60, 'MIDI note where the output is zero (60 = middle C)')],
      build(q) { const p = fresh(); p[F.TransX] = 2; h(p, F.VBegX, -q.amount); h(p, F.VEndX, q.amount); p[F.MultX] = q.range; p[F.ZeroX] = q.centre; return { pairs: p }; },
    },
    gate: {
      name: 'Gate', group: 'Gestures',
      desc: 'On (the amount) while a key is held, off when it is released: W, with no pressure involved.',
      params: [AMOUNT(1), RANGE],
      build(q) { const p = fresh(); p[F.SgW] = 1; h(p, F.HeightW, q.amount); p[F.MultW] = q.range; return { pairs: p }; },
    },
    shake: {
      name: 'Shake', group: 'Gestures',
      desc: 'Responds to how fast the key moves (derivative of Z), not how far: shaking a held key wobbles the output.',
      params: [AMOUNT(0.5), RANGE],
      build(q) { const p = fresh(); p[F.InitZ] = 2; h(p, F.VEndZ, q.amount); p[F.MultZ] = q.range; return { pairs: p }; },
    },
    tap: {
      name: 'Tap / hit', group: 'Envelopes', sg: true,
      desc: 'A short burst at the start of each note, scaled by pressure. Strike the key quickly to hear it; press slowly and it fades away. Classic for exciting a resonator with noise.',
      params: [AMOUNT(1), RANGE, num('rate', 'Speed (Hz)', 1, 18, 0.5, 18, 'Shape generator speed. 9 Hz or more is typical; higher is a shorter hit', 'Hz'),
        sel('shape', 'Shape', Object.keys(SG_TRIGGER_SHAPES), 0, 'Pulse is the sharpest; Ramp down and Hann are softer'),
        num('sens', 'Pressure sens.', 0, 1, 0.01, 1, 'How much the hit depends on striking the key hard (1 = fully, 0 = always the same)'),
        num('ring', 'Ring', 0, 127, 1, 0, 'Persistence: lets the hit decay slowly instead of stopping')],
      build(q, sg) {
        const p = fresh(); p[F.SgW] = 1 + sg; p[F.ShapeW] = SG_TRIGGER_SHAPES[Object.keys(SG_TRIGGER_SHAPES)[q.shape]];
        h(p, F.HeightW, q.amount); p[F.MultW] = q.range; p[F.FormOp] = 1;          // W × (X + Y + Z)
        h(p, F.VBegZ, 1 - q.sens); h(p, F.VEndZ, 1); p[F.Persist] = q.ring;
        return { pairs: p, sg: { type: 1, rate: q.rate, trigger: true } };
      },
    },
    pluck: {
      name: 'Pluck envelope', group: 'Envelopes', sg: true,
      desc: 'Jumps up when a note starts, then decays. How hard you strike sets the level.',
      params: [AMOUNT(1), RANGE, num('decay', 'Decay (s)', 0.05, 10, 0.01, 0.6, 'Time to fall back to zero', 's'),
        sel('shape', 'Shape', ['Ramp down', 'Steep S down', 'Gentle S down'], 0, 'Fall shape'),
        num('vel', 'Velocity', 0, 1, 0.01, 0.6, 'How much the initial pressure sets the level (0 = always full)')],
      build(q, sg) {
        const shapes = [1, 9, 8];
        const p = fresh(); p[F.SgW] = 1 + sg; p[F.ShapeW] = shapes[q.shape];
        h(p, F.HeightW, q.amount); p[F.MultW] = q.range; p[F.FormOp] = 1;
        p[F.InitZ] = 1; h(p, F.VBegZ, 1 - q.vel); h(p, F.VEndZ, 1);               // initial pressure
        return { pairs: p, sg: { type: 1, rate: Math.min(10, 1 / Math.max(0.1, q.decay)), trigger: true } };
      },
    },
    sustain: {
      name: 'Sustain envelope', group: 'Envelopes',
      desc: 'On while a key is held, with a smoothed attack and a release after you let go. Optionally follows pressure.',
      params: [AMOUNT(1), RANGE, num('attack', 'Attack', 0, 127, 1, 40, 'Smoothing (interpolation): higher is a slower rise'),
        num('release', 'Release', 0, 127, 1, 60, 'Persistence: higher holds the sound longer after the key is released'),
        num('press', 'Pressure', 0, 1, 0.01, 0, 'How much it follows pressure while held (0 = steady)'),
        num('at', 'Aftertouch', 0, 1, 0.01, 0, 'Extra amount added by aftertouch (Y), pressing through the bottom of the key')],
      build(q) {
        const p = fresh(); p[F.SgW] = 1; h(p, F.HeightW, q.amount); p[F.MultW] = q.range;
        p[F.Interp] = q.attack; p[F.Persist] = q.release;
        if (q.press > 0) { p[F.FormOp] = 1; h(p, F.VBegZ, 1 - q.press); h(p, F.VEndZ, 1); }
        if (q.at > 0) { h(p, F.VEndY, q.at); p[F.MultY] = q.range; }
        return { pairs: p };
      },
    },
    lfo: {
      name: 'LFO', group: 'Modulators', sg: true,
      desc: 'A repeating wave from a shape generator, for vibrato, tremolo or slow movement. Depth can follow pressure, aftertouch or a macro.',
      params: [num('depth', 'Depth', 0, 1, 0.01, 0.3, 'Size of the wave (times the range)'), RANGE,
        num('rate', 'Rate (Hz)', 0.05, 10, 0.01, 5, 'Speed of the wave', 'Hz'),
        sel('shape', 'Shape', Object.keys(LFO_SHAPES), 0, 'Wave shape'),
        sel('ctl', 'Depth control', ['Fixed', 'Pressure', 'Aftertouch', 'Macro i', 'Macro ii', 'Macro iii', 'Macro iv', 'Macro v', 'Macro vi'], 0, 'What sets how much of the wave you hear'),
        sel('centre', 'Centre', ['Above zero', 'Around zero'], 1, 'Around zero moves both ways (good for vibrato); only with Fixed or Macro depth'),
        sel('sync', 'Key sync', ['Free running', 'Restart each note'], 0, 'Restart the wave when a note starts')],
      build(q, sg) {
        const p = fresh(); p[F.SgW] = 1 + sg; p[F.ShapeW] = LFO_SHAPES[Object.keys(LFO_SHAPES)[q.shape]];
        h(p, F.HeightW, q.depth); p[F.MultW] = q.range;
        if (q.ctl === 1) { p[F.FormOp] = 1; h(p, F.VEndZ, 1); }
        else if (q.ctl === 2) { p[F.FormOp] = 1; h(p, F.VEndY, 1); }
        else if (q.ctl >= 3) { p[F.ScaleW] = 1; p[F.SWMacr] = q.ctl - 3; }
        if (q.centre === 1 && (q.ctl === 0 || q.ctl >= 3)) {   // constant offset through X with a flat range
          p[F.TransX] = 2; h(p, F.VBegX, -q.depth / 2); h(p, F.VEndX, -q.depth / 2); p[F.MultX] = q.range;
        }
        return { pairs: p, sg: { type: 0, rate: q.rate, trigger: q.sync === 1 } };
      },
    },
  };
  const defaults = g => Object.fromEntries(GESTURES[g].params.map(x => [x.key, x.def]));

  // ---------------------------------------------------------------- macros
  /** A formula that is just "constant × macro": a macro cable. Returns the macro index or null. */
  function macroOf(pairs) {
    if (!pairs) return null;
    const g = id => EM.fget(pairs, id);
    if (g(F.ScaleW) !== 1 || g(F.SgW) !== 0) return null;
    for (const c of Object.values(EM.COMPONENTS)) if (EM.heightGet(pairs, c.vBeg) !== 0 || EM.heightGet(pairs, c.vEnd) !== 0) return null;
    if (g(F.FormOp) !== 0 || g(F.AncOp) !== 0) return null;
    return g(F.SWMacr);
  }
  function macroFormula(index, amount = 1) { const p = fresh(); p[F.ScaleW] = 1; p[F.SWMacr] = index; h(p, F.HeightW, amount); return p; }
  /** Names from the preset text, e.g. "i=BowSpeed_Long_Short ii=Body" -> {0: {name, lo, hi}}. */
  function macroNames(text) {
    const out = {};
    const re = /(?:^|\s)(i|ii|iii|iv|v|vi|m\d{1,2})=(\S+)/g; let m;
    const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi'];
    while ((m = re.exec(text || ''))) {
      const idx = roman.includes(m[1]) ? roman.indexOf(m[1]) : +m[1].slice(1) - 1;
      const [name, lo, hi] = m[2].split('_');
      out[idx] = { name, lo: lo && !/^0[a-z]$/.test(lo) ? lo : '', hi: hi || '' };
    }
    return out;
  }

  // ---------------------------------------------------------------- Master section
  const RECIRC_TYPES = [
    { name: 'Short reverb', dials: ['Diffuse', 'Damping', 'Darkness', 'Decay', 'Pre-delay', 'High pass'] },
    { name: 'Modulated delay', dials: ['Mod depth', 'Mod rate', 'Feedback', 'Time', '—', '—'] },
    { name: 'Swept echo', dials: ['Noise', 'L/R offset', 'Feedback', 'Time', '—', '—'] },
    { name: 'Analog echo', dials: ['Mod depth', 'Mod rate', 'Feedback', 'Time', '—', '—'] },
    { name: 'Digital echo (low pass)', dials: ['Low pass', 'L/R offset', 'Feedback', 'Time', '—', '—'] },
    { name: 'Digital echo (high pass)', dials: ['High pass', 'L/R offset', 'Feedback', 'Time', '—', '—'] },
    { name: 'Long reverb', dials: ['Diffuse', 'Damping', 'Darkness', 'Decay', 'Pre-delay', 'High pass'] },
  ];
  const RECIRC_DESC = {
    Diffuse: 'Smooths the reverb tail; subtle, interacts with decay', Damping: 'Removes highs on each pass: the tail gets duller over time',
    Darkness: 'Rolls off highs going into the reverb: duller straight away', Decay: 'Length of the reverb', 'Pre-delay': 'Gap before the reverb starts',
    'High pass': 'Removes lows from the effect', 'Mod depth': 'How much the delay time wobbles', 'Mod rate': 'How fast the delay time wobbles',
    Feedback: 'How many repeats', Time: 'Delay time', Noise: 'Noise added into the repeats', 'L/R offset': 'Timing offset between left and right',
    'Low pass': 'Filters the echo output (0 = darkest)',
  };
  const RECIRC_CC = [20, 21, 22, 23, 95, 96];
  const MASTER_KNOBS = {
    levels: [{ cc: 26, label: 'Pre level', desc: 'Level going into the Master effects. Use large values in the SL/SR columns and a lower Pre level for saturation.' },
      { cc: 18, label: 'Post level', desc: 'Final output level after the Master section' },
      { cc: 19, label: 'Audio in', desc: 'Level of the audio input rows' }],
    comp: [{ cc: 90, label: ['Threshold', 'Drive'], desc: 'Compressor threshold, or tanh drive' }, { cc: 91, label: ['Attack', '—'], desc: 'Compressor attack' },
      { cc: 92, label: ['Ratio', 'Makeup'], desc: 'Compressor ratio, or tanh makeup gain' }, { cc: 93, label: ['Mix', 'Mix'], desc: 'Dry / processed mix' }],
    eq: [{ cc: 83, label: 'Tilt', desc: 'Tilt EQ: 64 is flat, lower is darker, higher is brighter', centre: 64 },
      { cc: 84, label: 'Frequency', desc: 'Tilt EQ pivot frequency, 120 Hz to 15 kHz', fmt: v => { const f = 120 * Math.pow(125, v / 127); return f >= 1000 ? (f / 1000).toFixed(1) + 'k' : Math.round(f) + ''; } },
      { cc: 85, label: 'EQ mix', desc: 'How much of the EQ is applied (0 = off)' }],
  };
  const CONV_IRS = ['Waterphone 1', 'Waterphone 2', 'Autoharp 1', 'Autoharp 2', 'Guitar dark', 'Finger snap', 'Wood', 'Metal bright', 'Fiber', 'Leather',
    'Metal damped', 'Nylon', 'Cloth', 'Eowave gong', 'LVDL pyramid', 'LVDL gong', 'LVDL onde', 'White', 'Grey'];

  root.EMMods = { GESTURES, defaults, fresh, macroOf, macroFormula, macroNames, RECIRC_TYPES, RECIRC_DESC, RECIRC_CC, MASTER_KNOBS, CONV_IRS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.EMMods;
})(typeof globalThis !== 'undefined' ? globalThis : this);
