/**
 * Voice presets.
 *
 * Every preset answers one question: what does a single character sound like?
 * `synth` presets describe a two-segment envelope over one oscillator; `custom`
 * is the user's own voice — either a blip they shape themselves (`CUSTOM_DEFAULTS`
 * below) or an audio file they picked. Adding a preset is one entry here plus one
 * label in the panel.
 */

/** Character classes drive the preset's per-character shape. */
function characterClass(text) {
  if (/^\s$/.test(text)) return "space";
  if (/^[.,;:!?…]$/.test(text)) return "punct";
  if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/.test(text)) return "cjk";
  if (/^\d$/.test(text)) return "digit";
  return "letter";
}

const OCTAVE = 1.0594630943592953;

/**
 * The user's own voice, before they touch it.
 *
 * `source` decides which half of the custom panel applies: `synth` shapes a blip
 * from `wave`/`freq`/`duration`/`filter`, `sample` replays the audio file the user
 * loaded. Both live in settings, so a custom voice survives a reload.
 */
const CUSTOM_DEFAULTS = Object.freeze({
  source: "synth",
  wave: "square",
  freq: 620,
  duration: 0.05,
  filter: 3200,
  attack: 0.004
});

/** Waveforms the custom voice offers, in panel order. */
const CUSTOM_WAVES = Object.freeze([
  { id: "square", label: "方波" },
  { id: "triangle", label: "三角" },
  { id: "sawtooth", label: "锯齿" },
  { id: "sine", label: "正弦" }
]);

/** @type {Record<string, {label: string, hint: string, kind: string, wave?: OscillatorType, freq?: number, duration?: number, filter?: number, attack?: number, offsets?: Record<string, number>}>} */
const PRESETS = {
  soft: {
    label: "柔和",
    hint: "三角波，适合长时间阅读",
    kind: "synth",
    wave: "triangle",
    freq: 700,
    duration: 0.062,
    filter: 2600,
    attack: 0.006,
    offsets: { letter: 0, digit: 5, punct: -5, cjk: 0 }
  },
  click: {
    label: "打字机",
    hint: "短促机械敲击",
    kind: "synth",
    wave: "sawtooth",
    freq: 900,
    duration: 0.022,
    filter: 1500,
    attack: 0.001,
    offsets: { letter: 0, digit: 6, punct: -8, cjk: 2 }
  },
  custom: {
    label: "自定义",
    hint: "自己调波形，或载入自己的音频文件",
    kind: "custom"
  }
};

/** Panel order; the first entry is what a fresh install starts on. */
const PRESET_ORDER = ["soft", "click", "custom"];

/**
 * Semitone offset of one character under a preset.
 *
 * Only the built-in synth presets shift by character class; a custom voice is the
 * user's own shape, so nothing moves it behind their back.
 *
 * @param {string} preset
 * @param {string} text
 * @returns {number} semitone offset
 */
function presetOffset(preset, text) {
  const spec = PRESETS[preset] ?? PRESETS.soft;
  if (spec.kind !== "synth") return 0;
  const kind = characterClass(text);
  if (kind === "space") return 0;
  const table = spec.offsets ?? {};
  return table[kind] ?? 0;
}

/** Convert a semitone offset around `base` into hertz. */
function shift(base, semitones) {
  return base * Math.pow(OCTAVE, semitones);
}

module.exports = {
  PRESETS,
  PRESET_ORDER,
  CUSTOM_DEFAULTS,
  CUSTOM_WAVES,
  characterClass,
  presetOffset,
  shift
};
