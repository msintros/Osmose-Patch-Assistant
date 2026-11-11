# Osmose Patcher (prototype)

A modular-style patching view for the EaganMatrix in the Expressive E Osmose. Modules are
boxes, matrix connections are cables, and every edit is sent to the Osmose as you make it,
so the current sound changes in real time.

## Download

https://github.com/msintros/Osmose-Patch-Assistant/blob/main/dist/osmose-patcher.html


## Run it

1. Quit the Haken Editor if it is open.
2. Open `osmose-patcher.html` in **Chrome or Edge** (Safari has no Web MIDI). Allow MIDI
   access when the browser asks.
3. The In and Out menus should already show "Omsmose 61 haken," but if not, select this port for both.
4. Press **Connect**.
5. The app asks the Osmose for its current patch. If cables do not appear, press
   **Read patch**, or change presets on the Osmose and back.
6. Alternatively, just click **Open** and select a patch you have saved using this patcher and then **Send all to Osmose**.  

Without an Osmose you can still try the interface with **Demo patch**, or open a Haken
preset `.mid` file with **Open…**.

## Using it

- A new patch holds only the Master section (the Direct and Multiply rows work behind the scenes). Add modules from the
  strip on the left, or right-click an empty part of the canvas: the menu's categories open on
  hover (all banks are under Banks, and Filters lists every filter type) and the module lands
  where you clicked. The **Module list** button in the toolbar hides or shows the strip.
- **Save…** opens the system save dialog (Chrome, Edge) to name the patch and pick a folder; the
  file name becomes the patch's name. Other browsers download it instead. It follows the hardware: 5 Osc/Filter slots, Banks A, B and C (Bank C
  takes delays and a few bank types), 5 shape generators, and a Jenny oscillator needs an
  oscillator in a slot to its left. Items that will not fit are greyed out with the reason.
  When the Osmose sends a preset, the modules its connections use are placed automatically.
- Inputs are named for what they do in the module's current type and settings (for
  example a BiqBank's assignable columns show their assigned function).
- Control inputs have knobs. Drag up or down (Shift for fine steps), scroll, or
  double-click to type. A knob's value is written live as matrix constants on the Direct
  rows into that input, so it adds to any cables connected there. Pitch inputs and SG
  triggers have a "follow pitch / gate" option in the module panel.
- **Modulation** modules hide formulas behind musical settings: Pressure, Aftertouch, Key
  tracking, Shake, Tap / hit, Pluck envelope, Sustain envelope and LFO. Each one writes one
  formula (envelopes and the LFO also take a shape generator, counted against the 5). Cable its
  output to any input; every cable from it carries the same value.
- **Macros**: one module per macro (i to vi, plus m7 to m90 on newer firmware). Its knob moves
  the macro on the instrument. A cable from it adds "macro × amount" to an input; click the
  cable label to set the amount. Macros named in the preset text appear with their names.
- **Master**: its panel has levels, compressor / tanh and tilt EQ. The Global FX (recirculator) and Convolution
  buttons on the module open those windows.
- **BiqGraph**: Edit graphs… in its panel draws the mode amplitude and offset graphs.
- Hover over anything for a short explanation. Delete removes the selected cable or module.
- Drag from an output (right edge of a module) to an input (left edge) to connect them.
- Modulators (Pressure, envelopes, LFO, macros…) have an optional **In**. Leave it empty and
  the modulator's value goes to whatever you cable it to. Plug an audio signal into it and it
  becomes a VCA: out = In × modulator. Behind the scenes the In signal goes on the destination
  column's rows and the modulator on that column's × (Multiply) row, so one input can have one
  scaler, and everything else cabled into that input is scaled too.
- Key tracking into a Freq input makes it follow the played pitch exactly (X). New
  oscillators and banks start that way.
- A Freq input that follows pitch has **Octave** (−2 to +2: a ×0.25…×4 constant on its × row) and
  **Detune (Hz)** (±10 Hz, folded into the dial's constant) in its settings.
- **Gate** is a modulator that is simply W: on while a key is held.
- Drag a module by its title bar to move it anywhere; its place is remembered. A new module
  from the strip goes under the others of its kind. **Reset layout** puts every module back in
  its kind's column. Click anywhere on a module to select it. An Osc/Filter module's **Slot** setting moves
  it to another slot (swapping with what is there; cables and dials move along). A Jenny's
  **Phase from** setting picks the oscillator it follows and moves the modules so that
  oscillator is in the slot just before it. Not available on firmware 10.20 and older.
  Cables from the Direct rows get a new formula letter; audio cables start at 1.
- Click a cable's label to change its value, mute it or delete it (Delete key works too).
  Formula cables show the formula editor: W source and height, X / Y / Z ranges, curves,
  macros and the operator.
- Click a module's title for its settings: type, variants and modes, assignable columns,
  all controls as sliders, its cables, and Remove from patch. Banks also show their
  bank-wide settings: the number of modes (BiqBank, BiqGraph, ModMan; BiqBank also has
  Variable 8–96), partials (SineBank), spectral set (HarMan, ModMan; analysis set for
  Additive) and filter type (deflate 0–7 or IIT) for the biquad banks. On firmware 10.20
  and older these are shown but not sent.
- BiqBank, SineBank and Kinetic: **Assignable columns** lists each column's property dropdown
  with that property's slider beside it, then the other controls (Freq, follow pitch, octave,
  detune), then **Properties**, all of the bank's own values as in the Haken Editor. A property
  on a column has the same slider in both places (and the column's dial on the module, in the
  property's own range); either one changes the one value. Cables into the column add to it.
  Each property can be on one column at most. A new BiqBank or SineBank starts with columns
  3–7 = sF, B, sB, C, sA.
  Property ranges come from the Haken Editor 10.52 panels and are not yet checked on a device.
- **Send all to Osmose** pushes the whole patch on screen to the instrument.
- **Connect** makes the Osmose play the patch on screen (it sends it, like Send all, without
  asking; nothing is stored, so picking the preset again on the Osmose brings it back).
  **Read patch** brings the Osmose's current preset into the app instead.
- Editing is one-way: the app listens to the Osmose only while reading a preset (Connect or
  **Read patch**). Echoes of your edits, or a preset picked on the instrument, are ignored
  until you press Read patch.
- **Save…** keeps the patch as a `.json` file. To keep a sound on the Osmose, use the
  Osmose's own Save.

## Files

- `osmose-patcher.html`: the whole app in one file (built from `src/`).
- `src/protocol.js`: message tables, decoder and encoder; no browser code.
- `src/mods.js`: modulator recipes, macros, Master and convolution tables.
- `src/modules.js`: the module catalog (slots, limits, what each input does, dial encoding).
- `src/app.js`, `src/style.css`, `src/index.html`: the interface.
- `test/`: Node unit tests and Playwright browser tests (`node test/legacy.test.js`).
- `build.js`: `node build.js` writes `dist/osmose-patcher.html`.
