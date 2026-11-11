# How live editing works, and what is still unverified on the Osmose

This is the research behind the prototype: how a front end edits the EaganMatrix inside an
Osmose over MIDI, what the sources are, and which parts still need a test on a real Osmose.

## Sources

1. **The Haken Editor 10.52 download.** Its launcher (`Haken Editor.maxpat`) is only the launcher window of the Osmose editor
   (it opens `HE/Data/components/_Haken_Editor_.maxpat` after a delay). It contains no MIDI
   logic, but the full download includes the editor itself (`HE/Data/components/*.maxpat`). Its
   matrix and formula code matches the modern layout below and sends only that layout. Its
   example presets span firmware 9.70 to 10.47: every file up to 10.20 uses the older
   layout, every file from 10.35 on uses the modern one.
2. **`HakenMidi.h`** by Lippold Haken, the header that the Haken Editor and third-party front
   ends share. A current copy is in the open-source pachde CHEM project
   (`github.com/Paul-Dempsey/pachde-CHEM`, `src/em/HakenMidi.h`). This is the main source.
3. **eagan_mcp** (`github.com/werebyte/eagan_mcp`, MIT). It edits an EaganMatrix Module
   (firmware 10.81) live from Python, and its notes record what was tested on hardware. It
   also decodes both generations of Haken preset `.mid` files, which is where the older
   message layout below comes from.
4. **pachde CHEM and HC-1** (VCV Rack plugins that work with the Osmose) for Osmose-specific
   behaviour: which port to use, preset selection, and timing.
5. **The EaganMatrix User Guide** (3/6/2025) for the matrix model and the Osmose chapter.

## The model the editor manipulates

The EaganMatrix is a 17-row by 61-column matrix. Rows are signal sources and columns are
destinations, and a matrix cell is a connection. That maps directly onto a modular patcher:
each row is a module output jack, each column is a module input jack, and a non-empty cell is
a cable.

| Rows (outputs) | Columns (inputs) |
|---|---|
| 0 Noise | 0, 1 Master L/R in; 2 to 7 six assignable Master columns; 8 Master/Dry mix; 9, 10 Dry L/R |
| 1 to 5 Osc/Filter 1 to 5 | 12 to 26: per Osc/Filter, In, F (frequency) and B (bandwidth) |
| 6 to 8 Bank A, B, C | 27 to 50: eight columns per bank (meaning depends on the bank type) |
| 9, 10 Audio in L/R; 11, 12 Submix L/R | 51 to 60: Shape Generator 1 to 5, F (rate) and T (trigger) |
| 13 Direct +, 14 Direct + (2), 15 Direct −, 16 Multiply | |

A cell's value is a formula letter (A to V, plus A′ to V′ on newer firmware), a built-in
(W gate, X pitch, Y, z²), a constant 1 to 9, a four-digit decimal, or row² / row³. A cell can
also be muted. A formula is shared: every cell that holds letter C uses the same formula C.

## Message format, modern firmware (10.3x and later)

Everything goes on MIDI **channel 16**.

| What | Messages |
|---|---|
| Editor present ping | cc116 (the Editor alternates 85 and 42, once a second); device answers cc118 |
| Ask for the current preset | cc109 = 16 (configToMidi) and cc45 = 124 (matRefresh) |
| Set a matrix cell | cc41 column, cc40 row, cc45 = 115 (select), optional cc43 / cc42 decimal digits, cc44 value |
| Mute / unmute a cell | cc41, cc40, then cc45 = 122 / 123 |
| Edit a formula | cc34 = formula number, then for each parameter: cc56 = 19 followed by poly pressure (note = parameter id, value = value) |
| Change a module type or setup value | cc56 = 20, then poly pressure (id, value). Osc/Filter types are ids 72 to 76, bank types 91 to 93, SG types 100 to 104 |
| Preset name and text | cc56 = 0 or 1, ASCII in poly-pressure byte pairs, cc56 = 127 ends |
| What the device sends at preset load | cc45 = 125 (clear), cc45 = 126 (start), then row / col / value triples, the setup stream, names |

Formula heights (W, and the X / Y / Z begin and end values) are 0.01 steps with a separate
"negative" flag id sent just before them. A negative value is encoded as an offset:
raw = (value + 1) × 100 with the flag set. That reading was confirmed by ear on a 10.81 Module.

## Message format, older firmware (likely what the Osmose speaks)

The User Guide says the Osmose still runs **DSP firmware 10.09**. The header marks the poke
streams above (cc56 = 19 / 20) as added in 10.32 and 10.33, so the Osmose probably does not
understand them. Older preset files show the layout that firmware uses instead, and because
loading a preset from a file means replaying it into the device, the device must accept it:

| What | Messages |
|---|---|
| Matrix cell | **channel 15**: cc103 column, cc102 row, optional cc116 / cc115 decimal digits, cc104 value |
| Matrix clear and bank clears | channel 15 cc110 = 125, 103, 104, 105 |
| Cell value codes | the same as modern for A to V; every code from W upward is 22 lower (no A′ to V′) |
| Formula | channel 15 cc34 = formula number, then the parameter as a plain channel-15 cc. Several parameters are packed into one 7-bit value (for example cc40 holds the W source, cc43 holds the X begin shelf and the X multiplier), and the seven negative flags are one bitmask in cc71 |
| Setup ids 64 to 99 (module types, banks) | channel 15 cc with the id as the cc number |
| Setup ids 35 to 63 | channel 16 cc with the id as the cc number |
| Preset name | channel 16 cc56 = 0, then one character per channel-pressure message |

The app detects which layout the device uses from the firmware version it reports
(channel 16 cc102 / cc103), or from the traffic itself (matrix data on channel 15 means the
older layout). A toolbar menu overrides this.

## Osmose-specific notes

- The Osmose shows two USB MIDI ports. The EaganMatrix editing port is **port 2**
  ("Osmose Port 2" on a Mac, "MIDIIN2 (Osmose)" / "MIDIOUT2 (Osmose)" on Windows). The app
  picks it automatically.
- pachde CHEM does not send the heartbeat ping to the Osmose. The app sends it by default
  (it is harmless on other devices); a checkbox turns it off.
- Changing presets on the Osmose sends the new preset to the editor, and the app rebuilds
  the patch view from it, the same way the Haken Editor follows the instrument.
- Edits change the Osmose's current sound only. Nothing is written to a preset slot; use
  Save on the Osmose to keep a sound, as the User Guide says for the 10.09 editor.
- Do not run the Haken Editor at the same time: both would answer the same messages.

## What is verified and what is not

| Part | Status |
|---|---|
| Matrix, formula and setup decoding in the modern layout | Tested against two real device captures (Bowed BiqBank, MicroDelay WaveGuide) |
| Modern write sequences | Match the sequences eagan_mcp verified on a 10.81 Module |
| Older layout, decoding | Tested on real 10.09 archives from the Haken Editor 10.52 download (Explorations folder): matrix, formulas and module types all decode, and re-encoding the formulas reproduces the archive bytes |
| Older layout, live edits sent one at a time | Same messages as the archives, but the device has only been shown them during a full preset load. **Needs an Osmose test** |
| Whether the Osmose answers configToMidi / matRefresh with its current preset | **Needs an Osmose test** |
| Bank column meanings per bank type | Named for every bank type from the User Guide; assignable columns read from the Kinetic / BiqBank property streams (11, 12), checked against the Bowed BiqBank capture |
| Older layout: module type changes | Only bank types (ch15 cc91 to 93) are known. Osc/Filter types, filter options and SG types use other numbers in 10.09 files that are not decoded yet, so the app does not send them on older firmware and marks the module |
| Older layout: assignable bank columns | Sent by replaying the whole stream 11 / 12, as preset files do. **Needs an Osmose test** |

## Master settings, macros, graphs, convolution

| What | Messages |
|---|---|
| Master levels, recirculator dials, EQ, compressor | Global cc, sent on channel 1 (the device reports them on ch1 live and on ch16 in preset data): Pre 26, Post 18, Audio in 19, R1 to R6 20 / 21 / 22 / 23 / 95 / 96, Recirc mix 24, EQ 83 to 85, compressor 90 to 93 |
| Recirculator type, on / off, compressor or tanh | Setup ids 62, 15, 16. On older firmware the type appears as ch16 cc62 (+64 = Extend) in 10.09 files; the app sends that, untested |
| Macros i to vi | ch1 cc86 (low 7 bits) then cc12 to cc17 (high 7 bits); 0x3F80 is full scale |
| Macros m7 to m90 | ch1 cc86 or cc97 then cc40 to 63 / cc102 to 119, centred at 0x2000; in preset data as streams 16 / 17 |
| BiqGraph graphs | Streams 2 (mode amplitudes), 3 and 4 (offset graphs), 48 values 0 to 96. Edits: pokes 21 to 23 (modern), whole stream resent (older firmware, untested) |
| Convolution | Stream 14 (30 values); edits as poke 26. The 10.09 layout is different and not decoded, so it is read-only there |

Modulator modules are built only from fields documented in the header and the User Guide
(W source and SG shape, heights, Z initial / derivative modes, persistence, interpolation, the
SG type setup id and the SG F / T columns). Their recipes follow the Osmose Preset Cookbook's
gesture pages. They are remembered in the app's own saved files; a preset read back from the
Osmose shows them as plain formula cables, except macro cables, which are recognised.

## How the knobs are stored

The EaganMatrix has no separate "parameter" for a module input: an input's value is the sum
of every matrix cell in its column. A knob therefore writes constants on the Direct rows into
that column: positive parts on Direct + (2), negative parts on Direct −, and Direct + only when
the others hold a cable. A cell holds 1 to 9 or a four-digit decimal, so 2.37 is written as
3 on Direct + (2) and .63 on Direct −. Range ±9 in 0.0001 steps. Cables from the Direct rows
(formulas, X, W) are left alone and add to the knob value.

## Architecture of the prototype

- A single HTML page using the browser's Web MIDI API (Chrome or Edge; Safari has no Web
  MIDI). No server and no install: open the file and connect.
- `protocol.js` holds all of the tables, a decoder that turns incoming MIDI into patch state
  (cells, formulas, setup, name) for both layouts, and an encoder that turns each edit into
  the right messages. It has no browser dependencies and is unit-tested in Node.
- `app.js` renders the patch as modules and cables in SVG, and turns each gesture into an
  encoder call that is sent immediately, so the Osmose updates while you drag.
- Every message in both directions is logged, and "Save capture" writes the log to a file.
  That capture is how the unverified parts above get settled.

## Seen on a real Osmose (10.52, 2026-11-10)

- Formula pokes (cc34 FormSel, then cc56 19 + sData pairs) take effect without selecting a cell first.
- Selecting a cell (cc41 col, cc40 row, cc45 115 with no value) makes the device stream that cell's whole
  formula back (~95 messages), so the app no longer selects before each formula edit.
- The device echoes edits; the app ignores incoming data except while reading a preset.
