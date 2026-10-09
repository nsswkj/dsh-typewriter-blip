/**
 * Cadence plus the chat-transcript observer.
 *
 * Two halves, both DOM-free at their core:
 *  - {@link BlipDriver} turns character deltas into scheduled blips, spaced by the
 *    configured interval so a fast stream stays audible instead of clipping, and
 *    drops everything the moment the text stops arriving.
 *  - {@link ChatTextObserver} turns the rendered transcript into character deltas.
 *
 * Why the rendered transcript: the Chat rows are host-owned React internals and a
 * streaming assistant node exposes no per-character signal on its slot props
 * (`hookContext` carries only `{ turnData, disclosureReset }`). Reading what the
 * host actually painted is also exactly what "one blip per visible character"
 * means, and the watcher is limited to the `data-chat-flow-kind` wrappers the
 * Conversation layer already publishes for its own paging.
 *
 * The hard part is telling a stream from a repaint. The host reuses rows, mounts
 * finished answers whole, re-renders markdown as it becomes valid and attaches
 * footers when a turn ends; every one of those looks like "text appeared" to a
 * naive counter, and each would make the plugin talk at the wrong time. Three
 * cheap invariants separate them, and all three are enforced below:
 *
 *  - a row's text only ever grows by appending (prefix test) — a swapped row is a
 *    different conversation's content on a recycled element;
 *  - a row's first read is always a baseline, never a blip;
 *  - a single flush that reveals a whole block at once is a mount, not typing.
 */

/**
 * A root's FIRST growth this large is content arriving whole (a mounted answer, a
 * restored session), not typing: typing starts small and repeats.
 */
const FIRST_GROWTH_MAX = 24;
/**
 * A frame longer than this would schedule a burst; keep one blip and move on.
 */
const MAX_DELTA = 24;
/**
 * Characters allowed to wait for their blip when the clock is fast.
 *
 * Kept small on purpose. The blip rate is capped by `最小间隔`, so a long queue cannot
 * make the sound richer — it only makes it lag further behind the text, and every bit of
 * that lag is thrown away the moment the stream pauses for longer than `说完即停`. That
 * is what made a paused answer sound like the sentence had been cut in half: the sound
 * fell a second or two behind and then lost the whole backlog. With a queue this short,
 * the sound tracks the text being typed right now, and at `最小间隔` the whole queue
 * plays out in a fraction of a second.
 *
 * It is a floor, not the cap: on a coarse clock the queue is a lookahead buffer instead,
 * and grows to whatever {@link BlipDriver#lead} needs — see {@link MAX_QUEUE}.
 */
const MAX_PENDING = 6;
/** Queue ceiling in characters, i.e. a background page's lookahead buffer. */
const MAX_QUEUE = 48;
/** Characters of slack past what the lead needs, so a late tick finds work waiting. */
const QUEUE_SLACK = 2;
/**
 * A lead covers this much more than the gap it was measured from.
 *
 * Sizing the lead to exactly the observed gap would put the last scheduled blip on the
 * wake-up that is supposed to follow it; a third again is the difference between "the
 * sound fills the silence" and "the sound stutters once per wake-up".
 */
const LEAD_MARGIN = 1.25;
/** Longest lead the driver keeps, in seconds. Blips placed further out than this would
 * be a bet that no text will arrive to make them stale — and at 22 blips a second that
 * bet costs a queue of well over a second. */
const MAX_LEAD = 2;
/**
 * How much of a STOPPED queue is still worth playing out, in milliseconds.
 *
 * While text is arriving the queue is a lookahead buffer and may be as long as the clock
 * is coarse; once the text stops it is only worth finishing the last fraction of a
 * second, or "说完即停" would be a lie on a slow clock. In the foreground the queue is
 * shorter than this already, so nothing is trimmed and the end of a sentence still
 * sounds — that regression is exactly what this window is sized to keep.
 */
const PLAYOUT_MS = 300;
/** Any later single flush revealing more than this is a re-render, never typing. */
const MOUNT_JUMP = 160;
/**
 * Flow wrappers tracked at once. A long session mounts thousands of them, and the
 * map would otherwise keep every one of them (and its DOM subtree) alive.
 */
const MAX_TRACKED = 400;
/** Rendered characters kept per wrapper: enough to recognise an append. */
const TEXT_HEAD = 2048;
/** Silence after the last character before the queue is dropped, milliseconds. */
const DEFAULT_TAIL = 140;

/**
 * Subtrees that are chrome or payload, never speech: code and JSON are read rather
 * than spoken, and a button, timestamp or toolbar is the host's UI, which appears
 * when a message *finishes* — blipping for it would talk after the answer ended.
 */
const EXCLUDED_TAGS = new Set([
  "PRE",
  "CODE",
  "KBD",
  "SAMP",
  "BUTTON",
  "SVG",
  "TIME",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "SCRIPT",
  "STYLE"
]);

/** Hashed class names keep their semantic suffix, which is what these match. */
const EXCLUDED_HINTS = ["CodeBlock", "JsonBlock", "actions", "toolbar"];

function isElement(value) {
  const ElementClass = globalThis.Element;
  return typeof ElementClass === "function" && value instanceof ElementClass;
}

function attributeOf(element, name) {
  return typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
}

function isExcluded(element) {
  const tagName = element.tagName;
  if (typeof tagName === "string" && EXCLUDED_TAGS.has(tagName)) return true;
  const className = typeof element.className === "string" ? element.className : "";
  for (const hint of EXCLUDED_HINTS) {
    if (className.includes(hint)) return true;
  }
  if (attributeOf(element, "hidden") !== null) return true;
  // The host marks its own hover toolbar with this; it is not part of the answer.
  if (attributeOf(element, "data-actions-reveal") !== null) return true;
  return false;
}

/**
 * Walk one flow wrapper and report the characters it contributes.
 *
 * Excluded subtrees (code, JSON payloads, UI chrome) are skipped, and
 * `skipWhitespace` drops whitespace. Counting and collecting share this one
 * traversal: counting in a different domain (UTF-16 code units while collecting
 * code points, say) makes the difference between the two look like extra
 * characters, and every phantom turns into its own blip.
 *
 * @param {Element} root
 * @param {boolean} skipWhitespace
 * @param {(character: string) => void} visit
 */
function walkFlowCharacters(root, skipWhitespace, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const children = node.childNodes;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child.nodeType === 1) {
        if (!isExcluded(child)) stack.push(child);
        continue;
      }
      if (child.nodeType !== 3) continue;
      for (const character of Array.from(child.data ?? "")) {
        if (skipWhitespace && /\s/.test(character)) continue;
        visit(character);
      }
    }
  }
}

/**
 * Everything one flow wrapper currently shows: its rendered text, how many blip
 * characters that is, and the characters themselves in document order.
 *
 * @param {Element} root
 * @param {boolean} skipWhitespace
 * @returns {{text: string, count: number, kept: string[]}}
 */
function readFlow(root, skipWhitespace) {
  const all = [];
  walkFlowCharacters(root, false, (character) => all.push(character));
  const kept = skipWhitespace ? all.filter((character) => !/\s/.test(character)) : all;
  return { text: all.join(""), count: kept.length, kept };
}

/**
 * Characters a flow currently contributes, under the active whitespace rule.
 *
 * @param {Element} root
 * @param {boolean} skipWhitespace
 * @returns {number}
 */
function countFlowCharacters(root, skipWhitespace) {
  if (root === null || root === undefined) return 0;
  return readFlow(root, skipWhitespace).count;
}

/**
 * All text of one chat flow wrapper, skipping code blocks, JSON payloads and UI
 * chrome: those are read, not "spoken", and they arrive in big single mutations.
 *
 * @param {Element} root
 * @returns {number} character count
 */
function countFlowText(root) {
  if (root === null || root === undefined) return 0;
  let total = 0;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        if (isExcluded(child)) continue;
        walk(child);
      } else if (child.nodeType === 3) {
        total += (child.data ?? "").length;
      }
    }
  };
  walk(root);
  return total;
}

/** Nearest ancestor wrapper the Conversation layer marked as one chat flow item. */
function flowRootOf(node) {
  let current = isElement(node) ? node : node?.parentElement ?? null;
  while (current !== null && current !== undefined) {
    if (current.hasAttribute?.("data-chat-flow-kind") === true) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * The characters a delta added, taken from the end of the flow in document order.
 *
 * A stream appends, so the newest characters are the last ones; taking the first
 * `delta` of the flow instead would replay the transcript from its beginning on
 * every mutation.
 *
 * `delta` counts in the same domain this collects in (see `readFlow`), so nothing
 * is invented and nothing is dropped when a chunk arrives at once.
 *
 * @param {Element} root
 * @param {number} delta
 * @param {boolean} skipWhitespace
 * @returns {string[]}
 */
function collectCharacters(root, delta, skipWhitespace) {
  const { kept } = readFlow(root, skipWhitespace);
  return kept.slice(Math.max(0, kept.length - delta));
}

/**
 * Turns per-frame character deltas into a stream of blips.
 *
 * The scheduler measures time in the audio clock, so the spacing is exact even when
 * frames are irregular; the tail is measured against the arrival of text, because that
 * is the only clock that keeps running after the text has stopped.
 *
 * Two clocks can wake it. An animation frame is the good one — it lands on a paint and
 * costs nothing while the page sits idle — and it is the first thing a background page
 * loses: a hidden tab and a minimized window both stop producing frames, and clamp
 * timers to about a second. The driver therefore sizes itself from the gap between two
 * wake-ups rather than assuming a frame rate: it buffers that much sound on the audio
 * clock ({@link BlipDriver#lead}), because the audio clock keeps running whether or not
 * anybody is looking at the page.
 */
class BlipDriver {
  /**
   * @param {object} options
   * @param {{play: (text: string, at: number) => boolean, ensure: () => AudioContext, cut?: () => boolean}} options.audio
   * @param {() => {enabled: boolean, interval: number, skipWhitespace: boolean, tail?: number}} options.getSettings
   */
  constructor(options) {
    this.audio = options.audio;
    this.getSettings = options.getSettings;
    this.pending = 0;
    /** @type {string[]} */
    this.characters = [];
    this.nextAt = 0;
    this.skipped = 0;
    /** Milliseconds since the last character arrived; drives the tail cutoff. */
    this.idleMs = 0;
    /** Milliseconds of tail cutoff still held off; see {@link BlipDriver#hold}. */
    this.holdMs = 0;
    this.cutFired = false;
    this.cuts = 0;
    /** Lead measured from the last two wake-ups, in seconds. */
    this.leadSeconds = 0;
    /** Floor for the lead; raised while the page is known to be hidden. */
    this.baseLead = 0;
  }

  /** How far ahead of the audio clock blips are placed, in seconds. */
  get lead() {
    return Math.min(MAX_LEAD, Math.max(this.baseLead, this.leadSeconds));
  }

  /**
   * Declare how coarse the driver's clock is about to become.
   *
   * A hidden page runs on timers instead of frames, and its wake-ups are up to a second
   * apart, so it needs sound buffered that far ahead to stay audible. Saying so up front
   * is what keeps the first second of a background answer from stuttering: waiting for
   * the first coarse tick to notice would drop every character that arrived before it.
   *
   * @param {number} seconds a floor for the lead; 0 restores the frame-rate lead
   */
  setLead(seconds) {
    const next = Math.max(0, seconds);
    this.baseLead = next;
    this.leadSeconds = next;
    // The queue is sized by the lead, so a lead that shrinks has to shrink it too: a
    // foreground that inherited a second of background backlog would sound a second
    // behind the text — the very bug the short foreground queue exists to prevent.
    this.#trimTo(this.#capacity());
  }

  /** Blips the engine really scheduled; the offline harness reads this. */
  get played() {
    return typeof this.audio.played === "number" ? this.audio.played : 0;
  }

  get isEmpty() {
    return this.pending === 0;
  }

  /** Characters the stream revealed; text is used for per-character pitch. */
  push(characters) {
    if (characters.length === 0) return;
    // Text is arriving: the answer is still being spoken, so nothing may be cut.
    this.idleMs = 0;
    this.cutFired = false;
    const limit = this.#capacity();
    for (const character of characters) {
      if (this.characters.length >= limit) this.characters.shift();
      this.characters.push(character);
    }
    // What is owed is exactly what is queued: overflowing drops the OLDEST characters
    // and keeps the newest, because the newest are the ones being read.
    this.pending = this.characters.length;
  }

  /**
   * Keep the tail cutoff away for a while.
   *
   * 试听 schedules its blips straight onto the audio clock instead of pushing
   * characters, so "no new characters for a whole tail" is true the entire time and
   * the cutoff would chop the preview off mid-word. The hold is a ceiling, not a
   * counter: asking for less than what is left changes nothing.
   *
   * @param {number} seconds
   */
  hold(seconds) {
    const ms = Math.max(0, seconds) * 1000;
    if (ms > this.holdMs) this.holdMs = ms;
  }

  /**
   * Schedule whatever the current audio clock allows; stop when the text has.
   *
   * @param {number} [elapsedMs] milliseconds since the previous wake-up
   * @param {number} [idleMs] milliseconds since the last character arrived, when the
   *   caller can measure it. A coarse wake-up covers text and silence at once, so a
   *   driver that added the whole gap to its quiet window would cut the answer it is
   *   still being handed — a second-long background tick would fire the tail at every
   *   single one of its own wake-ups.
   */
  tick(elapsedMs = 0, idleMs) {
    const measured = typeof idleMs === "number" && Number.isFinite(idleMs);
    this.idleMs = measured ? Math.max(0, idleMs) : this.idleMs + elapsedMs;
    this.holdMs = Math.max(0, this.holdMs - elapsedMs);
    // Whatever the gap was, the next wake-up is at least that far away, and only sound
    // already placed on the audio clock will be heard in the meantime.
    this.leadSeconds = Math.min(MAX_LEAD, (Math.max(elapsedMs, 16) / 1000) * LEAD_MARGIN);
    const settings = this.getSettings();
    if (!settings.enabled) {
      this.#clear();
      this.#cut();
      return;
    }
    const tail = settings.tail ?? DEFAULT_TAIL;
    // A clock cannot judge a window shorter than one of its own wake-ups: on a background
    // page the gap between two of them is about a second, so every chunk pause longer than
    // `说完即停` would look like the end of the answer and cut the buffer that was just
    // filled. The window therefore never shrinks below the gap it was measured over — and
    // it only fires on a silence that stretches across a whole wake-up, which is as precise
    // as that clock can be.
    const window = Math.max(tail, elapsedMs);
    if (this.holdMs === 0 && this.idleMs > window) {
      // A whole tail window with no new character: the answer stopped, so anything
      // still ringing is cut, and the queue is trimmed to what is still worth playing.
      // In the foreground that is the whole six-character queue — dropping it is what
      // made a paused stream sound like a half-spoken sentence. On a background clock
      // the queue is a lookahead buffer of up to a second instead, and playing THAT out
      // after the answer ended is what would make 说完即停 a lie.
      this.#trimTo(this.#worth(PLAYOUT_MS));
      this.#cut();
    }
    // The graph opens on the first blip; a driver that only read `audio.context`
    // would never open it and would silently drop every character.
    let context;
    try {
      context = this.audio.ensure();
    } catch {
      // A page without Web Audio stays silent instead of throwing on every frame.
      this.#clear();
      return;
    }
    if (context === null || context === undefined || context.state === "suspended") {
      // Sounds may only start after a gesture; drop the backlog instead of firing
      // a burst the moment audio comes back.
      this.#clear();
      return;
    }
    const now = context.currentTime;
    const step = this.#step();
    // The audio clock is the only time source here; a schedule that fell far
    // behind means the stream paused, and the next blip starts from "now".
    const STALL = 0.5;
    if (this.nextAt < now - STALL) this.nextAt = now;
    // Blips are placed inside the lead — the window the next wake-up has to stay within
    // — plus half a step of slack, so the last blip is not scheduled exactly on the
    // boundary where a late wake-up would leave a hole.
    const horizon = now + this.lead + step * 0.5;
    let budget = this.#capacity();
    while (this.pending > 0 && budget > 0) {
      if (this.nextAt > horizon) break;
      const text = this.characters.length > 0 ? this.characters.shift() : "a";
      const at = Math.max(this.nextAt, now);
      this.pending -= 1;
      budget -= 1;
      this.nextAt = at + step;
      if (!this.audio.play(text, at)) this.skipped += 1;
    }
  }

  /** Seconds between two blips under the current settings. */
  #step() {
    return Math.max(0.004, this.getSettings().interval / 1000);
  }

  /** Characters worth at most `ms` of sound at the current spacing; never zero. */
  #worth(ms) {
    return Math.max(1, Math.ceil(ms / 1000 / this.#step()));
  }

  /**
   * Characters worth queueing right now: exactly what the current lead can schedule.
   *
   * A lead with no characters behind it is silence, so the queue is sized by the lead
   * rather than by a constant — and the two ends of that are the two behaviours this
   * plugin needs: a short queue that tracks the text on a frame clock, and a buffer of
   * a whole wake-up on a throttled one.
   */
  #capacity() {
    return Math.max(MAX_PENDING, Math.min(MAX_QUEUE, Math.ceil(this.lead / this.#step()) + QUEUE_SLACK));
  }

  /** Keep only the newest `limit` queued characters. */
  #trimTo(limit) {
    if (this.characters.length > limit) this.characters.splice(0, this.characters.length - limit);
    this.pending = Math.min(this.pending, this.characters.length);
  }

  #clear() {
    this.pending = 0;
    this.characters.length = 0;
  }

  /** Silence what is already sounding; once per quiet stretch is enough. */
  #cut() {
    if (this.cutFired) return;
    this.cutFired = true;
    this.cuts += 1;
    this.audio.cut?.();
  }
}

/** Reads the rendered transcript and reports the characters that appeared. */
class ChatTextObserver {
  /**
   * @param {object} options
   * @param {(characters: string[]) => void} options.onCharacters
   * @param {() => boolean} [options.shouldSkipWhitespace]
   * @param {(root: Element) => boolean} [options.shouldBlipRoot] which rows speak
   * @param {Document} [options.document]
   * @param {typeof MutationObserver} [options.MutationObserver]
   */
  constructor(options) {
    this.onCharacters = options.onCharacters;
    this.shouldSkipWhitespace = options.shouldSkipWhitespace ?? (() => true);
    this.shouldBlipRoot = options.shouldBlipRoot ?? (() => true);
    this.document = options.document ?? globalThis.document;
    this.MutationObserverClass = options.MutationObserver ?? globalThis.MutationObserver;
    this.observer = null;
    /** @type {Map<Element, {head: string, length: number, count: number, grows: number}>} */
    this.seen = new Map();
    this.pending = 0;
    this.targets = new Set();
  }

  start() {
    if (this.observer !== null || this.document === undefined || this.document === null) return;
    const Observer = this.MutationObserverClass;
    if (typeof Observer !== "function") return;
    const body = this.document.body;
    if (body === null || body === undefined) {
      // A bundle may load before <body> exists; `observe(undefined)` would throw, so
      // wait for the document instead of losing the watcher.
      this.document.addEventListener?.("DOMContentLoaded", () => this.start(), { once: true });
      return;
    }
    // Whatever the transcript already shows is the baseline: a reply that mounts
    // whole (a restored session, a scrolled-in turn) animates in, it does not type.
    this.#seed(body);
    this.observer = new Observer((records) => this.#onMutations(records));
    this.observer.observe(body, { subtree: true, childList: true, characterData: true });
  }

  /** Record the current state of every flow wrapper under `body`. */
  #seed(body) {
    if (body === null || body === undefined || typeof body.querySelectorAll !== "function") return;
    const skipWhitespace = this.shouldSkipWhitespace();
    for (const root of body.querySelectorAll("[data-chat-flow-kind]")) {
      this.seen.set(root, this.#fingerprint(root, skipWhitespace));
    }
  }

  #fingerprint(root, skipWhitespace) {
    const { text, count } = readFlow(root, skipWhitespace);
    return { head: text.slice(0, TEXT_HEAD), length: text.length, count, grows: 0 };
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    this.seen.clear();
    this.targets.clear();
    this.pending = 0;
  }

  /** Forget what has been counted; the next frame counts a whole turn as new. */
  reset() {
    this.seen.clear();
    this.pending = 0;
  }

  #onMutations(records) {
    for (const record of records) {
      if (record.type === "characterData") {
        this.#countFrom(record.target);
        continue;
      }
      for (const node of record.removedNodes ?? []) {
        if (isElement(node) && this.seen.has(node)) this.seen.delete(node);
      }
      for (const node of record.addedNodes ?? []) this.#countFrom(node);
    }
    this.#flush();
  }

  #countFrom(node) {
    const root = flowRootOf(node ?? null);
    if (root === null) return;
    this.targets.add(root);
    this.pending += 1;
  }

  #flush() {
    if (this.pending === 0) return;
    this.pending = 0;
    if (this.targets.size === 0) return;
    const skipWhitespace = this.shouldSkipWhitespace();
    const characters = [];
    for (const root of this.targets) {
      const { text, count, kept } = readFlow(root, skipWhitespace);
      const head = text.slice(0, TEXT_HEAD);
      const previous = this.seen.get(root);
      // A wrapper seen for the first time already held whatever it holds: mounted
      // content, not typed content. start() seeds the transcript on screen, so a
      // root that reaches this branch appeared whole.
      if (previous === undefined) {
        this.seen.set(root, { head, length: text.length, count, grows: 0 });
        continue;
      }
      // Its text shrank, or no longer starts with what it showed before: the host
      // reused the element for other content (another conversation, a re-render of
      // markdown, a recycled row). Nothing about that is speech, and the new
      // content is only a baseline again.
      if (text.length < previous.length || !text.startsWith(previous.head)) {
        this.seen.set(root, { head, length: text.length, count, grows: 0 });
        continue;
      }
      const delta = count - previous.count;
      // A root that has grown before is typing, so its later reads may be large.
      const grows = delta > 0 ? previous.grows + 1 : previous.grows;
      this.seen.set(root, { head, length: text.length, count, grows });
      // A row the user cannot see speaks for nobody: count it, so that showing it
      // later is not mistaken for typing, but stay silent now.
      if (isExcluded(root)) continue;
      if (delta <= 0) continue;
      // A block that landed in one flush, on a root that never typed before, was
      // mounted; so was anything this large even on a root that has been typing.
      if (delta > (previous.grows === 0 ? FIRST_GROWTH_MAX : MOUNT_JUMP)) continue;
      if (!this.shouldBlipRoot(root)) continue;
      characters.push(...kept.slice(Math.max(0, kept.length - Math.min(delta, MAX_DELTA))));
    }
    this.targets.clear();
    if (this.seen.size > MAX_TRACKED) this.#prune();
    if (characters.length > 0) this.onCharacters(characters);
  }

  /** Drop wrappers the transcript no longer holds, so a long session stays bounded. */
  #prune() {
    for (const root of [...this.seen.keys()]) {
      if (this.seen.size <= MAX_TRACKED) break;
      if (root.isConnected === false) this.seen.delete(root);
    }
  }
}

module.exports = {
  BlipDriver,
  ChatTextObserver,
  countFlowText,
  countFlowCharacters,
  collectCharacters,
  readFlow,
  flowRootOf,
  MAX_DELTA,
  MAX_PENDING,
  MAX_QUEUE,
  MAX_LEAD,
  PLAYOUT_MS,
  FIRST_GROWTH_MAX,
  MOUNT_JUMP,
  DEFAULT_TAIL
};
