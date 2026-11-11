/* Module catalog: what can be placed in a patch, the hardware slots it occupies, and what each
 * input does for each module type. Sources: EaganMatrix User Guide sections 6.2-6.17 and
 * HakenMidi.h (type values, column-mode selectors, property column selectors).
 *
 * Input kinds:  'audio' = an audio-rate signal input (no dial)
 *               'ctl'   = a control value; gets a dial whose value is written as matrix constants
 */
(function (root) {
  'use strict';
  const EM = root.EM;

  // -------- input helpers
  // An input that usually follows a performance signal: a Direct + cable holding X (pitch) or W (gate).
  const FOLLOW_X = { code: 46, label: 'X', name: 'pitch' };
  const FOLLOW_W = { code: 45, label: 'W', name: 'gate' };
  const A = (label, desc) => ({ label, desc, kind: 'audio' });
  const C = (label, desc, min = 0, max = 1, step = 0.01, unit = '') => ({ label, desc, kind: 'ctl', min, max, step, unit });
  const KHZ = (label = 'Freq', desc = 'Frequency in kHz. Usually follows the played pitch (X).') => ({ ...C(label, desc, 0, 10, 0.001, 'kHz'), follow: FOLLOW_X });
  const UNUSED = { label: '—', desc: 'Not used by this type', kind: 'none' };

  // -------- Osc/Filter slot types (s_Mat_Poke idOscFilTyp1..5 values)
  const OSC_FAMILY = {};
  const oscType = (value, name, group, inputs, extra = {}) => { OSC_FAMILY[value] = { value, name, group, inputs, ...extra }; };
  const filt = (value, name, bLabel = 'Width', bDesc = 'Bandwidth: smaller values narrow it and add resonance', bMax = 2) =>
    oscType(value, name, 'Filters', [A('In', 'Audio input'), KHZ('Cutoff', 'Cutoff / centre frequency in kHz'), C(bLabel, bDesc, 0, bMax)],
      { options: { cascade: true, extreme: true } });
  oscType(0, 'DSF oscillator', 'Oscillators', [C('Phase mod', 'Phase modulation, 0 = 0, 1 = 2π. Leave at 0 for a plain oscillator.', -1, 1), KHZ(), C('Brightness', 'Spectral balance: 0 = pure sine, 1 = maximum harmonics')]);
  oscType(1, 'Integrated DSF osc', 'Oscillators', [C('Phase mod', 'Phase modulation input', -1, 1), KHZ(), C('Brightness', 'Spectral balance: 0 = pure sine, 1 = maximum harmonics')]);
  oscType(18, 'PWM oscillator', 'Oscillators', [C('Triangle', 'Moves the waveform from square towards triangle'), KHZ(), C('Pulse width', 'Pulse width')],
    { options: { variant: ['Linear PWM', 'Exponential PWM'] } });
  oscType(2, 'Jenny oscillator', 'Oscillators', [UNUSED, C('Decay ×', 'Bx: bandwidth multiplier, speeds up the resonance decay', 0, 4), C('Freq ×', 'Fx: frequency multiplier relative to the master oscillator to its left', 0, 8)],
    { needsMasterLeft: true, options: { variant: ['Sharp decay', 'Smooth decay', 'Hann decay', 'No decay'] } });
  oscType(3, 'Phase generator', 'Oscillators', [C('Phase mod', 'Phase modulation input', -1, 1), KHZ(), C('Spread (Hz)', 'Frequency spread in Hz for the sum-of-7 option', 0, 10)],
    { options: { variant: ['Sum of 7 phases', 'Ramp up', 'Ramp down', 'Triangle'] } });
  oscType(4, 'Noise from seed', 'Oscillators', [C('Seed', 'Seed value for the noise'), UNUSED, C('Trigger', 'Going above 0 reseeds the noise', -1, 1)]);
  filt(5, 'Low pass'); filt(6, 'High pass'); filt(7, 'Band pass'); filt(8, 'Band reject'); filt(9, 'All pass');
  filt(10, 'Low shelf'); filt(11, 'High shelf');
  oscType(12, 'Low pass, 1 pole', 'Filters', [A('In', 'Audio input'), KHZ('Cutoff', 'Cutoff in kHz'), UNUSED]);
  oscType(13, 'High pass, 1 pole', 'Filters', [A('In', 'Audio input'), KHZ('Cutoff', 'Cutoff in kHz'), UNUSED]);
  oscType(19, 'Ladder low pass', 'Filters', [A('In', 'Audio input'), KHZ('Cutoff', 'Cutoff in kHz'), C('Resonance', '0 = maximum resonance, 1 = minimum resonance')],
    { options: { variant: ['Transistor ladder', 'Diode ladder'], extreme: true } });
  oscType(14, 'Multiplier (ring mod)', 'Processors', [A('In 1', 'First audio input'), A('In 2', 'Second audio input, multiplied by the first'), C('Delay', 'Successively longer delay on the second input')]);
  oscType(15, 'Tanh saturator', 'Processors', [A('In', 'Audio input'), C('Drive', 'Drive amount', 0, 4), C('Col 3', 'Third column')]);
  oscType(16, 'Bit crusher', 'Processors', [A('In', 'Audio input'), C('Crush', 'Crush amount'), C('Col 3', 'Third column')]);
  oscType(17, 'Pitch shifter', 'Processors', [C('Ratio', 'Frequency multiplier on the delay data: 0.5 = octave down, 1 = unchanged, 2 = octave up', 0, 2), KHZ('Source freq', 'Original frequency of the delay data, kHz'), KHZ('Grain freq', 'Granulator frequency, kHz')]);
  const MASTER_OSC_TYPES = new Set([0, 1, 3]); // a Jenny needs one of these to its left

  // -------- Banks (idBankA/B/C values)
  const BIQSIN_SEL = ['—', 'sF spread', 'qF curve', 'B width', 'R even/odd', 'C centre', 'sB width spread', 'qB / sP', 'sA amp spread', '1F peak freq', '2F peak freq', '3F peak freq', '1B peak width', '2B peak width', '3B peak width', '1A peak amp', '2A peak amp', '3A peak amp'];
  const KINET_SEL = ['—', 'Anchor', 'Spring', 'Mass', 'Gravity', 'Height', 'Viscosity', 'Elasticity', 'Padding', 'Slip friction', 'Quit-slip'];
  // Bank properties (the Haken Editor's Properties panel): a value 0..100 maps onto [min, max];
  // a column assigned to a property adds to it. Ids are per bank (Bank B/C adds 24).
  // Ranges and defaults are from the Haken Editor 10.52 BiqBank / Kinetic panels.
  const P = (id, sym, label, desc, min, max, extra = {}) => ({ id, sym, label, desc, min, max, ...extra });
  const BIQSIN_PROPS = [
    P(1, 'sF', 'Spread', 'Mode frequency spread from the fundamental: 1 = harmonic', 0, 2),
    P(2, 'qF', 'Spread curve', 'Quadratic mode frequency spread', 0, 0.1),
    P(3, 'B', 'Bandwidth', 'Mode bandwidth: narrow to wide', 0, 2),
    P(4, 'R', 'Even/odd', 'Amplitude balance of even and odd modes: 0 = balanced', -1, 1),
    P(5, 'C', 'Centre', 'Centre of focus for the spreads below: 0 = mode 1, 1 = mode 8', 0, 1),
    P(6, 'sB', 'BW spread', 'Bandwidth increase away from the centre', 0, 2),
    P(7, 'qB', 'BW curve', 'Quadratic bandwidth increase away from the centre (SineBank: phase spread)', 0, 1),
    P(8, 'sA', 'Amp spread', 'Amplitude decrease away from the centre (0 to -30 dB; SineBank 0 to -12 dB)', 0, 2),
    P(9, '1F', 'Peak 1 freq', 'Spectral peak 1 frequency as a note number; 0 = 1 kHz', 0, 127, { note: true }),
    P(10, '2F', 'Peak 2 freq', 'Spectral peak 2 frequency as a note number; 0 = 1 kHz', 0, 127, { note: true }),
    P(11, '3F', 'Peak 3 freq', 'Spectral peak 3 frequency as a note number; 0 = 1 kHz', 0, 127, { note: true }),
    P(12, '1B', 'Peak 1 width', 'Spectral peak 1 bandwidth', 0, 2),
    P(13, '2B', 'Peak 2 width', 'Spectral peak 2 bandwidth', 0, 2),
    P(14, '3B', 'Peak 3 width', 'Spectral peak 3 bandwidth', 0, 2),
    P(15, '1A', 'Peak 1 amp', 'Spectral peak 1 amplitude (-30 to +30 dB)', -5, 5),
    P(16, '2A', 'Peak 2 amp', 'Spectral peak 2 amplitude (-30 to +30 dB)', -5, 5),
    P(17, '3A', 'Peak 3 amp', 'Spectral peak 3 amplitude (-30 to +30 dB)', -5, 5),
  ];
  const KINET_PROPS = [
    P(1, 'A', 'Anchor', 'Anchor position', -1, 1), P(2, 'K', 'Spring', 'Spring constant', 0, 1), P(3, 'M', 'Mass', 'Mass', 0, 1),
    P(4, 'G', 'Gravity', 'Gravity', 0, 1), P(5, 'H', 'Height', 'Height of the container (it extends from -H to +H)', 0, 1),
    P(6, 'V', 'Viscosity', 'Viscosity', 0, 1), P(7, 'E', 'Elasticity', 'Elasticity', 0, 1), P(8, 'P', 'Padding', 'Thickness of the squishy lining at ±H', 0, 1),
    P(9, 'S', 'Slip friction', 'Slipping friction', 0, 1), P(10, 'Q', 'Quit-slip', 'Quit-slipping speed', 0, 1),
    P(17, '', 'Spring curve', 'Spring non-linearity (not reachable from a column)', 0, 1), P(18, '', 'Viscosity curve', 'Viscosity non-linearity (not reachable from a column)', 0, 1),
    P(19, '', 'Tune (semis)', 'Model step-frequency trim in semitones', -24, 24, { raw: [36, 84], offset: 60 }),
    P(20, '', 'Tune (cents)', 'Model step-frequency trim in cents', -60, 60, { raw: [4, 124], offset: 64 }),
  ];
  // Firmware defaults for a new bank (24 values; columns 3..7 = sF B sB C sA for BiqBank/SineBank).
  const BIQSIN_DEFAULTS = [0, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 1, 3, 6, 5, 8, 0];
  const KINET_DEFAULTS = [0, 50, 20, 20, 0, 100, 20, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 60, 64, 0, 0, 0];
  /** Property raw byte (0..127) <-> value in its units. */
  const propToValue = (p, raw) => p.note ? raw : p.offset !== undefined ? raw - p.offset : p.min + (raw / 100) * (p.max - p.min);
  const propFromValue = (p, v) => p.note ? Math.max(0, Math.min(127, Math.round(v))) : p.offset !== undefined ? Math.max(p.raw[0], Math.min(p.raw[1], Math.round(v) + p.offset))
    : Math.max(0, Math.min(100, Math.round((v - p.min) / (p.max - p.min) * 100)));
  const BQ_SIZES = ['8 modes', '16 modes', '24 modes', '32 modes', '40 modes', '48 modes'];
  const DEFLATE = ['Deflate 0', 'Deflate 1', 'Deflate 2', 'Deflate 3', 'Deflate 4', 'Deflate 5', 'Deflate 6', 'Deflate 7', 'IIT'];
  const SPECTRAL_SETS = ['Live (from the delay)', 'Bell', 'Drum', 'KalimbaHard', 'KalimbaSoft', 'MarimbaHard', 'MarimbaSoft', 'mBiraski', 'Metal', 'Sprong', 'Noise1', 'Noise2', 'StringTap1', 'StringTap2', 'StringTap3', 'ViolaLegato', 'ViolaMarcato', 'PizzicatoLoud', 'PizzicatoSnap', 'PizzicatoSoft', 'SpiccatoLoud', 'SpiccatoSoft', 'AltoFlute', 'AltoSax', 'Brass', 'Clarinet1', 'Clarinet2', 'Flute1', 'Flute2', 'Oboe1', 'Oboe2', 'Ukulele1', 'Ukulele2', 'Ukulele3', 'ToyPiano1Strike', 'ToyPiano1Release', 'ToyPiano2Strike', 'Crystal'];
  const ADDITIVE_SETS = ['Mahling phrase', 'Analyses 1–10', 'Analyses 11–20', 'Analyses 21–30', 'Analyses 31–40'];
  const MODE_TIPS = {
    size: 'How many modes (biquad filters) the bank runs. More modes cost more DSP.',
    sset: 'Which spectral set the bank plays. If Bank A and B both use one, they must use the same set.',
    param: 'Filter design: RBJ with deflation 0–7 (higher deflation is more stable), or IIT, which is always stable.',
  };
  const BANKS = {};
  const bank = (key, value, name, group, slots, inputs, extra = {}) => { BANKS[key] = { key, value, name, group, slots, inputs, ...extra }; };
  const AB = ['A', 'B'], ABC = ['A', 'B', 'C'], BC = ['B', 'C'], CO = ['C'];
  const assign = n => ({ label: `Assign ${n}`, desc: 'Assignable column: pick its property in the module settings', kind: 'ctl', min: -1, max: 1, step: 0.01, assignable: true });
  bank('BiqBank', 0, 'BiqBank resonator', 'Resonators', AB, [A('In', 'Excitation input for all modes'), KHZ('Freq', 'Frequency of the first mode, kHz'), assign(3), assign(4), assign(5), assign(6), assign(7), assign(8)],
    { selectors: { stream: 'biqsin', firstCol: 2, base: 18, names: BIQSIN_SEL, props: BIQSIN_PROPS, defaults: BIQSIN_DEFAULTS }, modes: { size: [...BQ_SIZES, 'Variable 8–96 modes'], cm1: ['Amp spread in dB per partial', 'Amp spread in dB per octave'], cm2: ['Modes at full scale', 'Leave headroom'], param: DEFLATE }, modeNames: { cm1: 'Amp spread', cm2: 'Level', param: 'Filter type' },
      modeTips: { size: MODE_TIPS.size + ' Variable picks the count from the note: lower notes get more modes.' } });
  bank('BiqGraph', 1, 'BiqGraph resonator', 'Resonators', AB, [A('In', 'Excitation input for all modes'), KHZ('Freq', 'Frequency of the first mode, kHz'), C('sF spread', '1 = harmonic, >1 stretched, <1 compressed', -1, 2), C('B width', 'Bandwidth: 1 = 0 dB down, 0 = -100 dB down'), C('sB spread', 'Bandwidth spread: >0 higher modes wider', -2, 2), C('Graph 1', 'Scale for the 1 graph (amplitude or frequency offsets)'), C('Graph 2', 'Scale for the 2 graph (amplitude, bandwidth or decay time)'), UNUSED],
    { modeLabels: { 5: ['1A amp graph', '1F freq graph'], 6: ['2A amp graph', '2B width graph'] }, modeIds: { 5: 'cm2', 6: 'cm1' }, modes: { size: BQ_SIZES, param: DEFLATE }, modeNames: { param: 'Filter type' },
      modeTips: { size: MODE_TIPS.size + ' Graph bars past the last mode do nothing.' } });
  bank('BiqMouth', 2, 'BiqMouth formants', 'Resonators', AB, [A('In', 'Audio into the five formant filters'), C('Shape', 'Mouth shape 0 to 4.5, morphing between vowels', 0, 4.5), C('sF spread', 'Formant frequency multiplier, 1 = normal', 0, 3), C('oF offset', 'Formant frequency offset, 0 = normal', -1, 1), C('sB spread', 'Formant bandwidth multiplier, 1 = default', 0, 3), C('Centre', '0 = first formant, 0.625 = fifth formant', 0, 0.625), C('sA spread', 'Amplitude spread: >0 quieter away from centre', 0, 5), UNUSED], { modes: { param: DEFLATE }, modeNames: { param: 'Filter type' } });
  bank('SineBank', 3, 'SineBank additive', 'Additive', AB, [C('Phase', 'Phase offset for all partials; 0 for normal use', -1, 1), KHZ('Freq', 'Frequency of the fundamental partial, kHz'), assign(3), assign(4), assign(5), assign(6), assign(7), assign(8)],
    { selectors: { stream: 'biqsin', firstCol: 2, base: 18, names: BIQSIN_SEL, props: BIQSIN_PROPS, defaults: BIQSIN_DEFAULTS }, modes: { size: ['8 partials', '16 partials', '24 partials', '32 partials'] }, modeNames: { size: 'Partials' },
      modeTips: { size: 'How many sine partials the bank runs (the manual gives 8 to 32 in steps of 8).' } });
  bank('SineSpray', 4, 'SineSpray grains', 'Granular', ABC, [C('Amp', 'Amplitude of new grains; 0 = no grains'), KHZ('Freq', 'Grain trigger rate (fundamental), kHz'), C('H trunc', 'Harmonic truncation in kHz: small = long grains', 0, 10), C('Phase', 'Phase of a new grain, 0..0.9999'), UNUSED, UNUSED, UNUSED, KHZ('Sine freq', 'Frequency of the sine inside each grain, kHz')]);
  bank('WaveBank', 5, 'WaveBank', 'Oscillator banks', ABC, [C('Amp', 'Amplitude of the wave cluster; 0 = off'), KHZ('F1', 'Frequency of wave 1, kHz'), KHZ('F2', 'Frequency of wave 2 (blank = fewer waves)'), KHZ('F3', 'Frequency of wave 3'), KHZ('F4', 'Frequency of wave 4'), KHZ('F5', 'Frequency of wave 5'), C('Duty', 'Duty cycle; 0 = normal', -1, 1), C('Weight', 'Even/odd weighting, or duty offset', -1, 1)],
    { modeLabels: { 7: ['oD duty offset', 'W even/odd'] }, modeIds: { 7: 'cm1' }, modes: { param: ['Sawtooth', 'Square', 'Triangle', 'LeCaine square'] } });
  bank('HarMan', 6, 'HarMan resynthesis', 'Granular', ABC, [C('Amp', 'Amplitude of new grains; 0 = off'), KHZ('Freq', 'Grain trigger rate (fundamental), kHz'), C('H trunc', 'Harmonic truncation in kHz', 0, 10), UNUSED, UNUSED, UNUSED, C('Index', 'Index into the grain data', -2, 1), C('Dilation', 'Spectral dilation: 1 = unchanged', 0, 3)], { modes: { sset: SPECTRAL_SETS } });
  bank('ModMan', 7, 'ModMan resonator', 'Resonators', AB, [A('In', 'Excitation input for all modes'), KHZ('Freq', 'Frequency of the first mode, kHz'), C('sF / qF / sA', 'Frequency spread, curve, or amplitude spread', -1, 3), C('B width', 'Mode bandwidth: smaller = more resonance', 0, 2), C('sB / qB', 'Bandwidth spread', -2, 2), C('Centre', '0 = first mode, 1 = 8th mode', 0, 6), C('Interp', 'Spectrum interpolation index, 0..1'), C('Dilation', 'Spectral dilation: 1 = unchanged', 0, 3)],
    { modeLabels: { 2: ['sF spread', 'qF curve', 'sA amp spread'], 4: ['sB spread', 'qB curve'] }, modeIds: { 2: 'cm2', 4: 'cm1' }, modes: { sset: SPECTRAL_SETS, size: BQ_SIZES, param: DEFLATE }, modeNames: { param: 'Filter type' },
      modeTips: { size: MODE_TIPS.size + ' (ModMan is a biquad bank, so this should apply; the manual does not say so directly.)' } });
  bank('Kinetic', 9, 'Kinetic model', 'Physical models', AB, [A('Force', 'Force on the mass, -2..2; the output is the mass position'), C('Bow speed', 'Bow speed, -1..1', -1, 1), C('Stiction', 'Static friction 0..1'), KHZ('Freq', 'Frequency, kHz'), assign(5), assign(6), assign(7), assign(8)],
    { selectors: { stream: 'kinet', firstCol: 4, base: 13, names: KINET_SEL, props: KINET_PROPS, defaults: KINET_DEFAULTS } });
  bank('Additive', 10, 'Additive resynthesis', 'Additive', AB, [A('Mod', 'Modulation input (usually filtered noise)'), KHZ('Freq', 'Fundamental frequency, kHz'), C('Spread', 'Frequency spread: 0 = harmonic', -1, 1), C('Noise thresh', 'Noise modulation threshold, 0..1'), C('Col 5', 'Second index, deviation, partial count or noise threshold', -1, 1), C('sA spread', 'Amplitude spread from centre', 0, 5), C('Centre', 'Centre partial, 0..1'), C('Index', 'Analysis data index')],
    { modeLabels: { 2: ['sF spread', 'qF curve'], 4: ["I' 2nd index", 'dF deviation', 'pA partials', 'N noise thresh'] }, modeIds: { 2: 'cm1', 4: 'cm2' }, modes: { sset: ADDITIVE_SETS }, modeNames: { sset: 'Analysis set' },
      modeTips: { sset: 'Which group of additive analyses the Index column moves through.' } });
  bank('CVC', 8, 'CVC outputs', 'Control voltage', BC, Array.from({ length: 8 }, (_, i) => C(`CV ${i + 1}`, `Control voltage output ${i + 1} (volts)`, -10, 10, 0.01, 'V')), { osmoseUnsupported: true });
  bank('VoiceDelay', 0, 'Voice delay', 'Delays', CO, [A('In', 'Audio input'), C('Time', 'Delay time: 1 = maximum from the Delay menu'), C('Tap 1', 'Tap 1 time × Time'), C('Tap 2', 'Tap 2 time × Time'), C('Tap 3', 'Tap 3 time × Time'), C('Tap 4', 'Tap 4 time × Time'), C('Hold', '>0 stops recording (freeze)', -1, 1), UNUSED], { delay: true });
  bank('SummedDelay', 1, 'Summed delay', 'Delays', CO, [A('In', 'This voice’s input to the shared delay'), C('Time', 'Delay time: 1 = maximum'), C('Tap 1', 'Tap 1 time × Time'), C('Tap 2', 'Tap 2 time × Time'), C('Tap 3', 'Tap 3 time × Time'), C('Tap 4', 'Tap 4 time × Time'), C('Hold', '>0 stops recording (freeze)', -1, 1), UNUSED], { delay: true });
  bank('MicroDelay', 2, 'Micro delay (4 lines)', 'Delays', CO, [A('In 1', 'Audio into delay line 1'), C('Time 1', 'Delay time 1'), A('In 2', 'Audio into delay line 2'), C('Time 2', 'Delay time 2'), A('In 3', 'Audio into delay line 3'), C('Time 3', 'Delay time 3'), A('In 4', 'Audio into delay line 4'), C('Time 4', 'Delay time 4')], { delay: true });
  bank('FormulaDelay', 3, 'Formula delay', 'Delays', CO, [A('In 1', 'Buffer 1 input (read back in a formula’s W)'), C('Time 1', 'Buffer 1 delay time'), A('In 2', 'Buffer 2 input'), C('Time 2', 'Buffer 2 delay time'), A('In 3', 'Buffer 3 input'), C('Time 3', 'Buffers 3 & 4 delay time'), A('In 4', 'Buffer 4 input'), C('Hold', '>0 stops recording', -1, 1)], { delay: true });

  /** Bank C wire values: delays use 0..3, the B-aliases keep their B value. */
  function bankFromWire(slot, v) {
    if (v === undefined) v = 0;
    if (slot === 'C') {
      const d = Object.values(BANKS).find(b => b.delay && b.value === v);
      if (d) return d;
    }
    return Object.values(BANKS).find(b => !b.delay && b.value === v && b.slots.includes(slot)) || null;
  }

  // -------- Shape generator, sources, master
  const SG_INPUTS = [C('Rate (Hz)', 'Frequency in Hz (or phase input in "phase from row" mode)', 0, 10, 0.01, 'Hz'), { ...C('Trigger', 'Above 0 starts/retriggers; follow the gate (W) for one cycle per note', -1, 1), follow: FOLLOW_W }];

  /** Master inputs depend on firmware: assignable columns arrived in 10.60. */
  const MAST_ASSIGN = ['Recirc 1', 'Recirc 2', 'Recirc 3', 'Recirc 4', 'Recirc 5', 'Recirc 6', 'Recirc mix', 'Pre level', 'Comp threshold/drive', 'Comp attack/cutoff', 'Comp ratio/makeup', 'Comp mix', 'Post level', 'EQ tilt', 'EQ freq', 'EQ mix', 'Conv 1 index', 'Conv 1 mix', 'Conv 2 index', 'Conv 2 mix'];
  function masterInputs(S) {
    const mid = [];
    if (S.firmware != null && S.firmware < 1060) {
      [['Conv 1 index', 'Convolution 1 impulse index'], ['Conv 1 mix', 'Convolution 1 mix'], ['Recirc A', 'Recirculator column (function set in the Master section)'],
        ['Recirc B', 'Recirculator column (function set in the Master section)'], ['Conv 2 index', 'Convolution 2 impulse index'], ['Conv 2 mix', 'Convolution 2 mix']]
        .forEach(([l, d]) => mid.push(C(l, d, -1, 1)));
    } else {
      for (let i = 0; i < 6; i++) {
        const v = S.setup[27 + i];
        mid.push(C(v !== undefined ? MAST_ASSIGN[v] || `Assign ${i + 1}` : `Assign ${i + 1}`, 'Adds to the Master parameter this column is assigned to', -1, 1));
      }
    }
    return [A('L in', 'Left input to the Master section'), A('R in', 'Right input to the Master section'), ...mid,
      C('Master/Dry', 'Mix between Master-processed and dry output', 0, 1), A('Dry L', 'Left output that bypasses the Master section'), A('Dry R', 'Right output that bypasses the Master section')];
  }

  /** Every node that can exist, keyed by id, with the hardware it occupies. */
  function slotDefs() {
    const d = {};
    d.master = { id: 'master', kind: 'master', title: 'Master', cols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], rows: [], fixed: true };
    d.controls = { id: 'controls', kind: 'controls', title: 'Control sources', cols: [], rows: [13, 16, 14, 15] };
    d.noise = { id: 'noise', kind: 'source', title: 'Noise', cols: [], rows: [0] };
    d.audio = { id: 'audio', kind: 'source', title: 'Audio in', cols: [], rows: [9, 10] };
    d.sub = { id: 'sub', kind: 'source', title: 'Submix return', cols: [], rows: [11, 12] };
    for (let k = 0; k < 5; k++) d['osc' + (k + 1)] = { id: 'osc' + (k + 1), kind: 'osc', slot: k + 1, typeId: 72 + k, optId: 77 + k, exId: 82 + k, cols: [12 + 3 * k, 13 + 3 * k, 14 + 3 * k], rows: [1 + k] };
    ['A', 'B', 'C'].forEach((b, i) => d['bank' + b] = { id: 'bank' + b, kind: 'bank', slot: b, typeId: 91 + i, cols: Array.from({ length: 8 }, (_, j) => 27 + 8 * i + j), rows: [6 + i],
      cm1: b === 'A' ? 95 : 94, cm2: b === 'A' ? 97 : 96, param: b === 'A' ? 99 : 98, size: b === 'A' ? 70 : 71, sset: b === 'A' ? 64 : 65 });
    for (let k = 0; k < 5; k++) d['sg' + (k + 1)] = { id: 'sg' + (k + 1), kind: 'sg', slot: k + 1, typeId: 100 + k, cols: [51 + 2 * k, 52 + 2 * k], rows: [] };
    return d;
  }
  const SG_TYPES = ['Continuous cycle', 'Single cycle', 'Phase from row', 'Dual'];
  const ROW_LABELS = { 13: 'Control +', 16: 'Scale ×', 14: 'Control + (2)', 15: 'Control −', 0: 'out', 9: 'L', 10: 'R', 11: 'L', 12: 'R' };

  /** Resolve a placed node into a renderable description for the current state. */
  function describeNode(def, S) {
    const out = { ...def, inputs: [], outputs: [], title: def.title, subtitle: '' };
    if (def.kind === 'master') { out.inputs = masterInputs(S); out.subtitle = 'output'; }
    else if (def.kind === 'osc') {
      const t = OSC_FAMILY[S.setup[def.typeId] ?? 0] || OSC_FAMILY[0];
      out.type = t; out.title = t.name; out.subtitle = `Osc/Filter slot ${def.slot}`; out.inputs = t.inputs;
      out.outputs = [{ row: def.rows[0], label: 'out' }];
    } else if (def.kind === 'bank') {
      const b = bankFromWire(def.slot, S.setup[def.typeId]);
      out.type = b; out.title = b ? b.name : `Bank ${def.slot}`; out.subtitle = `Bank ${def.slot}`;
      out.inputs = (b ? b.inputs : Array.from({ length: 8 }, (_, i) => C(String(i + 1), ''))).map((inp, i) => resolveBankInput(b, def, i, inp, S));
      out.outputs = [{ row: def.rows[0], label: b && b.delay ? 'out' : 'out' }];
    } else if (def.kind === 'sg') {
      out.title = `Shape generator ${def.slot}`; out.subtitle = SG_TYPES[(S.setup[def.typeId] ?? 0) & 3]; out.inputs = SG_INPUTS;
    } else {
      out.subtitle = def.kind === 'controls' ? 'formulas and pitch/gate come from here' : '';
      out.outputs = def.rows.map(r => ({ row: r, label: ROW_LABELS[r] }));
    }
    out.inputs = out.inputs.map((inp, i) => ({ ...inp, col: def.cols[i] }));
    return out;
  }
  function resolveBankInput(b, def, i, inp, S) {
    if (!b) return inp;
    if (b.selectors && inp.assignable) {
      const arr = b.selectors.stream === 'kinet' ? S.kinet : S.biqsin;
      const off = def.slot === 'A' ? 0 : 24;
      const sel = arr && arr[off + b.selectors.base + (i - b.selectors.firstCol)];
      if (sel !== undefined) {
        // The column's dial is the property itself (same value as in the Properties list), in its own range.
        const prop = sel && b.selectors.props ? b.selectors.props.find(p => p.id === sel) : null;
        const out = { ...inp, label: b.selectors.names[sel] || `sel ${sel}`, selValue: sel, unknownSel: false, unassigned: !sel };
        if (prop) Object.assign(out, { prop, propStream: b.selectors.stream, propIndex: off + prop.id, min: prop.min, max: prop.max,
          step: prop.note || prop.offset !== undefined ? 1 : (prop.max - prop.min) / 100, desc: (prop.sym ? prop.sym + ': ' : '') + prop.desc });
        return out;
      }
      return { ...inp, unknownSel: true };
    }
    if (b.modeLabels && b.modeLabels[i]) {
      const id = def[b.modeIds[i]];
      const v = S.setup[id] ?? 0;
      return { ...inp, label: b.modeLabels[i][v] || inp.label };
    }
    return inp;
  }

  const OSC_CASCADE = ['Single filter', 'Cascade 2', 'Cascade 3', 'Cascade 4'];
  /** Settings selects for a bank in a slot: [{label, id, options}] (setup ids). */
  function bankModeControls(b, def) {
    if (!b) return [];
    const out = [];
    const names = { cm1: 'Mode 1', cm2: 'Mode 2', size: 'Modes', sset: 'Spectral set', param: b.key === 'WaveBank' ? 'Wave shape' : 'Deflate', ...(b.modeNames || {}) };
    const tip = k => (b.modeTips && b.modeTips[k]) || (b.key !== 'WaveBank' && MODE_TIPS[k]) || '';
    // Bank-wide settings (mode count, spectral set) first, then the column modes.
    const early = ['size', 'sset'];
    if (b.modes) for (const k of early) if (b.modes[k]) out.push({ label: names[k], id: def[k], options: b.modes[k], title: tip(k) });
    if (b.modeLabels) for (const [i, labels] of Object.entries(b.modeLabels)) out.push({ label: `Column ${+i + 1}`, id: def[b.modeIds[i]], options: labels, title: 'What this column controls' });
    if (b.modes) for (const [k, opts] of Object.entries(b.modes)) if (!early.includes(k)) out.push({ label: names[k], id: def[k], options: opts, title: tip(k) });
    return out;
  }
  const osmoseLike = (S, portName) => S.hardware === 6 || (S.hardware == null && /osmose/i.test(portName || ''));

  // -------- palette
  function paletteItems() {
    const items = [];
    // Filters are one module whose filter type is a setting; oscillators and processors stay separate.
    Object.values(OSC_FAMILY).filter(t => t.group !== 'Filters').forEach(t => items.push({ key: 'osc:' + t.value, name: t.name, group: t.group, kind: 'osc', type: t, desc: t.desc }));
    items.push({ key: 'osc:filter', name: 'Filter', group: 'Filters', kind: 'osc', type: OSC_FAMILY[5], desc: 'Low pass, high pass, band pass, band reject, all pass, shelves, 1-pole and ladder. Pick the type in the module.' });
    Object.values(BANKS).forEach(b => items.push({ key: 'bank:' + b.key, name: b.name, group: b.group, kind: 'bank', type: b }));
    const G = root.EMMods ? root.EMMods.GESTURES : {};
    for (const [g, d] of Object.entries(G)) items.push({ key: 'mod:' + g, name: d.name, group: 'Modulation', kind: 'gesture', g, desc: d.desc, sg: !!d.sg });
    for (let i = 0; i < 6; i++) items.push({ key: 'macro:' + i, name: 'Macro ' + EM.macroName(i), group: 'Macros', kind: 'macro', index: i, desc: `One of the Osmose’s six macro controls (${EM.macroName(i)}). Turn it here, or cable it to an input to let it move that input.` });
    items.push({ key: 'macro:extra', name: 'Extra macro (m7–m90)', group: 'Macros', kind: 'macro', index: null, desc: 'Macros m7 to m90 exist on newer firmware only. They have no knob on the Osmose, but formulas can use them.' });
    items.push({ key: 'sg', name: 'Shape generator', group: 'Modulation', kind: 'sg', desc: 'A raw shape generator, for use in your own formulas. The Envelope and LFO modules bring their own.' });
    items.push({ key: 'noise', name: 'Noise', group: 'Sources', kind: 'single', id: 'noise' });
    items.push({ key: 'audio', name: 'Audio in', group: 'Sources', kind: 'single', id: 'audio' });
    items.push({ key: 'sub', name: 'Submix return', group: 'Sources', kind: 'single', id: 'sub' });
    return items;
  }
  const GROUP_ORDER = ['Oscillators', 'Filters', 'Processors', 'Resonators', 'Additive', 'Oscillator banks', 'Granular', 'Physical models', 'Delays', 'Modulation', 'Macros', 'Sources', 'Control voltage'];

  /** Where would this palette item go? Returns {slotId, wire} or {error}. */
  /** The slot a Jenny in `slot` takes its phase from: the nearest placed slot to its left that is
   *  not another Jenny, if that is a DSF / Integrated DSF / Phase oscillator. null if none. */
  function jennySource(S, slot, placed) {
    for (let j = slot - 1; j >= 1; j--) {
      if (!placed.has('osc' + j)) continue;
      const t = S.setup[72 + j - 1] ?? 0;
      if (t === 2) continue;
      return MASTER_OSC_TYPES.has(t) ? j : null;
    }
    return null;
  }
  function findSlot(item, placed, S) {
    if (item.kind === 'single') return placed.has(item.id) ? { error: 'Already in the patch', short: 'already added' } : { slotId: item.id };
    if (item.kind === 'sg') {
      for (let k = 1; k <= 5; k++) if (!placed.has('sg' + k)) return { slotId: 'sg' + k };
      return { error: 'All 5 shape generators are in use', short: 'all 5 in use' };
    }
    if (item.kind === 'osc') {
      for (let k = 1; k <= 5; k++) {
        if (placed.has('osc' + k)) continue;
        if (item.type.needsMasterLeft && jennySource(S, k, placed) === null) continue;
        return { slotId: 'osc' + k, wire: item.type.value };
      }
      return item.type.needsMasterLeft
        ? { error: 'A Jenny needs a free slot to the right of a DSF, Integrated DSF or Phase oscillator', short: 'needs an oscillator to its left' }
        : { error: 'All 5 Osc/Filter slots are in use', short: 'all 5 slots in use' };
    }
    if (item.kind === 'bank') {
      for (const s of item.type.slots) if (!placed.has('bank' + s)) return { slotId: 'bank' + s, wire: item.type.value };
      const names = item.type.slots.join(' or ');
      return { error: `Needs Bank ${names}, which ${item.type.slots.length > 1 ? 'are' : 'is'} in use`, short: `Bank ${names} in use` };
    }
    return { error: 'Unknown module' };
  }

  // -------- dials: a column's constant value, kept in the Direct rows
  const DIAL_ROWS = [13, 14, 15];        // Direct +, Direct + (2), Direct −
  const isConstCode = c => (c >= 50 && c <= 58) || c === 49;
  function cellConst(cell) {
    const c = cell.code & 63;
    if (c === 49) return cell.dec / 10000;
    if (c >= 50 && c <= 58) return c - 49;
    return null;
  }
  /** Sum of the constant contributions into a column (muted cells excluded). */
  function dialValue(S, col) {
    let v = 0, any = false;
    for (const r of DIAL_ROWS) {
      const cell = S.cells.get(EM.key(r, col));
      if (!cell || (cell.code & 64)) continue;
      const k = cellConst(cell); if (k === null) continue;
      v += r === 15 ? -k : k; any = true;
    }
    return any ? Math.round(v * 10000) / 10000 : 0;
  }
  const intCell = n => ({ code: 49 + n, dec: 0 });
  const decCell = d => ({ code: 49, dec: d });
  /** Value -> cells on the free dial rows. `free` lists the rows (of 13, 14, 15) that hold nothing or a constant.
   *  Positive parts go on 14 (or 13), negative parts on 15. Range ±9, 0.0001 steps.
   *  Returns {cells: {row: cell|null}, exact} where exact is false if the free rows cannot hold the value. */
  function encodeDial(v, free = [14, 15, 13]) {
    v = Math.max(-9, Math.min(9, Math.round(v * 10000) / 10000));
    const cells = {}; free.forEach(r => cells[r] = null);
    const pos = [14, 13].filter(r => free.includes(r)), neg = free.includes(15) ? 15 : null;
    if (v === 0) return { cells, exact: true };
    const a = Math.abs(v), n = Math.floor(a + 1e-9), f = Math.round((a - n) * 10000);
    // same-sign rows and opposite-sign rows for this value
    const same = v > 0 ? pos : (neg ? [neg] : []), opp = v > 0 ? (neg ? [neg] : []) : pos;
    if (!same.length) return { cells, exact: false };
    if (n === 0) cells[same[0]] = decCell(f);
    else if (f === 0) cells[same[0]] = intCell(n);
    else if (opp.length) { cells[same[0]] = intCell(n + 1); cells[opp[0]] = decCell(10000 - f); }
    else if (same.length > 1) { cells[same[0]] = intCell(n); cells[same[1]] = decCell(f); }
    else { cells[same[0]] = intCell(Math.round(a)); return { cells, exact: false }; }
    return { cells, exact: true };
  }
  /** Cells to write so the column's constant becomes v. Returns [[row, cell|null], ...] for changed cells only. */
  function dialWrites(S, col, v) {
    const free = [14, 15, 13].filter(r => { const c = S.cells.get(EM.key(r, col)); return !c || isConstCode(c.code & 63); });
    const { cells } = encodeDial(v, free);
    // Prefer keeping row 13 for cables (X, W, formulas): only use it when 14 is taken.
    if (free.includes(14) && cells[13] === undefined) cells[13] = null;
    const writes = [];
    for (const r of free) {
      const cur = S.cells.get(EM.key(r, col)), w = cells[r] || null;
      const same = (!cur && !w) || (cur && w && (cur.code & 63) === w.code && (cur.dec || 0) === (w.dec || 0) && !(cur.code & 64));
      if (!same) writes.push([r, w]);
    }
    return writes;
  }
  /** Does the column have room for a dial value? (at least one dial row holds nothing or a constant) */
  const dialAvailable = (S, col) => DIAL_ROWS.some(r => { const c = S.cells.get(EM.key(r, col)); return !c || isConstCode(c.code & 63); });
  /** The performance cable an input follows (row 13 holding X or W), if present. */
  function followOn(S, col, follow) {
    if (!follow) return false;
    const c = S.cells.get(EM.key(13, col));
    return !!c && (c.code & 63) === follow.code;
  }
  const isDialCell = (row, cell) => DIAL_ROWS.includes(row) && isConstCode(cell.code & 63);

  root.EMModules = {
    OSC_FAMILY, BANKS, BIQSIN_SEL, KINET_SEL, SG_TYPES, MAST_ASSIGN, GROUP_ORDER,
    slotDefs, describeNode, paletteItems, findSlot, bankFromWire,
    dialValue, encodeDial, dialWrites, dialAvailable, followOn, isDialCell, DIAL_ROWS, FOLLOW_X, FOLLOW_W, MASTER_OSC_TYPES,
    bankModeControls, OSC_CASCADE, osmoseLike, jennySource, propToValue, propFromValue,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.EMModules;
})(typeof globalThis !== 'undefined' ? globalThis : this);
