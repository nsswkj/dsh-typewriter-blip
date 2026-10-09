/**
 * The sound engine.
 *
 * Owns one Web Audio graph: synthesized voices and the optional user sample both
 * land on a single master gain, so volume stays one place and tests can drive the
 * whole thing with a fake audio context.
 *
 * The preset table itself lives in `voices` (injected as this module's dependency
 * by `build.mjs`), because the panel and the engine must agree on what a voice is.
 */

/**
 * Voices tracked at once.
 *
 * A blip is tracked from the moment it is *scheduled* until the browser reports it
 * ended, so a background page — which hands the audio clock a whole second of blips in
 * one go — holds far more tracked voices than are ringing at any instant. The budget is
 * therefore about bookkeeping, not about how many can sound: what it guards against is
 * a page that never reports `ended`, and {@link BlipAudio#reap} is what enforces it.
 */
const MAX_VOICES = 16;

// Exponential ramps cannot reach zero, and an unfinished ramp can pop.
const SILENCE = 1e-4;
const MIN_GAIN = 1e-3;

/** A user sample is a blip, not a track: play at most this much of it. */
const MAX_SAMPLE_SECONDS = 0.6;
/** Fade applied by {@link BlipAudio#cut} so a hard stop never clicks. */
const CUT_FADE = 0.015;

/** Turn a `data:` URL into an ArrayBuffer without a network request. */
function dataUrlToArrayBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return new ArrayBuffer(0);
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (!meta.includes(";base64")) return new TextEncoder().encode(decodeURIComponent(body)).buffer;
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * What one character sounds like under the current settings.
 *
 * The custom voice is resolved here rather than in the preset table, because
 * whether it is a synth or the user's file is a setting, not a preset.
 *
 * @param {object} settings
 * @returns {object} a synth spec (`kind: "synth"`) or `{kind: "sample"}`
 */
function specFor(settings) {
  if (settings.preset === "custom") {
    const custom = settings.custom ?? {};
    if (custom.source === "sample") return { kind: "sample" };
    return {
      kind: "synth",
      wave: custom.wave,
      freq: custom.freq,
      duration: custom.duration,
      filter: custom.filter,
      attack: custom.attack,
      offsets: {}
    };
  }
  return voices.PRESETS[settings.preset] ?? voices.PRESETS.soft;
}

/**
 * How fast a sample is squeezed, clamped the same way wherever it is asked for —
 * playing it and saying how long it lasts must not disagree.
 *
 * @param {object} settings
 * @returns {number} playback rate
 */
function sampleRate(settings) {
  return Math.max(0.25, Math.min(4, settings.rate * voices.shift(1, settings.pitch)));
}

class BlipAudio {
  /**
   * @param {object} options
   * @param {() => AudioContext} options.createContext
   * @param {() => object} options.getSettings
   * @param {{warn: (...args: unknown[]) => void}} [options.logger]
   */
  constructor(options) {
    this.createContext = options.createContext;
    this.getSettings = options.getSettings;
    this.logger = options.logger ?? console;
    this.context = null;
    this.master = null;
    this.noise = null;
    /** @type {Set<AudioScheduledSourceNode>} */
    this.voices = new Set();
    /**
     * When each tracked voice is scheduled to end, on the audio clock.
     *
     * `onended` is the normal way a voice leaves {@link BlipAudio#voices}, but a page
     * that never reports it must not be able to grow the set forever — and the only
     * safe moment to forget a voice is after the time it was told to stop.
     *
     * @type {Map<AudioScheduledSourceNode, number>}
     */
    this.ends = new Map();
    /** @type {AudioBuffer | null} */
    this.sampleBuffer = null;
    this.sampleDataUrl = "";
    this.sampleLoading = null;
    this.played = 0;
    this.created = 0;
    /** How many times {@link BlipAudio#cut} actually silenced something. */
    this.cuts = 0;
    this.lastError = "";
  }

  /** Lazily build the graph; a page that never plays a blip never opens audio. */
  ensure() {
    if (this.context !== null) return this.context;
    this.created += 1;
    const context = this.createContext();
    const master = context.createGain();
    const { volume } = this.getSettings();
    master.gain.value = Math.max(MIN_GAIN, volume);
    master.connect(context.destination);
    this.context = context;
    this.master = master;
    return context;
  }

  /** Apply volume changes without rebuilding the graph. */
  applySettings() {
    if (this.context === null || this.master === null) return;
    const { volume } = this.getSettings();
    const now = this.context.currentTime;
    const gain = this.master.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(MIN_GAIN, gain.value), now);
    gain.linearRampToValueAtTime(Math.max(MIN_GAIN, volume), now + 0.05);
  }

  /** Samples may only start after a user gesture in most browsers. */
  resume() {
    const context = this.context;
    if (context === null) return Promise.resolve(false);
    if (context.state !== "suspended") return Promise.resolve(true);
    return Promise.resolve(context.resume()).then(
      () => true,
      (error) => {
        this.lastError = String(error);
        return false;
      }
    );
  }

  /**
   * Silence everything, right now.
   *
   * Voices are scheduled ahead of the audio clock and a user sample may last up to
   * {@link MAX_SAMPLE_SECONDS}, so dropping the queue alone would still leave the
   * plugin talking after the answer ended. This ramps the master down, stops every
   * scheduled voice, then ramps back up so the next blip is at full volume again.
   *
   * @param {number} [fade] ramp length in seconds
   * @returns {boolean} whether anything was cut
   */
  cut(fade = CUT_FADE) {
    if (this.context === null || this.master === null) return false;
    if (this.voices.size === 0) return false;
    const now = this.context.currentTime;
    const gain = this.master.gain;
    const target = Math.max(MIN_GAIN, this.getSettings().volume);
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(MIN_GAIN, gain.value), now);
    gain.linearRampToValueAtTime(MIN_GAIN, now + fade);
    for (const node of [...this.voices]) {
      this.voices.delete(node);
      try {
        node.onended = null;
        node.stop(now + fade * 2);
      } catch {
        /* already stopped */
      }
    }
    this.ends.clear();
    gain.setValueAtTime(MIN_GAIN, now + fade * 2);
    gain.linearRampToValueAtTime(target, now + fade * 2 + 0.03);
    this.cuts += 1;
    return true;
  }

  #track(node, stopAt) {
    this.voices.add(node);
    this.ends.set(node, stopAt);
    const release = () => {
      this.voices.delete(node);
      this.ends.delete(node);
    };
    node.onended = release;
    // Stopping the oldest voice here would cut the blip that is ringing right now: a
    // burst is scheduled in one synchronous pass, so every voice in it is tracked
    // before any of them has had the chance to end.
    if (this.voices.size > MAX_VOICES) this.#reap();
    return release;
  }

  /** Forget every voice the audio clock has already passed, `ended` or not. */
  #reap() {
    const now = this.context?.currentTime ?? 0;
    for (const node of [...this.voices]) {
      if ((this.ends.get(node) ?? 0) > now) continue;
      this.voices.delete(node);
      this.ends.delete(node);
      try {
        node.onended = null;
        node.stop(now);
      } catch {
        /* already stopped */
      }
    }
  }

  #noiseBuffer(context) {
    if (this.noise !== null) return this.noise;
    const frames = Math.ceil(context.sampleRate * 0.06);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) data[index] = Math.random() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }

  /**
   * Play one character.
   *
   * @param {string} text the character (or a short run of them) being revealed
   * @param {number} [at] absolute audio time; defaults to now
   * @returns {boolean} whether a voice was scheduled
   */
  play(text, at) {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    const spec = specFor(settings);
    let context;
    try {
      context = this.ensure();
    } catch (error) {
      // No Web Audio (or a blocked context): stay silent, never break the page.
      this.lastError = String(error);
      this.logger.warn("[typewriter-blip] could not open the audio graph:", error);
      return false;
    }
    const start = at ?? context.currentTime;
    try {
      if (spec.kind === "sample") {
        if (this.sampleBuffer === null) return false;
        return this.#playSample(context, start);
      }
      return this.#playSynth(context, start, spec, text, settings);
    } catch (error) {
      this.lastError = String(error);
      this.logger.warn("[typewriter-blip] could not play a blip:", error);
      return false;
    }
  }

  #playSynth(context, start, spec, text, settings) {
    const kind = voices.characterClass(text);
    const offsets = spec.offsets ?? {};
    const offset = (kind === "space" ? 0 : offsets[kind] ?? 0) + settings.pitch;
    const jitter = settings.jitter === 0 ? 0 : (Math.random() * 2 - 1) * settings.jitter;
    const frequency = Math.max(40, voices.shift(spec.freq ?? 520, offset + jitter));
    const duration = Math.max(0.012, (spec.duration ?? 0.05) * (1 - Math.min(0.45, Math.abs(offset + jitter) * 0.035)));
    const attack = Math.min(duration * 0.4, Math.max(0.001, spec.attack ?? 0.004));
    const peak = 0.5;
    const end = start + duration;

    const oscillator = context.createOscillator();
    oscillator.type = spec.wave ?? "square";
    oscillator.frequency.value = frequency;

    const gain = context.createGain();
    gain.gain.setValueAtTime(SILENCE, start);
    gain.gain.linearRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(SILENCE, end);

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.max(600, (spec.filter ?? 3600) + frequency);

    oscillator.connect(gain);
    gain.connect(filter);
    filter.connect(this.master);

    if (spec.wave === "sawtooth") {
      const noise = context.createBufferSource();
      noise.buffer = this.#noiseBuffer(context);
      noise.loop = false;
      const noiseGain = context.createGain();
      noiseGain.gain.setValueAtTime(0.16, start);
      noiseGain.gain.exponentialRampToValueAtTime(SILENCE, Math.min(end, start + 0.03));
      const noiseFilter = context.createBiquadFilter();
      noiseFilter.type = "highpass";
      noiseFilter.frequency.value = 1800;
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.master);
      this.#track(noise, end);
      noise.start(start);
      noise.stop(end);
    }

    this.#track(oscillator, end);
    oscillator.start(start);
    oscillator.stop(end);
    this.played += 1;
    return true;
  }

  #playSample(context, start) {
    const settings = this.getSettings();
    const source = context.createBufferSource();
    source.buffer = this.sampleBuffer;
    source.playbackRate.value = sampleRate(settings);
    const rate = source.playbackRate.value;
    const full = (this.sampleBuffer.duration || 0.06) / rate;
    // One character may not turn into a whole track: cap the slice and fade it out.
    const duration = Math.min(full, MAX_SAMPLE_SECONDS);
    const gain = context.createGain();
    gain.gain.setValueAtTime(SILENCE, start);
    gain.gain.linearRampToValueAtTime(1, start + Math.min(0.002, duration * 0.2));
    if (duration > 0.05) gain.gain.setValueAtTime(1, start + duration - 0.04);
    gain.gain.linearRampToValueAtTime(SILENCE, start + duration);
    source.connect(gain);
    gain.connect(this.master);
    const end = start + duration;
    this.#track(source, end);
    source.start(start);
    source.stop(end);
    this.played += 1;
    return true;
  }

  /**
   * The longest a single blip of the current voice can last, in seconds.
   *
   * 试听 uses this to keep its button locked until the last character has actually
   * finished sounding. Nothing here touches the audio graph or the settings store,
   * so it is safe to call at any time — including before any gesture.
   *
   * @returns {number} seconds; 0 when a sample voice has no sample loaded yet
   */
  blipSeconds() {
    const settings = this.getSettings();
    const spec = specFor(settings);
    if (spec.kind === "sample") {
      if (this.sampleBuffer === null) return 0;
      const full = (this.sampleBuffer.duration || 0.06) / sampleRate(settings);
      return Math.min(full, MAX_SAMPLE_SECONDS);
    }
    // #playSynth shortens a blip for offset characters, so spec.duration is a ceiling.
    return Math.max(0.012, spec.duration ?? 0.05);
  }

  /**
   * Decode the user's sample. Repeated calls for the same data URL reuse the cache.
   *
   * @param {string} dataUrl
   * @returns {Promise<boolean>}
   */
  loadSample(dataUrl) {
    if (dataUrl === "") {
      this.sampleBuffer = null;
      this.sampleDataUrl = "";
      this.sampleLoading = null;
      return Promise.resolve(false);
    }
    if (dataUrl === this.sampleDataUrl && this.sampleBuffer !== null) return Promise.resolve(true);
    if (this.sampleLoading !== null && this.sampleDataUrl === dataUrl) return this.sampleLoading;
    const context = this.ensure();
    this.sampleDataUrl = dataUrl;
    this.sampleBuffer = null;
    const decode = context.decodeAudioData(dataUrlToArrayBuffer(dataUrl));
    const task = Promise.resolve(decode).then(
      (buffer) => {
        if (this.sampleDataUrl !== dataUrl) return false;
        this.sampleBuffer = buffer;
        this.sampleLoading = null;
        return true;
      },
      (error) => {
        this.sampleLoading = null;
        this.lastError = String(error);
        this.logger.warn("[typewriter-blip] could not decode the custom sample:", error);
        return false;
      }
    );
    this.sampleLoading = task;
    return task;
  }

  dispose() {
    for (const node of [...this.voices]) {
      try {
        node.onended = null;
        node.stop();
      } catch {
        /* already gone */
      }
    }
    this.voices.clear();
    this.ends.clear();
    try {
      this.context?.close();
    } catch {
      /* already closed */
    }
    this.context = null;
    this.master = null;
    this.noise = null;
    this.sampleBuffer = null;
    this.sampleDataUrl = "";
    this.sampleLoading = null;
    this.cuts = 0;
  }
}

module.exports = {
  BlipAudio,
  specFor,
  PRESETS: voices.PRESETS,
  characterClass: voices.characterClass,
  presetOffset: voices.presetOffset,
  shift: voices.shift,
  MAX_SAMPLE_SECONDS
};
