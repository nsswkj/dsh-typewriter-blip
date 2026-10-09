/**
 * Standalone harness for the typewriter-blip plugin.
 *
 * Exercises the SHIPPED artifact (`client.js`, plus `build.mjs --check` for drift)
 * against a hand-rolled fake DOM and fake Web Audio, so the code that reaches the
 * browser is the code under test.
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "C:\Program Files\DSH Desktop\DSH Desktop.exe" test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${String(expected)}, got ${String(actual)}`);
}

/** First vnode in a rendered tree whose props satisfy `predicate` (depth-first). */
function findVnode(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findVnode(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  const children = node.props === undefined ? null : node.props.children;
  return findVnode(children ?? null, predicate);
}

/* -------------------------------------------------- build drift (runs first) */

console.log("\nbuild.mjs");
const { assemble } = await import("./build.mjs");
const shipped = readFileSync(join(HERE, "client.js"), "utf8").replace(/\r\n/g, "\n");
const expected = assemble();
ok(shipped === expected, "client.js matches src/", `${shipped.length} bytes on disk, ${expected.length} assembled`);

/* ------------------------------------------------------------------- naming */

// The plugin answers to "说话音效" everywhere the user can read it; the package
// id, slot id and storage key stay put, because renaming those would need a
// reinstall and would throw away the user's saved settings.
console.log("\nnaming");
ok(shipped.includes("说话音效"), "the artifact carries the new name");
ok(!shipped.includes("打字音效"), "the artifact carries no trace of the old name");

/* ------------------------------------------------------------------ fake DOM */

class FakeNode {
  constructor() {
    this.nodeType = 0;
    this.parentElement = null;
    this.data = "";
    this.childNodes = [];
    this.tagName = "";
    this._attributes = new Map();
    this.style = {};
  }
  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }
  appendChild(child) {
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  get className() {
    return this._attributes.get("class") ?? "";
  }
  get textContent() {
    if (this._text !== undefined) return this._text;
    return this.childNodes.map((child) => (child.nodeType === 3 ? child.data : child.textContent ?? "")).join("");
  }
  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }
  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }
  hasAttribute(name) {
    return this._attributes.has(name);
  }
  getAttribute(name) {
    return this._attributes.get(name) ?? null;
  }
  /** The observer scans the transcript once at start to take its baseline. */
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (selector === "[data-chat-flow-kind]" && child.hasAttribute("data-chat-flow-kind")) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() {
    return { top: 500, bottom: 530, left: 100, right: 200, width: 100, height: 30 };
  }
  contains(node) {
    let current = node;
    while (current !== null && current !== undefined) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = data;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, attributes = {}) {
    super();
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }
}

const observers = new Set();
const recordQueues = new WeakMap();

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
  }
  observe(target) {
    this.target = target;
    observers.add(this);
  }
  disconnect() {
    this.target = null;
    observers.delete(this);
  }
}

function record(root, entry) {
  const queue = recordQueues.get(root) ?? [];
  queue.push(entry);
  recordQueues.set(root, queue);
}

function flushObservers() {
  // Every observing instance sees the same batch: a real MutationObserver delivers
  // each record to every observer registered on that node, not to whichever one
  // happens to read the queue first.
  const batches = new Map();
  for (const observer of [...observers]) {
    if (observer.target === null) continue;
    let batch = batches.get(observer.target);
    if (batch === undefined) {
      batch = recordQueues.get(observer.target) ?? [];
      batches.set(observer.target, batch);
      recordQueues.delete(observer.target);
    }
    if (batch.length === 0) continue;
    observer.callback(batch, observer);
  }
}

/** Append text the way the host does: mutate one text node, then flush. */
function typeInto(root, textNode, text) {
  textNode.data += text;
  record(root, { type: "characterData", target: textNode });
  flushObservers();
}

/* ---------------------------------------------------------------- fake audio */

class FakeParam {
  constructor(value) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push({ kind: "linear", value, time });
  }
  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push({ kind: "exponential", value, time });
  }
  cancelScheduledValues(time) {
    this.events.push({ kind: "cancel", time });
  }
}

class FakeContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 10;
    this.state = "running";
    this.destination = { id: "destination" };
    this.oscillators = [];
    this.buffers = 0;
    this.closed = false;
  }
  createGain() {
    return {
      gain: new FakeParam(1),
      connect() {}
    };
  }
  createOscillator() {
    const node = {
      type: "sine",
      frequency: new FakeParam(440),
      startedAt: null,
      stoppedAt: null,
      onended: null,
      connect() {},
      start(at) {
        this.startedAt = at;
      },
      stop(at) {
        this.stoppedAt = at;
      }
    };
    this.oscillators.push(node);
    return node;
  }
  createBiquadFilter() {
    return { type: "lowpass", frequency: new FakeParam(350), Q: new FakeParam(1), connect() {} };
  }
  createBufferSource() {
    return {
      buffer: null,
      playbackRate: new FakeParam(1),
      loop: false,
      onended: null,
      connect() {},
      start() {},
      stop() {}
    };
  }
  createBuffer(channels, frames) {
    this.buffers += 1;
    return { duration: frames / this.sampleRate, getChannelData: () => new Float32Array(frames) };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 0.08 });
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------- react stub */

const reactInternals = { states: [], effects: [] };
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
    children
  }),
  useState(initial) {
    const value = typeof initial === "function" ? initial() : initial;
    reactInternals.states.push(value);
    return [value, (next) => reactInternals.states.push(next)];
  },
  useEffect(factory) {
    reactInternals.effects.push(factory);
  },
  useRef(initial) {
    return { current: initial ?? null };
  },
  useCallback(callback) {
    return callback;
  }
};
/**
 * The loader's own `require`: the FIRST argument the real factory receives.
 *
 * There is deliberately no `globalThis.__DSH_TWB_REQUIRE__` stub. That global
 * does not exist in the page, and defining it here is exactly what hid the
 * boot-breaking `require("react")` bug — the artifact passed while the real
 * page threw inside an initial boot batch and blanked the whole UI.
 */
const loaderRequire = (specifier) => {
  if (specifier === "react") return React;
  throw new Error(`unexpected require(${specifier})`);
};

/* --------------------------------------------------------- load the artifact */

const bundle = readFileSync(join(HERE, "client.js"), "utf8");
const modulePrologue = `    /* Generated by build.mjs; see src/. Modules evaluate in dependency order. */`;
const moduleStart = bundle.indexOf(modulePrologue);
const loadMarker = `    return registry.load("client");`;
const loadIndex = bundle.indexOf(loadMarker);
/* The load sits inside a try/catch emitted by build.mjs, so the slice must stop
   BEFORE the `try` — a half-copied try block is a SyntaxError, not a failure. */
const moduleEnd = bundle.lastIndexOf("    try {", loadIndex);
ok(moduleStart > 0, "bundle carries the generated module registry");
ok(loadIndex > moduleStart, "bundle ends by loading the client module");
ok(moduleEnd > moduleStart, "the client load is wrapped in a guard");

const moduleSource = bundle.slice(moduleStart, moduleEnd);
const modules = { settings: null, voices: null, audio: null, observer: null, client: null };
const documentStub = {
  head: new FakeElement("head"),
  body: new FakeElement("body"),
  listeners: new Map(),
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  addEventListener(type, handler) {
    const list = documentStub.listeners.get(type) ?? [];
    list.push(handler);
    documentStub.listeners.set(type, list);
  },
  removeEventListener() {}
};
const contexts = [];
const storage = (() => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
})();

globalThis.document = documentStub;
globalThis.localStorage = storage;
globalThis.Element = FakeElement;
globalThis.MutationObserver = FakeMutationObserver;
globalThis.ResizeObserver = undefined;
globalThis.AudioContext = function AudioContextStub() {
  const context = new FakeContext();
  contexts.push(context);
  return context;
};
globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
// The wall clock the runtime's scheduler and its guard timer read. Mutable, because
// "the frames stopped for four seconds" is a state the harness has to be able to enter.
let clockMs = 0;
globalThis.performance = { now: () => clockMs };

let frames = [];
globalThis.requestAnimationFrame = (callback) => {
  frames.push(callback);
  return frames.length;
};
globalThis.cancelAnimationFrame = () => {};

/* ------------------------------------------- real loader contract (regression) */

/**
 * Run the WHOLE artifact the way the page does: `window.__ModuleLoader__.load`
 * captures `{ id, factory }`, and the plugin is whatever `factory(require)`
 * returns. This is the check whose absence let a broken loader contract ship:
 * the sliced harness below never calls the factory, so it could not notice that
 * the factory ignored the loader's `require` and threw on `require("react")`.
 */
let loadCall = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      if (loadCall !== null) throw new Error("bundle registered more than one module");
      loadCall = options;
    }
  }
};
ok(
  globalThis.__DSH_TWB_REQUIRE__ === undefined,
  "artifact is exercised without any __DSH_TWB_REQUIRE__ global"
);
vm.runInThisContext(bundle, { filename: join(HERE, "client.js") });
ok(loadCall !== null, "bundle registers itself through window.__ModuleLoader__.load");
eq(loadCall.id, "dsh-typewriter-blip", "module id is the package name");
eq(typeof loadCall.factory, "function", "bundle exposes a factory");
ok(loadCall.factory.length >= 1, "factory declares the loader's require parameter");
const contractPlugin = loadCall.factory(loaderRequire);
ok(contractPlugin !== null && typeof contractPlugin === "object", "factory returns the client plugin");
eq(typeof contractPlugin.apply, "function", "contract plugin exposes apply()");

const moduleFunction = vm.runInThisContext(
  `(function (modules, loaderRequire) {\n${moduleSource}\n    return { factories, registry };\n})`,
  { filename: join(HERE, "client.js") }
);
const { factories, registry } = moduleFunction(modules, loaderRequire);
for (const id of ["settings", "voices", "audio", "observer", "client"]) {
  modules[id] = registry.load(id);
}
ok(modules.settings !== null, "settings module loaded from the bundle");
ok(modules.voices !== null, "voices module loaded from the bundle");
ok(modules.audio !== null, "audio module loaded from the bundle");
ok(modules.observer !== null, "observer module loaded from the bundle");
ok(modules.client !== null, "client module loaded from the bundle");

const { SettingsStore, DEFAULTS, normalizeSettings, STORAGE_KEY } = modules.settings;
const voices = modules.voices;
const { BlipAudio, specFor } = modules.audio;
const { BlipDriver, ChatTextObserver, countFlowText, countFlowCharacters, collectCharacters, MAX_PENDING, MAX_QUEUE, MAX_LEAD, PLAYOUT_MS } = modules.observer;

/* ------------------------------------------------------------------ settings */

console.log("\nsettings");
eq(normalizeSettings(undefined).preset, "soft", "default preset is soft");
eq(normalizeSettings({ preset: "nope" }).preset, "soft", "unknown preset falls back");
// The retired Undertale voice: a stored profile still naming it must land on a voice the
// panel can actually show, not on an id with no chip behind it.
eq(normalizeSettings({ preset: "undertale" }).preset, "soft", "a retired voice falls back to the default");
eq(normalizeSettings({ volume: 99 }).volume, 1, "volume clamps high");
eq(normalizeSettings({ volume: -3 }).volume, 0, "volume clamps low");
eq(normalizeSettings({ pitch: 100 }).pitch, 12, "pitch clamps");
eq(normalizeSettings({ interval: "abc" }).interval, DEFAULTS.interval, "non-numeric interval falls back");
eq(normalizeSettings({ enabled: "yes" }).enabled, true, "non-boolean enabled falls back");
eq(normalizeSettings(null).skipWhitespace, true, "null input is tolerated");
eq(normalizeSettings({ preset: "click" }).preset, "click", "known preset survives");

// The custom voice is a nested object, so it carries its own clamps.
eq(normalizeSettings(undefined).custom.source, "synth", "the custom voice starts as a synth");
eq(normalizeSettings({ custom: { wave: "sine", freq: 900 } }).custom.wave, "sine", "a chosen waveform survives");
eq(normalizeSettings({ custom: { wave: "bogus" } }).custom.wave, "square", "an unknown waveform falls back");
eq(normalizeSettings({ custom: { freq: 99999 } }).custom.freq, 2000, "custom frequency clamps high");
eq(normalizeSettings({ custom: { duration: 5 } }).custom.duration, 0.3, "custom duration clamps");
eq(normalizeSettings({ custom: { source: "sample" } }).custom.source, "sample", "the file source survives");
eq(normalizeSettings({ custom: "nope" }).custom.source, "synth", "a corrupt custom block falls back");
eq(normalizeSettings({ tail: 5000 }).tail, 800, "the tail window clamps");
eq(normalizeSettings(undefined).answerOnly, true, "answers only, by default");
eq(normalizeSettings({ answerOnly: "no" }).answerOnly, true, "non-boolean answerOnly falls back");

const store = new SettingsStore(storage);
let notifications = 0;
const unsubscribe = store.subscribe(() => {
  notifications += 1;
});
store.set({ interval: 90 });
eq(store.get().interval, 90, "set() updates memory");
eq(notifications, 1, "set() notifies once");
eq(new SettingsStore(storage).get().interval, 90, "value round-trips through storage");
store.set({ custom: { wave: "sawtooth" } });
eq(new SettingsStore(storage).get().custom.wave, "sawtooth", "the custom voice round-trips through storage");
eq(new SettingsStore(storage).get().custom.freq, DEFAULTS.custom.freq, "the rest of the custom voice keeps its defaults");
const afterFirst = notifications;
store.reset();
eq(afterFirst + 1, notifications, "reset() notifies subscribers");
eq(store.get().interval, DEFAULTS.interval, "reset() restores defaults");
unsubscribe();
store.set({ interval: 70 });
eq(notifications, afterFirst + 1, "unsubscribe stops notifications");
storage.setItem(STORAGE_KEY, "{not json");
eq(new SettingsStore(storage).get().preset, "soft", "corrupt JSON falls back to defaults");
storage.removeItem(STORAGE_KEY);
const nullStorage = new SettingsStore(null);
nullStorage.set({ volume: 0.4 });
eq(nullStorage.get().volume, 0.4, "a browser without localStorage still works");

/* -------------------------------------------------------------------- voices */

console.log("\nvoices");
eq(voices.characterClass(" "), "space", "space class");
eq(voices.characterClass("\n"), "space", "newline class");
eq(voices.characterClass("a"), "letter", "letter class");
eq(voices.characterClass("中"), "cjk", "cjk class");
eq(voices.characterClass("7"), "digit", "digit class");
eq(voices.characterClass("!"), "punct", "punct class");
eq(Math.round(voices.shift(520, 12)), 1040, "shift +12 is one octave");
eq(voices.PRESET_ORDER.length, 3, "three presets offered");
// "删除 undertale 音色": the voice is gone from the table, from the panel order and from
// what settings will accept, so nothing can select it again.
ok(voices.PRESETS.undertale === undefined, "the Undertale voice left the preset table");
eq(modules.settings.PRESET_IDS.length, 3, "the settings module offers the same three voices");
ok(
  voices.PRESET_ORDER.every((id) => modules.settings.PRESET_IDS.includes(id)),
  "the panel order and the accepted ids agree"
);
eq(DEFAULTS.preset, voices.PRESET_ORDER[0], "a fresh install starts on the first voice offered");
ok(voices.PRESET_ORDER.every((id) => voices.PRESETS[id] !== undefined), "every preset id resolves");
eq(voices.CUSTOM_WAVES.length, 4, "four waveforms offered for the custom voice");
eq(voices.PRESETS.custom.kind, "custom", "the custom preset is the user's own voice, not a fixed shape");
eq(voices.presetOffset("custom", "a"), 0, "the custom voice is never shifted behind the user's back");
eq(voices.presetOffset("soft", "7"), 5, "a built-in preset still shifts by character class");
ok(
  voices.CUSTOM_DEFAULTS.source === "synth" && voices.CUSTOM_DEFAULTS.wave === "square",
  "the custom voice starts as a square-wave synth"
);

/* --------------------------------------------------------------------- audio */

console.log("\naudio");
let audioSettings = { ...DEFAULTS };
const context = new FakeContext();
const audio = new BlipAudio({
  createContext: () => context,
  getSettings: () => audioSettings,
  logger: { warn: () => {} }
});
eq(audio.context, null, "no AudioContext before the first blip");
eq(audio.play("a"), true, "first blip schedules a voice");
eq(audio.context, context, "blip opens the audio graph lazily");
eq(audio.played, 1, "play() counts");
eq(context.oscillators.length, 1, "one oscillator per blip");
const first = context.oscillators[0];
eq(first.type, "triangle", "the default voice uses a triangle wave");
ok(Math.abs(first.frequency.value - 700) <= 700 * 0.06, "frequency sits near 700 Hz", String(first.frequency.value));
ok(first.stoppedAt > first.startedAt, "voice stops after it starts");
ok(first.stoppedAt - first.startedAt <= 0.07, "blip stays short", String(first.stoppedAt - first.startedAt));

audioSettings = { ...DEFAULTS, pitch: 12 };
audio.play("a");
ok(context.oscillators.at(-1).frequency.value > 900, "pitch +12 raises the frequency", String(context.oscillators.at(-1).frequency.value));
audioSettings = { ...DEFAULTS, pitch: -12 };
audio.play("a");
ok(context.oscillators.at(-1).frequency.value < 400, "pitch -12 lowers the frequency", String(context.oscillators.at(-1).frequency.value));

audioSettings = { ...DEFAULTS, preset: "soft" };
audio.play("a");
eq(context.oscillators.at(-1).type, "triangle", "soft preset uses a triangle wave");
audioSettings = { ...DEFAULTS, preset: "click" };
audio.play("a");
eq(context.oscillators.at(-1).type, "sawtooth", "click preset uses a sawtooth wave");
ok(context.buffers > 0, "click preset adds a noise transient");

// The custom voice is a setting, not a preset: the same preset id plays a blip the
// user shaped or the file they picked, depending on `custom.source`.
const customSynth = { ...DEFAULTS.custom, source: "synth", wave: "sine", freq: 900 };
audioSettings = { ...DEFAULTS, preset: "custom", custom: customSynth };
eq(specFor(audioSettings).kind, "synth", "custom + synth resolves to a shaped blip");
eq(audio.play("a"), true, "the custom synth voice plays without any file");
eq(context.oscillators.at(-1).type, "sine", "the custom voice uses the chosen waveform");
ok(
  Math.abs(context.oscillators.at(-1).frequency.value - 900) <= 900 * 0.06,
  "the custom voice uses the chosen base frequency",
  String(context.oscillators.at(-1).frequency.value)
);
eq(specFor({ ...DEFAULTS, preset: "soft" }).wave, "triangle", "a built-in preset still resolves from the table");
eq(specFor({ ...DEFAULTS, preset: "nope" }).wave, "triangle", "an unknown preset falls back to the default voice");

audioSettings = { ...DEFAULTS, preset: "custom", custom: { ...DEFAULTS.custom, source: "sample" } };
eq(specFor(audioSettings).kind, "sample", "custom + sample resolves to the user's file");
eq(audio.play("a"), false, "the custom file voice without a sample stays silent");
audioSettings = { ...DEFAULTS, enabled: false };
eq(audio.play("a"), false, "disabled settings never play");
audioSettings = { ...DEFAULTS, volume: 0.5 };
audio.applySettings();
ok(true, "applySettings runs against a live graph");

const sampleReady = await audio.loadSample("data:audio/wav;base64,AAAA");
ok(sampleReady, "sample data URL decodes");
audioSettings = { ...DEFAULTS, preset: "custom", custom: { ...DEFAULTS.custom, source: "sample" } };
eq(audio.play("a"), true, "the custom file voice plays once the sample is decoded");
eq(await audio.loadSample(""), false, "clearing the sample disables the custom voice");

/* ----------------------------------------------------------------------- cut */

// 说完即停 relies on this: a voice that is already scheduled must be stoppable,
// including a long user sample that would otherwise ring for seconds.
console.log("\ncut");
const cutContext = new FakeContext();
const cutAudio = new BlipAudio({
  createContext: () => cutContext,
  getSettings: () => ({ ...DEFAULTS, interval: 20 }),
  logger: { warn: () => {} }
});
eq(cutAudio.cut(), false, "cutting a graph that has never sounded does nothing");
cutAudio.play("a");
eq(cutAudio.voices.size, 1, "a scheduled voice is tracked until it ends");
eq(cutAudio.cut(), true, "cut() silences a ringing voice");
eq(cutAudio.cuts, 1, "cut() counts what it silenced");
eq(cutAudio.voices.size, 0, "no voice survives a cut");
eq(cutAudio.cut(), false, "a second cut finds nothing left to do");

// A page without Web Audio must stay silent, never throw: the chat keeps rendering.
const deafAudio = new BlipAudio({
  createContext: () => {
    throw new Error("no Web Audio in this page");
  },
  getSettings: () => ({ ...DEFAULTS }),
  logger: { warn: () => {} }
});
let threw = false;
try {
  eq(deafAudio.play("a"), false, "a page without Web Audio simply does not blip");
} catch {
  threw = true;
}
ok(!threw, "play() never propagates a context failure");
const deafDriver = new BlipDriver({ audio: deafAudio, getSettings: () => ({ enabled: true, interval: 45 }) });
deafDriver.push(["a", "b"]);
threw = false;
try {
  deafDriver.tick(16);
} catch {
  threw = true;
}
ok(!threw, "tick() survives a page without Web Audio");
eq(deafDriver.pending, 0, "the driver drops its queue instead of retrying forever");

/* --------------------------------------------------------- the voice budget */

// A background wake-up hands the audio clock a whole second of blips in one synchronous
// pass, so every voice in that burst is tracked before any of them has had the chance to
// end. The budget may therefore never be enforced by stopping the oldest voice: that one
// is the blip sounding right now, and stopping it at the newest blip's end would stretch
// a 50 ms click into a second-long tone.
console.log("\nvoice budget");
const budgetContext = new FakeContext();
const budgetAudio = new BlipAudio({
  createContext: () => budgetContext,
  getSettings: () => ({ ...DEFAULTS, interval: 45 }),
  logger: { warn: () => {} }
});
const budgetBase = budgetContext.currentTime;
for (let index = 0; index < 40; index += 1) budgetAudio.play("a", budgetBase + index * 0.045);
eq(budgetContext.oscillators.length, 40, "a burst schedules every blip it was handed");
ok(
  budgetContext.oscillators[0].stoppedAt - budgetContext.oscillators[0].startedAt <= 0.07,
  "the blip at the head of a burst is still allowed to be a blip",
  String(budgetContext.oscillators[0].stoppedAt - budgetContext.oscillators[0].startedAt)
);
// `onended` is how a voice normally leaves the books. A page that never reports it must
// still be reaped — but only once the audio clock has passed the time it was told to stop.
budgetContext.currentTime = budgetBase + 10;
budgetAudio.play("a");
eq(budgetAudio.voices.size, 1, "voices the browser never reported are reaped once the clock passes them");
ok(budgetAudio.ends.has([...budgetAudio.voices][0]), "a tracked voice carries the time it was told to stop");

/* ------------------------------------------------------------------ observer */

console.log("\nobserver");
const body = new FakeElement("div");
const flow = new FakeElement("div", { "data-chat-flow-kind": "assistant-step" });
const paragraph = new FakeElement("p");
const textNode = new FakeText("");
paragraph.appendChild(textNode);
flow.appendChild(paragraph);
body.appendChild(flow);
const codeBlock = new FakeElement("div", { class: "Xyz_CodeBlock_root" });
const codeText = new FakeText("<html>");
codeBlock.appendChild(codeText);
flow.appendChild(codeBlock);

eq(countFlowText(flow), 0, "empty flow counts zero");
eq(countFlowCharacters(flow, true), 0, "empty flow has no blip characters");
eq(
  countFlowCharacters(flow, true),
  0,
  "a flow whose only text sits in a code block contributes nothing"
);
eq(collectCharacters(flow, 3, true).length, 0, "nothing to collect from an empty flow");

const seen = [];
const chatObserver = new ChatTextObserver({
  onCharacters: (characters) => seen.push(characters.join("")),
  document: { body },
  MutationObserver: FakeMutationObserver
});
chatObserver.start();
eq(seen.length, 0, "the transcript already on screen is not replayed");

typeInto(body, textNode, "你好");
eq(seen.join(""), "你好", "appended text is reported");
typeInto(body, textNode, " world");
eq(seen.join(""), "你好world", "whitespace is skipped when asked");
eq(countFlowText(flow), 8, "the raw text count includes the space and not the code block");
eq(countFlowCharacters(flow, true), 7, "the blip count skips whitespace and the code block");

// A flow wrapper that appears already holding text is mounted content, never a
// replay of what the model typed: only the deltas after the first sighting blip.
const mountFlow = new FakeElement("div", { "data-chat-flow-kind": "assistant-step" });
const mountParagraph = new FakeElement("p");
const mountText = new FakeText("an older answer that was already on screen");
mountParagraph.appendChild(mountText);
mountFlow.appendChild(mountParagraph);
body.appendChild(mountFlow);
record(body, { type: "childList", addedNodes: [mountFlow] });
flushObservers();
eq(seen.join(""), "你好world", "a flow mounted with text does not replay it");
typeInto(body, mountText, "!");
eq(seen.join(""), "你好world!", "text typed into a mounted flow still blips");

// Second observer on the same transcript, whitespace kept this time. Its own
// baseline is what it saw when it started, so only its later appends arrive.
const cjkSeen = [];
const cjkObserver = new ChatTextObserver({
  onCharacters: (characters) => cjkSeen.push(...characters),
  shouldSkipWhitespace: () => false,
  document: { body },
  MutationObserver: FakeMutationObserver
});
cjkObserver.start();
typeInto(body, textNode, " x");
eq(cjkSeen.join(""), " x", "whitespace is reported when the setting is off");
typeInto(body, textNode, " y");
eq(cjkSeen.join(""), " x y", "the second append is reported verbatim as well");
cjkObserver.stop();

const beforeCode = seen.join("");
const untouched = new FakeText("<!-- html -->");
codeBlock.appendChild(untouched);
record(body, { type: "childList", addedNodes: [untouched] });
flushObservers();
eq(seen.join(""), beforeCode, "code block text never triggers a blip");

const beforeForeign = seen.length;
const foreign = new FakeText("internal");
const outside = new FakeElement("div");
outside.appendChild(foreign);
body.appendChild(outside);
typeInto(body, foreign, "more");
eq(seen.length, beforeForeign, "text outside the transcript is ignored");
chatObserver.stop();

// The client bundle can load before <body> exists; observing `undefined` throws.
const bodylessDocument = { body: null, addEventListener(type, listener) {
  bodylessDocument.waiting = { type, listener };
} };
const bodylessObserver = new ChatTextObserver({
  onCharacters: () => {},
  document: bodylessDocument,
  MutationObserver: FakeMutationObserver
});
threw = false;
try {
  bodylessObserver.start();
} catch {
  threw = true;
}
ok(!threw, "starting before <body> exists does not throw");
eq(bodylessDocument.waiting?.type, "DOMContentLoaded", "the watcher waits for the document instead");
bodylessObserver.stop();

/* ------------------------------------------------------------ entry silence */

// "不要一进入对话就出现音效": the host reuses row elements, re-renders markdown and
// mounts finished answers whole. None of that is typing, and the old count-only
// watcher read every one of them as a burst.
console.log("\nentry silence");
const quietSeen = [];
const quietBody = new FakeElement("div");
const quietObserver = new ChatTextObserver({
  onCharacters: (characters) => quietSeen.push(characters.join("")),
  document: { body: quietBody },
  MutationObserver: FakeMutationObserver
});
quietObserver.start();

const recycled = new FakeElement("div", { "data-chat-flow-kind": "assistant-step" });
const recycledText = new FakeText("上一轮的回答");
const recycledParagraph = new FakeElement("p");
recycledParagraph.appendChild(recycledText);
recycled.appendChild(recycledParagraph);
const mounted = new FakeElement("div", { "data-chat-flow-kind": "assistant-step" });
const mountedText = new FakeText("");
const mountedParagraph = new FakeElement("p");
mountedParagraph.appendChild(mountedText);
mounted.appendChild(mountedParagraph);
for (const [root, text] of [[recycled, recycledText], [mounted, mountedText]]) {
  quietBody.appendChild(root);
  record(quietBody, { type: "childList", addedNodes: [root] });
  record(quietBody, { type: "childList", addedNodes: [text] });
}
flushObservers();
eq(quietSeen.length, 0, "rows that mount with text, and rows that mount empty, are silent");

typeInto(quietBody, recycledText, "，继续打字");
eq(quietSeen.join(""), "，继续打字", "a row that is genuinely typing still speaks");

quietSeen.length = 0;
recycledText.data = "完全换了一段更长的、来自另一个会话的回答内容，它不应该发出任何声音";
record(quietBody, { type: "characterData", target: recycledText });
flushObservers();
eq(quietSeen.length, 0, "a row swapped onto other content is silent, however long the new text is");
typeInto(quietBody, recycledText, "接着打字");
eq(quietSeen.join(""), "接着打字", "the swapped row speaks again once it types");

quietSeen.length = 0;
mountedText.data = "这一整段是一次性出现的回答，所以不该发声，哪怕它并不算短";
record(quietBody, { type: "characterData", target: mountedText });
flushObservers();
eq(quietSeen.length, 0, "a whole answer landing in one flush is mounted content, not typing");
typeInto(quietBody, mountedText, "。");
eq(quietSeen.join(""), "。", "typing that follows a mounted answer still speaks");

/* --------------------------------------------------------- which rows speak */

// "只对回答发声": the answer row is `assistant-step`; its thinking half carries
// `data-chat-group-part="reasoning"`, and tool rows are `turn-process`.
console.log("\nwhich rows speak");
const kindSeen = [];
const kindBody = new FakeElement("div");
const kindObserver = new ChatTextObserver({
  onCharacters: (characters) => kindSeen.push(characters.join("")),
  shouldBlipRoot: (root) => {
    if (root.getAttribute("data-chat-flow-kind") !== "assistant-step") return false;
    return root.getAttribute("data-chat-group-part") !== "reasoning";
  },
  document: { body: kindBody },
  MutationObserver: FakeMutationObserver
});
kindObserver.start();
const rowTexts = [];
for (const attributes of [
  { "data-chat-flow-kind": "assistant-step" },
  { "data-chat-flow-kind": "assistant-step", "data-chat-group-part": "reasoning" },
  { "data-chat-flow-kind": "turn-process" },
  { "data-chat-flow-kind": "user" }
]) {
  const row = new FakeElement("div", attributes);
  const text = new FakeText("");
  const paragraph = new FakeElement("p");
  paragraph.appendChild(text);
  row.appendChild(paragraph);
  kindBody.appendChild(row);
  record(kindBody, { type: "childList", addedNodes: [row] });
  rowTexts.push({ row, text });
}
flushObservers();
for (const { text } of rowTexts) typeInto(kindBody, text, "abc");
eq(kindSeen.join(""), "abc", "only the answer row speaks: thinking, tools and the user stay silent");

kindSeen.length = 0;
const copyButton = new FakeElement("button");
copyButton.appendChild(new FakeText("复制"));
rowTexts[0].row.appendChild(copyButton);
record(kindBody, { type: "childList", addedNodes: [copyButton] });
flushObservers();
eq(kindSeen.length, 0, "a button appearing inside the answer row is chrome, not speech");

kindSeen.length = 0;
const timestamp = new FakeElement("time");
timestamp.appendChild(new FakeText("12.4s"));
rowTexts[0].row.appendChild(timestamp);
record(kindBody, { type: "childList", addedNodes: [timestamp] });
flushObservers();
eq(kindSeen.length, 0, "a timestamp the host attaches when the turn ends is not speech");
typeInto(kindBody, rowTexts[0].text, "de");
eq(kindSeen.join(""), "de", "the answer row still speaks after its footer appeared");

kindSeen.length = 0;
const hiddenRow = new FakeElement("div", { "data-chat-flow-kind": "assistant-step", hidden: "" });
const hiddenText = new FakeText("");
const hiddenParagraph = new FakeElement("p");
hiddenParagraph.appendChild(hiddenText);
hiddenRow.appendChild(hiddenParagraph);
kindBody.appendChild(hiddenRow);
record(kindBody, { type: "childList", addedNodes: [hiddenRow] });
flushObservers();
typeInto(kindBody, hiddenText, "隐藏的步骤");
eq(kindSeen.length, 0, "a row the user cannot see speaks for nobody");
kindObserver.stop();

/* ------------------------------------------------------------------- cadence */

console.log("\ncadence");
let driverSettings = { enabled: true, interval: 45, skipWhitespace: true };
const cadenceContext = new FakeContext();
const cadenceAudio = new BlipAudio({
  createContext: () => cadenceContext,
  getSettings: () => ({ ...DEFAULTS, ...driverSettings }),
  logger: { warn: () => {} }
});
cadenceAudio.ensure();
const driver = new BlipDriver({ audio: cadenceAudio, getSettings: () => driverSettings });
driver.push(["a", "b", "c"]);
driver.tick(16);
eq(cadenceContext.oscillators.length, 1, "the first frame emits one blip");
const firstTime = cadenceContext.oscillators[0].startedAt;
eq(Math.round(firstTime * 1000) / 1000, 10, "the first blip starts at the current audio time");

// Each later frame may only schedule inside its own window, so a fast stream comes
// out evenly rather than as one lump per frame.
let previous = firstTime;
for (let frame = 0; frame < 8; frame += 1) {
  cadenceContext.currentTime += 0.016;
  driver.tick(16);
  for (const node of cadenceContext.oscillators.slice(1)) {
    if (node.startedAt <= previous) continue;
    ok(
      node.startedAt - previous >= 0.04,
      `blip ${frame} keeps the 45 ms interval`,
      `${previous} -> ${node.startedAt}`
    );
    previous = node.startedAt;
  }
}
ok(cadenceContext.oscillators.length <= 4, "eight 16 ms frames cannot schedule more blips than the interval allows", String(cadenceContext.oscillators.length));

driver.push(["d", "e", "f"]);
const beforePause = cadenceContext.oscillators.length;
cadenceContext.currentTime += 0.5;
driver.tick(16);
eq(
  cadenceContext.oscillators.length,
  beforePause + 1,
  "a frame after a pause starts over instead of firing the whole backlog"
);
eq(driver.pending, 2, "the queue keeps what the frame did not schedule");
driverSettings = { ...driverSettings, enabled: false };
driver.push(["d"]);
cadenceContext.currentTime += 1;
driver.tick(16);
eq(driver.pending, 0, "disabling drops the backlog");
cadenceContext.state = "suspended";
driverSettings = { ...driverSettings, enabled: true };
driver.push(["e"]);
driver.tick(16);
eq(driver.pending, 0, "a suspended context drops rather than queues a burst");
cadenceContext.state = "running";

/* ------------------------------------------------------------------ the tail */

// "你说完话音效立刻停": a whole quiet window means the answer stopped, so anything
// still ringing is cut. What it must NOT do is throw the queue away — a long backlog
// is what made a paused stream sound like the sentence had been cut in half, so the
// queue is capped short (MAX_PENDING) and allowed to play out instead.
console.log("\nthe tail");
const tailContext = new FakeContext();
const tailSettings = { enabled: true, interval: 200, skipWhitespace: true, tail: 100 };
const tailAudio = new BlipAudio({
  createContext: () => tailContext,
  getSettings: () => ({ ...DEFAULTS, ...tailSettings }),
  logger: { warn: () => {} }
});
const tailDriver = new BlipDriver({ audio: tailAudio, getSettings: () => tailSettings });
tailDriver.push(["a", "b", "c", "d"]);
tailDriver.tick(16);
ok(tailDriver.pending > 0, "a fast burst still has work queued for the next frames", String(tailDriver.pending));
const tailFirst = tailContext.oscillators.length;
ok(tailFirst > 0, "the burst started sounding");
tailDriver.tick(60);
ok(tailDriver.idleMs > 0, "frame time accumulates while no character arrives");
tailDriver.tick(120);
ok(tailDriver.pending > 0, "a quiet window keeps the queue instead of throwing the sentence away", String(tailDriver.pending));
eq(tailAudio.cuts, 1, "the same window cuts what was already scheduled");
ok(!tailAudio.voices.has(tailContext.oscillators[0]), "the cut untracks the blip that was ringing");

// Playing the short queue out is not "keep talking": it finishes in a couple of
// frames and the plugin goes quiet on its own.
for (let step = 0; step < 10 && tailDriver.pending > 0; step += 1) {
  tailContext.currentTime += 0.25;
  tailDriver.tick(200);
}
eq(tailDriver.pending, 0, "the capped queue finishes on its own");
eq(tailAudio.cuts, 1, "one quiet stretch cuts once, not once per frame");

tailContext.currentTime += 1;
tailDriver.push(["e"]);
tailDriver.tick(16);
eq(tailAudio.cuts, 1, "text arriving again does not cut anything");
ok(tailContext.oscillators.length > tailFirst, "text arriving again sounds again");
eq(tailDriver.idleMs, 16, "a new character restarts the quiet window");

// The cap keeps the NEWEST characters: the sound must track the text being read
// now, not a backlog from two sentences ago.
const burstContext = new FakeContext();
const burstSettings = { enabled: true, interval: 45, skipWhitespace: true, tail: 140 };
const burstAudio = new BlipAudio({
  createContext: () => burstContext,
  getSettings: () => ({ ...DEFAULTS, ...burstSettings }),
  logger: { warn: () => {} }
});
const burstDriver = new BlipDriver({ audio: burstAudio, getSettings: () => burstSettings });
burstDriver.push("abcdefghijklmnop".split(""));
eq(burstDriver.pending, MAX_PENDING, "a long burst is trimmed to the queue cap", String(burstDriver.pending));
eq(burstDriver.characters.join(""), "klmnop", "the cap keeps the newest characters");
ok(
  MAX_PENDING * burstSettings.interval <= PLAYOUT_MS,
  "the foreground queue is shorter than the window a stopped queue may play out",
  String(MAX_PENDING * burstSettings.interval)
);

/* ---------------------------------------------------------- background clock */

// "即使在后台也会发出声音": frames stop the moment the page goes to the background, and the
// timers that replace them are clamped to about a second. The driver therefore sizes
// itself from the gap between two wake-ups, and one wake-up has to be able to hand the
// audio clock a whole second of sound — otherwise it goes quiet between two of them.
console.log("\nbackground clock");

const coarseSettings = { enabled: true, interval: 45, skipWhitespace: true, tail: 140 };
const coarseContext = new FakeContext();
const coarseAudio = new BlipAudio({
  createContext: () => coarseContext,
  getSettings: () => ({ ...DEFAULTS, ...coarseSettings }),
  logger: { warn: () => {} }
});
const coarseDriver = new BlipDriver({ audio: coarseAudio, getSettings: () => coarseSettings });
eq(coarseDriver.lead, 0, "a driver that has only ever seen frames keeps no lead");

// A hidden page: one wake-up a second later, with nothing to play yet.
coarseDriver.tick(1000, 50);
ok(coarseDriver.lead >= 1, "a coarse wake-up raises the lead to cover the next one", String(coarseDriver.lead));
ok(coarseDriver.lead <= MAX_LEAD, "the lead stays bounded", String(coarseDriver.lead));

coarseDriver.push("abcdefghijklmnopqrstuvwxyz0123456789".split(""));
ok(coarseDriver.pending > MAX_PENDING, "the queue grows to cover a whole wake-up", String(coarseDriver.pending));
ok(coarseDriver.pending <= MAX_QUEUE, "the queue still has a ceiling", String(coarseDriver.pending));
eq(coarseDriver.characters.length, coarseDriver.pending, "what is owed is still exactly what is queued");
eq(coarseDriver.characters.join(""), "ghijklmnopqrstuvwxyz0123456789", "the newest characters are the ones kept");

const coarseBase = coarseContext.currentTime;
// The idle window is a chunk pause three times longer than 说完即停: on a frame clock that
// would be the end of the answer, but a wake-up a second wide cannot tell it apart from
// the text that filled the rest of the second.
coarseDriver.tick(1000, 300);
const coarseSpans = coarseContext.oscillators.map((node) => node.startedAt);
ok(coarseSpans.length > MAX_PENDING, "one wake-up schedules more than a frame's worth of blips", String(coarseSpans.length));
ok(
  Math.max(...coarseSpans) - coarseBase >= 1,
  "a whole second of sound is placed ahead of the audio clock",
  String(Math.max(...coarseSpans) - coarseBase)
);
eq(coarseDriver.cuts, 0, "a chunk pause inside a coarse wake-up is not the end of the answer");

// The same tick without that measurement: the gap counts as quiet, but one gap cannot be
// told apart from text that arrived at its start, so the cutoff waits for a second one.
const blindDriver = new BlipDriver({ audio: coarseAudio, getSettings: () => coarseSettings });
blindDriver.push(["a"]);
blindDriver.tick(1000);
eq(blindDriver.cuts, 0, "one unmeasurable gap is not enough to call the answer over");
blindDriver.tick(1000);
eq(blindDriver.cuts, 1, "a second quiet wake-up is the answer stopping");

// Playing a stopped queue out is only "说完即停" while the queue is short. In the
// foreground it is a fraction of a second; on a background clock it is the lookahead
// buffer, and that has to be trimmed before it is played.
const trimmedPlayed = [];
const trimContext = new FakeContext();
const trimDriver = new BlipDriver({
  audio: {
    ensure: () => trimContext,
    play: (text) => {
      trimmedPlayed.push(text);
      return true;
    },
    cut: () => true
  },
  getSettings: () => coarseSettings
});
const batch = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
trimDriver.tick(1000, 50);
trimDriver.push(batch);
eq(trimDriver.pending, 30, "a background queue holds a whole wake-up's worth of characters");
trimDriver.tick(1000, 500);
ok(trimmedPlayed.length > MAX_PENDING, "while text flows a wake-up plays the whole buffer", String(trimmedPlayed.length));

trimDriver.push(batch);
const tailStart = trimmedPlayed.length;
trimContext.currentTime += 2;
trimDriver.tick(1000, 1500);
eq(
  trimmedPlayed.slice(tailStart).join(""),
  "3456789",
  "a stopped queue keeps only the newest fraction of a second"
);

/* --------------------------------------------------------------- 试听 hold */

// 试听 schedules straight onto the audio clock, so no character ever arrives during
// it: without a hold the tail cutoff would chop the preview off mid-word.
console.log("\n试听 keeps the tail away");

const holdContext = new FakeContext();
const holdSettings = { enabled: true, interval: 20, skipWhitespace: true, tail: 100 };
const holdAudio = new BlipAudio({
  createContext: () => holdContext,
  getSettings: () => ({ ...DEFAULTS, ...holdSettings })
});
const holdDriver = new BlipDriver({ audio: holdAudio, getSettings: () => holdSettings });
eq(holdDriver.holdMs, 0, "no hold is in force until one is asked for");

holdAudio.play("试");
holdDriver.hold(0.5);
holdDriver.tick(120);
eq(holdAudio.cuts, 0, "a hold keeps the tail cutoff away past the quiet window");
ok(holdAudio.voices.size > 0, "the preview voice is still ringing while the hold lasts");

holdDriver.hold(0.01);
holdDriver.tick(16);
ok(holdDriver.holdMs > 0, "a shorter hold request cannot shorten the one in force");

// Past the hold the quiet window is still open, so the run ends the normal way.
holdDriver.tick(500);
eq(holdAudio.cuts, 1, "once the hold expires the tail cutoff still fires");
eq(holdAudio.voices.size, 0, "and the preview is silenced at the end of its run");

// A preview with nothing to play must not leave a hold behind.
const idleDriver = new BlipDriver({ audio: holdAudio, getSettings: () => holdSettings });
idleDriver.hold(0.2);
idleDriver.tick(300);
eq(idleDriver.holdMs, 0, "a hold expires even when nothing was played");

/* ------------------------------------------------------- preview length */

console.log("\n试听 length");

const lengthAudio = new BlipAudio({
  createContext: () => new FakeContext(),
  getSettings: () => ({ ...DEFAULTS, preset: "soft" })
});
const synthSeconds = lengthAudio.blipSeconds();
ok(synthSeconds > 0 && synthSeconds < 0.3, "a synth voice reports a short blip", String(synthSeconds));

const customLengthAudio = new BlipAudio({
  createContext: () => new FakeContext(),
  getSettings: () => ({ ...DEFAULTS, preset: "custom", custom: { ...DEFAULTS.custom, source: "sample" } })
});
eq(customLengthAudio.blipSeconds(), 0, "a sample voice with no file has nothing to wait for");

const loadedLengthAudio = new BlipAudio({
  createContext: () => new FakeContext(),
  getSettings: () => ({ ...DEFAULTS, preset: "custom", custom: { ...DEFAULTS.custom, source: "sample" } })
});
loadedLengthAudio.sampleBuffer = { duration: 3 };
ok(
  loadedLengthAudio.blipSeconds() > 0 && loadedLengthAudio.blipSeconds() <= 0.6,
  "a long sample is reported at its capped length, never its full track",
  String(loadedLengthAudio.blipSeconds())
);

/* -------------------------------------------------------------- full pipeline */

console.log("\ntranscript → audio pipeline");
const body2 = new FakeElement("div");
const flow2 = new FakeElement("div", { "data-chat-flow-kind": "assistant-step" });
const text2 = new FakeText("");
const paragraph2 = new FakeElement("p");
paragraph2.appendChild(text2);
flow2.appendChild(paragraph2);
body2.appendChild(flow2);

const pipelineSettings = { enabled: true, interval: 0, skipWhitespace: true };
// One context instance, opened lazily by the first blip: the flow and the scheduler
// must read the very same clock.
const pipelineContext = new FakeContext();
const pipelineAudio = new BlipAudio({
  createContext: () => pipelineContext,
  getSettings: () => ({ ...DEFAULTS, ...pipelineSettings }),
  logger: { warn: () => {} }
});
const pipelineDriver = new BlipDriver({ audio: pipelineAudio, getSettings: () => pipelineSettings });
const pushedBatches = [];
const pipelineObserver = new ChatTextObserver({
  onCharacters: (characters) => {
    pushedBatches.push(characters.join(""));
    pipelineDriver.push(characters);
  },
  shouldSkipWhitespace: () => pipelineSettings.skipWhitespace,
  document: { body: body2 },
  MutationObserver: FakeMutationObserver
});pipelineObserver.start();
eq(pipelineDriver.pending, 0, "mounting an empty transcript produces no blips");
pipelineContext.currentTime += 0.5;
// "seed" arrives while the app streams, so it types; the mount case is covered by
// the observer tests, where the text is already there when the observer starts.
for (const character of "Hello 世界") {
  typeInto(body2, text2, character);
  while (pipelineDriver.pending > 0) {
    pipelineDriver.tick(16);
    pipelineContext.currentTime += 0.02;
  }
}
eq(pipelineContext.oscillators.length, 7, "each non-space character produced exactly one blip");
eq(pipelineDriver.pending, 0, "queue drained after the stream stopped");
pipelineObserver.stop();

/* -------------------------------------------------------- client integration */

console.log("\nclient integration");
const plugin = modules.client;
eq(typeof plugin.apply, "function", "client module exports apply()");
ok(Array.isArray(plugin.inject) && plugin.inject.includes("slots"), "apply injects the slots service");

const registered = [];
const disposed = [];
const slots = {
  inject(owner, callback) {
    callback();
    return () => {};
  },
  register(options, component) {
    registered.push({ options, component });
    return () => {};
  }
};
const ctx = {
  effect(factory) {
    const disposer = factory();
    if (typeof disposer === "function") disposed.push(disposer);
    return () => {};
  },
  slots
};

const created = [];
documentStub.createElement = (tag) => {
  const element = new FakeElement(tag);
  created.push(element);
  return element;
};

// The dock component reads the live store and driver, so the test drives the same
// instances the runtime built: __test__ is the plugin's documented seam for that.
// A module in the startup batch runs before <body> exists; apply() must survive it.
const bodyless = {
  head: new FakeElement("head"),
  body: null,
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  waiting: null,
  addEventListener(type, listener) {
    bodyless.waiting = { type, listener };
  },
  removeEventListener() {}
};
const savedDocument = globalThis.document;
globalThis.document = bodyless;
const registrationsBeforeDefer = registered.length;
let deferredThrew = false;
try {
  plugin.apply(ctx);
} catch (error) {
  deferredThrew = true;
}
ok(!deferredThrew, "apply() before <body> exists does not throw");
eq(registered.length, registrationsBeforeDefer, "nothing is registered before the document exists");
eq(bodyless.waiting?.type, "DOMContentLoaded", "apply() waits for the document");
globalThis.document = savedDocument;

// The runtime keeps a timer as a second clock (GUARD_INTERVAL_MS). The harness owns that
// timer, because "the animation frames stopped arriving" is a state only the test can
// enter: on a visible page a frame always beats the timer to the wake-up.
const intervals = new Map();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, ms) => {
  intervals.set(ms, callback);
  return ms;
};
globalThis.clearInterval = (id) => intervals.delete(id);

const exportsBeforeApply = Object.keys(modules.client);
try {
  plugin.apply(ctx);
} catch (error) {
  ok(false, "apply() completed without throwing", String(error && error.message));
}
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
const runtime = plugin.__test__ ?? {};
eq((plugin.__test__?.contexts ?? []).length, 0, "the audio graph stays unopened until a blip is due");
eq(typeof runtime.driver?.push, "function", "the runtime exposes its driver to the test seam");
ok(runtime.audio !== undefined, "the runtime exposes its engine to the test seam");

eq(registered.length, 1, "one slot registration");
const dockOptions = registered[0]?.options ?? {};
eq(dockOptions.name, "conversation.composer.dock", "registers into the composer dock");
eq(dockOptions.id, "typewriter-blip", "dock registration id");
eq(dockOptions.order, 40, "dock registration order");
const styleTag = created.find((element) => element.tagName === "STYLE");
ok(styleTag !== undefined, "the plugin injects its stylesheet");
ok((styleTag?.textContent ?? "").includes("--dsw-alias-"), "stylesheet uses theme tokens");
ok(!(styleTag?.textContent ?? "").includes("#"), "stylesheet has no literal colors");
ok((styleTag?.textContent ?? "").includes(".twb-button"), "stylesheet is namespaced");

// "加上随dsh主题变换的背景色": the panel borrows DSH's own floating-panel surface
// instead of the badge/inset token it used to wear, so it tracks the theme in both
// light and dark instead of turning into a light-grey slab on a dark page.
const sheetCss = styleTag?.textContent ?? "";
ok(sheetCss.includes("background:var(--dsw-specific-menu"), "the panel wears the host's floating-surface token");
ok(sheetCss.includes("var(--dsw-menu-backdrop-filter"), "the panel blurs what is behind it, like the host's menus");
ok(sheetCss.includes("var(--dsw-elevation-prominent"), "the panel uses the host's elevation shadow");
ok(!sheetCss.includes("var(--dsw-alias-bg-overlay)"), "the badge surface token is gone from the panel");

// `component` is the registered wrapper (`(props) => h(Dock, …)`), so one step of
// React's own work is needed: call the wrapper to get the vnode, then the component.
const Registered = registered[0]?.component;
let dockElement;
try {
  const wrapperVnode = Registered({ store: runtime.store, audio: runtime.audio, driver: runtime.driver });
  dockElement = wrapperVnode.type(wrapperVnode.props);
  // The entry point must resolve to a live vnode tree, not to a component.
  ok(typeof Registered === "function", "the dock registers a component");
  ok(typeof wrapperVnode.type === "function", "the registered wrapper renders the Dock component");
} catch (error) {
  ok(false, "the dock component rendered", String(error && error.message));
}
eq(dockElement?.type, "div", "dock component renders a root element");
const button = dockElement?.props?.children?.[0];
eq(button?.props?.id, "typewriter-blip", "dock renders the switch button");
eq(button?.props?.children?.[1]?.props?.children, "说话音效", "the dock button is called 说话音效");
// "把计数删掉": the button is glyph + label only, and nothing publishes blip counts.
eq(button?.props?.children?.length, 2, "the dock button carries no blip counter");
ok(!(styleTag?.textContent ?? "").includes(".twb-count"), "the counter left no styles behind");
eq(runtime.driver?.subscribe, undefined, "nothing installs a blip-count publisher on the driver");
eq(button?.props?.title, "说话音效：回答时逐字发声", "the button describes itself as speech, not typing");
eq(button?.props?.["aria-haspopup"], "dialog", "button advertises the dialog");
eq(button?.props?.["data-on"], true, "sound starts enabled");
ok(dockElement?.props?.children?.[1] === null, "the panel starts collapsed");

// The collapsed dock never renders the panel, and a throw inside a slot component
// takes the composer dock down with it, so render it directly.
const { Panel } = runtime.components ?? {};
ok(typeof Panel === "function", "the settings panel is reachable through the test seam");
let panelElement = null;
try {
  panelElement = Panel({
    store: runtime.store,
    audio: runtime.audio,
    driver: runtime.driver,
    anchor: new FakeElement("div"),
    onClose: () => {}
  });
} catch (error) {
  ok(false, "the settings panel renders", String(error && error.message));
}
eq(panelElement?.props?.id, "typewriter-blip-panel", "the panel renders its dialog root");
const panelText = JSON.stringify(panelElement ?? {});
ok(panelText.includes("说话音效"), "the panel is called 说话音效");
ok(panelText.includes("自定义音色"), "the panel offers a custom voice section");
ok(panelText.includes("正弦") && panelText.includes("锯齿"), "the custom synth editor lists its waveforms");
ok(panelText.includes("基频") && panelText.includes("音长"), "the custom synth editor is shaped by the user");
ok(panelText.includes("音频文件"), "the custom voice can also use a file");
ok(panelText.includes("说完即停"), "the panel exposes the tail control");
ok(panelText.includes("只对回答发声"), "the panel exposes the answer-only switch");
ok(panelText.includes("试听") && panelText.includes("恢复默认"), "the panel keeps its preview and reset actions");

// "点击试听后必须听完才可以点击下一次": the preview button is locked by state, and its
// label says why, so the wait is visible rather than a dead button.
const previewButton = findVnode(panelElement, (node) => node?.props?.className === "twb-action" && node?.props?.["data-variant"] === "primary");
ok(previewButton !== null, "the panel renders a primary 试听 button");
eq(previewButton?.props?.disabled, false, "试听 starts unlocked");
eq(previewButton?.props?.["data-previewing"], false, "试听 does not claim to be mid-run before it is pressed");
eq(typeof previewButton?.props?.onClick, "function", "试听 is wired to the preview run");
eq(typeof runtime.previewLabel, "function", "the preview label is reachable through the test seam");
eq(runtime.previewLabel?.(false), "试听", "an idle preview button reads 试听");
eq(runtime.previewLabel?.(true), "试听中…", "a running preview button says it is still playing");
ok((previewButton?.props?.children ?? "") === runtime.previewLabel?.(false), "the button shows the idle label while unlocked");
eq(runtime.store.get().custom.source, "synth", "the panel opens on the synth custom voice");
eq(runtime.store.get().answerOnly, true, "the dock starts with answers only");
eq(runtime.store.get().tail, 140, "the dock starts with the tight 说完即停 window");

/* ------------------------------------------- the panel opens above the button */

// The panel is `position:absolute` inside the dock root, so `top` has to be a
// LOCAL offset. Writing a viewport Y there is the bug that dropped the panel off
// the bottom of the screen: the root itself sits on the window's bottom edge, so
// the button's own offset got added on top of an already-correct page position.
const placePanel = runtime.placePanel;
ok(typeof placePanel === "function", "the placement math is reachable through the test seam");

if (typeof placePanel === "function") {
  const base = { viewportWidth: 1200, viewportHeight: 900, panelWidth: 306 };

  // The reported case: composer on the bottom edge, panel taller than the window.
  const low = placePanel({ ...base, anchorTop: 820, anchorBottom: 850, anchorLeft: 100, panelHeight: 900 });
  const lowHeight = Math.min(900, low.maxHeight);
  const lowTop = 820 + low.localTop;
  ok(low.up, "a panel anchored to the window's bottom edge opens upwards");
  ok(low.localTop < 0, "above the button is a negative local offset", String(low.localTop));
  ok(lowTop >= 8, "the panel clears the top edge", String(lowTop));
  ok(lowTop + lowHeight <= 892, "the panel clears the bottom edge", String(lowTop + lowHeight));
  ok(lowTop + lowHeight <= 820, "the panel sits entirely above the button", String(lowTop + lowHeight));
  ok(low.maxHeight <= 804, "the panel is capped to the room above the button", String(low.maxHeight));

  // A short panel with room on both sides still prefers the side the user asked for.
  const short = placePanel({ ...base, anchorTop: 500, anchorBottom: 530, anchorLeft: 100, panelHeight: 300 });
  ok(short.up, "a panel that fits either way still opens upwards");
  ok(500 + short.localTop + 300 <= 500, "the short panel also ends above the button", String(500 + short.localTop + 300));
  eq(short.localLeft, 0, "a panel flush with its button needs no horizontal shift");

  // Anchored to the top of the window there is no room above, so it must flip.
  const high = placePanel({ ...base, anchorTop: 10, anchorBottom: 40, anchorLeft: 100, panelHeight: 400 });
  ok(!high.up, "a button at the top of the window opens downwards instead");
  ok(10 + high.localTop >= 8, "the flipped panel clears the top edge", String(10 + high.localTop));
  ok(10 + high.localTop + 400 <= 892, "the flipped panel clears the bottom edge", String(10 + high.localTop + 400));

  // Horizontal clamping, in page space, rebased the same way.
  const right = placePanel({ ...base, anchorTop: 820, anchorBottom: 850, anchorLeft: 1100, panelHeight: 400 });
  eq(1100 + right.localLeft, 1200 - 8 - 306, "a panel at the right edge is pulled back inside the window");
  const narrow = placePanel({ ...base, anchorTop: 820, anchorBottom: 850, anchorLeft: 4, panelHeight: 400 });
  eq(4 + narrow.localLeft, 8, "a panel at the left edge is pushed inside the window");

  // Whatever the window, the panel box stays inside it.
  const extremes = [
    { anchorTop: 0, anchorBottom: 26, anchorLeft: 0, panelHeight: 1200 },
    { anchorTop: 899, anchorBottom: 900, anchorLeft: 1199, panelHeight: 1200 },
    { anchorTop: 450, anchorBottom: 476, anchorLeft: 600, panelHeight: 10 }
  ];
  let inside = true;
  for (const extreme of extremes) {
    const placed = placePanel({ ...base, ...extreme });
    const height = Math.min(extreme.panelHeight, placed.maxHeight);
    const width = Math.min(base.panelWidth, base.viewportWidth - 16);
    const top = extreme.anchorTop + placed.localTop;
    const left = extreme.anchorLeft + placed.localLeft;
    if (top < 8 || top + height > 892 || left < 8 || left + width > 1192) inside = false;
  }
  ok(inside, "the panel box stays inside the window at every corner");

  // The reported regression: measuring the panel through its entry animation (which
  // scales it) put the panel low, and a later re-place snapped it back up.
  const measurePanel = runtime.measurePanel;
  ok(typeof measurePanel === "function", "the panel measurement is reachable through the test seam");
  if (typeof measurePanel === "function") {
    const animated = {
      offsetWidth: 306,
      offsetHeight: 700,
      getBoundingClientRect: () => ({ width: 297, height: 679 })
    };
    eq(measurePanel(animated).height, 700, "the panel is measured by its layout box, not the animated one");
    eq(measurePanel(animated).width, 306, "the layout box also supplies the width");
    eq(measurePanel({ getBoundingClientRect: () => ({ width: 297, height: 679 }) }).height, 679, "a panel without offsets falls back to its rect");
    eq(measurePanel({ offsetHeight: 0, offsetWidth: 0 }).height, 360, "an unmeasurable panel falls back to its nominal size");

    const animatedPlace = placePanel({ ...base, anchorTop: 820, anchorBottom: 850, anchorLeft: 100, panelHeight: 679 });
    const layoutPlace = placePanel({ ...base, anchorTop: 820, anchorBottom: 850, anchorLeft: 100, panelHeight: 700 });
    ok(
      820 + animatedPlace.localTop + 700 > 812,
      "the animated measurement hangs the real panel below the button",
      String(820 + animatedPlace.localTop + 700)
    );
    eq(820 + layoutPlace.localTop + 700, 812, "the layout measurement lands the real panel just above the button");
  }
}

/* --------------------------------------------------- the panel eases in and out */

// "缓出的动画效果": the panel must not blink into place, and closing must play the
// exit animation before React takes the panel away.
const styleCss = styleTag?.textContent ?? "";
ok(styleCss.includes("@keyframes twb-panel-in"), "the stylesheet animates the panel in");
ok(styleCss.includes("@keyframes twb-panel-out"), "the stylesheet animates the panel out");
ok(styleCss.includes("twb-panel-in 180ms"), "the entry uses the shared duration");
ok(styleCss.includes("cubic-bezier(.16,1,.3,1)"), "the entry eases out rather than running linearly");
ok(styleCss.includes("twb-panel-out 140ms ease-in"), "the exit is shorter than the entry");
ok(styleCss.includes("forwards"), "the exit holds its last frame while the panel unmounts");
ok(styleCss.includes("prefers-reduced-motion"), "the animation respects reduced motion");
ok(styleCss.includes("--twb-panel-shift"), "the panel slides in from the button's side");

const nextPhase = runtime.nextPhase;
ok(typeof nextPhase === "function", "the open/close state machine is reachable through the test seam");
if (typeof nextPhase === "function") {
  eq(nextPhase("closed", "toggle"), "open", "the first click opens the panel");
  eq(nextPhase("open", "toggle"), "leaving", "the second click starts the exit instead of hiding it");
  eq(nextPhase("leaving", "toggle"), "open", "clicking again mid-exit brings the panel back");
  eq(nextPhase("open", "close"), "leaving", "Escape and outside clicks run the exit too");
  eq(nextPhase("closed", "close"), "closed", "closing a closed panel changes nothing");
  eq(nextPhase("leaving", "close"), "leaving", "a second close does not restart the timer");
  eq(nextPhase("leaving", "settle"), "closed", "the panel unmounts once the exit has played");
  eq(nextPhase("open", "settle"), "open", "a stray settle cannot close an open panel");
  eq(nextPhase("closed", "settle"), "closed", "a stray settle cannot open a closed panel");
}

let leavingElement = null;
try {
  leavingElement = Panel({
    store: runtime.store,
    audio: runtime.audio,
    anchor: new FakeElement("div"),
    leaving: true,
    onClose: () => {}
  });
} catch (error) {
  ok(false, "the leaving panel renders", String(error && error.message));
}
eq(leavingElement?.props?.["data-leaving"], "true", "the panel marks itself as leaving so the exit animation runs");
eq(panelElement?.props?.["data-leaving"], undefined, "an open panel carries no leaving marker");

// The watcher is live: typing into a chat flow must reach the audio graph.
const liveFlow = new FakeElement("div", { "data-chat-flow-kind": "assistant-step" });
const liveText = new FakeText("");
const liveParagraph = new FakeElement("p");
liveParagraph.appendChild(liveText);
liveFlow.appendChild(liveParagraph);
documentStub.body.appendChild(liveFlow);
for (const character of "seed") typeInto(documentStub.body, liveText, character);
for (const character of "abc") typeInto(documentStub.body, liveText, character);
ok(frames.length > 0, "the runtime started its animation frame loop");
for (let step = 0; step < 200; step += 1) {
  const callbacks = frames.splice(0, frames.length);
  for (const callback of callbacks) callback();
  const live = contexts[0];
  if (live !== undefined) live.currentTime += 0.02;
}
ok(contexts.length > 0, "typing in the transcript opened an AudioContext");
ok(
  (contexts[0]?.oscillators.length ?? 0) >= 1,
  "typing in the transcript scheduled blips",
  String(contexts[0]?.oscillators.length)
);
ok(
  (runtime.driver?.played ?? 0) > 0,
  "the engine counts the blips it actually played",
  String(runtime.driver?.played)
);

/* --------------------------------------------------------------- background */

// "即使在后台也会发出声音": the frame clock is the first thing a background page loses, and
// whatever clock replaces it is clamped to about a second. The runtime therefore runs a
// timer beside the frames, and the driver buffers whatever the gaps between wake-ups call
// for. What must not change is the foreground: the same code has to stay frame-paced.
console.log("\nbackground");

const guardTick = intervals.size > 0 ? [...intervals.values()][0] : null;
ok(typeof guardTick === "function", "the runtime keeps a timer beside the animation frames");
const visibilityHandler = (documentStub.listeners.get("visibilitychange") ?? [])[0];
ok(typeof visibilityHandler === "function", "the runtime watches the page's visibility");

const liveDriver = runtime.driver;
const liveAudioContext = contexts[0];
/** Wall clock and audio clock move together, as they do in a page. */
const advance = (ms) => {
  clockMs += ms;
  liveAudioContext.currentTime += ms / 1000;
};

documentStub.hidden = true;
visibilityHandler();
ok(liveDriver.lead >= 1, "a hidden page buffers a whole wake-up of sound", String(liveDriver.lead));

// A background page's timers can be a wake-up a minute apart, and by then the answer
// would be over: text arriving has to be its own wake-up.
const hiddenBefore = liveAudioContext.oscillators.length;
advance(50);
for (const character of "后台") typeInto(documentStub.body, liveText, character);
ok(
  liveAudioContext.oscillators.length > hiddenBefore,
  "text arriving in the background does not wait for a timer",
  `${hiddenBefore} -> ${liveAudioContext.oscillators.length}`
);

// The guard may not depend on the visibility API either: an occluded window can stop
// producing frames without ever saying it is hidden.
documentStub.hidden = false;
const guardedBefore = liveAudioContext.oscillators.length;
advance(5000);
for (const character of "background") typeInto(documentStub.body, liveText, character);
advance(300);
guardTick?.();
ok(
  liveAudioContext.oscillators.length > guardedBefore,
  "the guard keeps the audio clock fed without frames",
  `${guardedBefore} -> ${liveAudioContext.oscillators.length}`
);

// Back in front the driver has to schedule like a foreground page again, or the sound
// would sit a whole background buffer behind the text being typed.
documentStub.hidden = false;
visibilityHandler();
ok(liveDriver.lead < 0.1, "coming back to the front restores the frame-rate lead", String(liveDriver.lead));

for (const disposer of disposed) disposer();
ok(true, "disposal ran without throwing");

/* -------------------------------------------------------------------- result */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exitCode = 1;
}
