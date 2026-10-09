/**
 * Persisted settings for the speech-blip plugin.
 *
 * Plain JSON in `localStorage`: the values only style a client-side toy, so the
 * profile's Config file stays untouched and the panel is the only surface a user
 * needs. Every read is hardened, because a stale or hand-edited value must never
 * stop the chat from rendering.
 */

const { CUSTOM_DEFAULTS, CUSTOM_WAVES } = voices;

const STORAGE_KEY = "dsh:typewriter-blip:v1";

/** Preset voice ids; `custom` is the user's own voice (see `CUSTOM_DEFAULTS`). */
const PRESET_IDS = ["soft", "click", "custom"];

const WAVE_IDS = CUSTOM_WAVES.map((wave) => wave.id);

const DEFAULTS = Object.freeze({
  enabled: true,
  /**
   * Voice. A stored id that is no longer offered — the removed `undertale` voice, a
   * hand-edited value — falls back to this one on the next read, so a retired voice
   * can never leave the panel with nothing selected.
   */
  preset: "soft",
  /** Playback rate for the user sample, 0.5x – 2x. */
  rate: 1,
  /** Semitone offset applied to every blip. */
  pitch: 0,
  volume: 0.32,
  /** Minimum spacing between two blips, milliseconds. */
  interval: 45,
  /** Random pitch jitter per blip, semitones. */
  jitter: 0.55,
  /** Skip the blips for spaces, tabs and newlines. */
  skipWhitespace: true,
  /**
   * Speak only the assistant's own answer text: tool rows, thinking and the
   * user's own lines stay silent, which is what keeps entering a conversation
   * quiet.
   */
  answerOnly: true,
  /**
   * Silence, in milliseconds, after which anything still queued is dropped and
   * any voice still ringing is cut. This is what makes the sound stop the moment
   * the model stops talking.
   */
  tail: 140,
  /** Custom sample: file name for display plus the raw bytes as a data URL. */
  sampleName: "",
  sampleDataUrl: "",
  /** The user's own blip: a shaped synth or their audio file. */
  custom: { ...CUSTOM_DEFAULTS }
});

const PRESETS = new Set(PRESET_IDS);

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function text(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

/** Every field of the custom voice is clamped on read, like the flat ones. */
function normalizeCustom(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  return {
    source: source.source === "sample" ? "sample" : "synth",
    wave: WAVE_IDS.includes(source.wave) ? source.wave : CUSTOM_DEFAULTS.wave,
    freq: clampNumber(source.freq, 120, 2000, CUSTOM_DEFAULTS.freq),
    duration: clampNumber(source.duration, 0.008, 0.3, CUSTOM_DEFAULTS.duration),
    filter: clampNumber(source.filter, 600, 12000, CUSTOM_DEFAULTS.filter),
    attack: clampNumber(source.attack, 0.0005, 0.05, CUSTOM_DEFAULTS.attack)
  };
}

/** @param {unknown} raw @returns {typeof DEFAULTS} */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  return {
    enabled: bool(source.enabled, DEFAULTS.enabled),
    preset: PRESETS.has(source.preset) ? source.preset : DEFAULTS.preset,
    rate: clampNumber(source.rate, 0.5, 2, DEFAULTS.rate),
    pitch: clampNumber(source.pitch, -12, 12, DEFAULTS.pitch),
    volume: clampNumber(source.volume, 0, 1, DEFAULTS.volume),
    interval: clampNumber(source.interval, 0, 400, DEFAULTS.interval),
    jitter: clampNumber(source.jitter, 0, 3, DEFAULTS.jitter),
    skipWhitespace: bool(source.skipWhitespace, DEFAULTS.skipWhitespace),
    answerOnly: bool(source.answerOnly, DEFAULTS.answerOnly),
    tail: clampNumber(source.tail, 0, 800, DEFAULTS.tail),
    sampleName: text(source.sampleName, DEFAULTS.sampleName),
    sampleDataUrl: text(source.sampleDataUrl, DEFAULTS.sampleDataUrl),
    custom: normalizeCustom(source.custom)
  };
}

/** Storage facade; a browser without `localStorage` still gets working defaults. */
class SettingsStore {
  /** @param {Storage | null | undefined} storage */
  constructor(storage) {
    this.storage = storage ?? null;
    this.listeners = new Set();
    this.value = this.#read();
  }

  #read() {
    try {
      const stored = this.storage?.getItem(STORAGE_KEY);
      return normalizeSettings(stored === null || stored === undefined ? {} : JSON.parse(stored));
    } catch {
      return normalizeSettings({});
    }
  }

  get() {
    return this.value;
  }

  /** @param {Partial<typeof DEFAULTS>} patch */
  set(patch) {
    const next = normalizeSettings({ ...this.value, ...patch });
    this.value = next;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode or a full quota: the in-memory value already changed */
    }
    for (const listener of [...this.listeners]) listener(next);
    return next;
  }

  reset() {
    return this.set({ ...DEFAULTS, sampleName: "", sampleDataUrl: "" });
  }

  /** @param {(value: typeof DEFAULTS) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

module.exports = {
  STORAGE_KEY,
  PRESET_IDS,
  WAVE_IDS,
  DEFAULTS,
  normalizeSettings,
  normalizeCustom,
  SettingsStore
};
