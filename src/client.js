const React = require("react");
const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;
// Placement is a layout concern: doing it after paint would show the panel at its
// static position (beside the button) for a frame before it jumps into place.
const usePlacement = React.useLayoutEffect ?? React.useEffect;

const { SettingsStore } = settings;
const { PRESETS, PRESET_ORDER, CUSTOM_WAVES } = voices;
const { BlipAudio } = audio;
const { BlipDriver, ChatTextObserver } = observer;

const BUTTON_ID = "typewriter-blip";
const PANEL_ID = "typewriter-blip-panel";
const STYLE_ID = "typewriter-blip/style.css";
const PANEL_WIDTH = 306;
/** Fallback size for the first paint, before the panel has been measured. */
const PANEL_HEIGHT = 360;
/** Breathing room between the panel, the button, and the window edge. */
const PANEL_GAP = 8;
const PANEL_EDGE = 8;
/** Never cap the panel shallower than this, however cramped the window is. */
const PANEL_MIN_ROOM = 180;
/** Panel entry/exit animation, in ms — the stylesheet below uses the same numbers. */
const PANEL_ENTER_MS = 180;
const PANEL_EXIT_MS = 140;
/** Ease-out: fast at the start, settling gently. */
const PANEL_EASE_OUT = "cubic-bezier(.16,1,.3,1)";
/** Where the custom voice takes its sound from. */
const CUSTOM_SOURCES = [
  { id: "synth", label: "合成音色" },
  { id: "sample", label: "音频文件" }
];
/** Preview run for 试听: a few characters, so a voice is recognisable at once. */
const PREVIEW_TEXT = "说话音效";
const PREVIEW_STEP = 0.13;
/** Breath added after the last preview blip before 试听 unlocks again. */
const PREVIEW_TAIL_MS = 120;
/**
 * The runtime's second clock.
 *
 * An animation frame is the good clock — it lands on a paint and costs nothing while the
 * page sits idle — and it is also the first thing a background page loses: a hidden tab
 * and an occluded or minimized window both stop producing frames, and clamp timers to
 * about a second. This timer notices that the frames stopped and takes over; on a
 * visible page it never fires at all, because a frame always arrives first.
 */
const GUARD_INTERVAL_MS = 250;
/** No frame for this long means the page is in the background and the timer owns it. */
const GUARD_STARVED_MS = 400;
/**
 * Lead the driver keeps while the page is hidden, in seconds.
 *
 * A hidden page's wake-ups are up to a second apart, so the scheduler has to hand the
 * audio clock that much sound in one go. Saying it up front — rather than letting the
 * first coarse tick discover it — is what keeps the first second of a background answer
 * from stuttering.
 */
const BACKGROUND_LEAD_SECONDS = 1.4;

const CSS = `
.twb-root{position:relative;display:inline-flex;align-items:center}
.twb-button{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.twb-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.twb-button[aria-expanded="true"]{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.twb-button[data-on="true"]{color:var(--dsw-alias-brand-primary)}
.twb-glyph{font-size:12px;line-height:1}
.twb-panel{position:absolute;z-index:20;width:${PANEL_WIDTH}px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;box-sizing:border-box;padding:12px;border-radius:12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px var(--dsw-alias-bg-mask-drop));color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px;transform-origin:bottom center;animation:twb-panel-in ${PANEL_ENTER_MS}ms ${PANEL_EASE_OUT} both}
@keyframes twb-panel-in{from{opacity:0;transform:translateY(var(--twb-panel-shift,6px)) scale(.97)}to{opacity:1;transform:none}}
@keyframes twb-panel-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(var(--twb-panel-shift,6px)) scale(.97)}}
.twb-panel[data-side="below"]{transform-origin:top center}
.twb-panel[data-leaving="true"]{animation:twb-panel-out ${PANEL_EXIT_MS}ms ease-in forwards;pointer-events:none}
@media (prefers-reduced-motion: reduce){.twb-panel,.twb-panel[data-leaving="true"]{animation:none}}
.twb-head{display:flex;align-items:baseline;gap:8px}
.twb-title{font-size:13px;font-weight:600}
.twb-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1}
.twb-close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.twb-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.twb-section{display:flex;flex-direction:column;gap:7px}
.twb-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.twb-chiprow{display:flex;flex-wrap:wrap;gap:6px}
.twb-chip{padding:5px 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.twb-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.twb-chip[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.twb-row{display:flex;align-items:center;gap:10px}
.twb-row-label{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1}
.twb-row-label[title]{cursor:help}
.twb-value{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:40px;text-align:right}
.twb-caption{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.twb-caption[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.twb-caption[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.twb-switch{width:34px;height:20px;padding:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);position:relative;cursor:pointer;flex:none;transition:background .15s ease}
.twb-switch[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill)}
.twb-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base));transition:transform .15s ease}
.twb-switch[aria-checked="true"]::after{transform:translateX(14px)}
.twb-slider{-webkit-appearance:none;appearance:none;height:3px;flex:1;border-radius:999px;background:var(--dsw-alias-border-l3);outline:none}
.twb-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:0;cursor:pointer}
.twb-actions{display:flex;align-items:center;gap:8px}
.twb-action{padding:6px 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.twb-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.twb-action[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.twb-action[data-variant="primary"]:hover{background:var(--dsw-alias-button-primary-hover)}
.twb-action[disabled]{opacity:.55;cursor:default}
.twb-action[disabled]:hover{background:var(--dsw-alias-button-primary-fill)}
.twb-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.twb-hidden{display:none}
`;

function ensureStyles(document) {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "@local/dsh-typewriter-blip";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

function createAudioContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (typeof Ctor !== "function") throw new Error("Web Audio is not available in this page");
  return new Ctor();
}

function formatRate(rate) {
  return `${rate.toFixed(2)}x`;
}

function formatPitch(pitch) {
  return `${pitch > 0 ? "+" : ""}${pitch} st`;
}

function formatInterval(interval) {
  return `${interval} ms`;
}

function formatHertz(value) {
  return `${Math.round(value)} Hz`;
}

/** Read a picked file as a data URL so the choice survives a reload. */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** One labelled slider row; the panel is mostly these, so they share a shape. */
function sliderRow(options) {
  const { label, hint, min, max, step, value, display, onChange } = options;
  return h(
    "div",
    { className: "twb-row" },
    h("span", { className: "twb-row-label", title: hint }, label),
    h("input", {
      className: "twb-slider",
      type: "range",
      min,
      max,
      step,
      value,
      "aria-label": label,
      onChange: (event) => onChange(Number(event.target.value))
    }),
    h("span", { className: "twb-value" }, display)
  );
}

/** One labelled switch row. */
function switchRow(options) {
  const { label, hint, checked, onChange } = options;
  return h(
    "div",
    { className: "twb-row" },
    h("span", { className: "twb-row-label", title: hint }, label),
    h("button", {
      type: "button",
      className: "twb-switch",
      role: "switch",
      "aria-checked": checked,
      "aria-label": label,
      title: hint,
      onClick: () => onChange(!checked)
    })
  );
}

/**
 * The panel's size as LAYOUT px, which is the only size placement may use.
 *
 * Not `getBoundingClientRect()`: the entry animation scales the panel, and the rect
 * reports that animated box, so measuring through it placed the panel ~3% too low
 * (its real bottom overlapped the button). The panel only snapped back up once a
 * later re-place happened to measure the settled layout — which is exactly the
 * "click it once and it jumps into place" the user saw. The offset box ignores
 * transforms and animations.
 */
function measurePanel(panel) {
  const rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
  return {
    width: panel.offsetWidth || rect?.width || PANEL_WIDTH,
    height: panel.offsetHeight || rect?.height || PANEL_HEIGHT
  };
}

/**
 * Where the settings panel goes, in `.twb-root`-local coordinates.
 *
 * The panel is `position:absolute` inside the dock root, so a viewport Y is NOT a
 * usable `top`: the root sits on the bottom edge of the window, and writing a page
 * coordinate there adds the button's own offset on top — which is what used to
 * push the panel off the bottom of the screen. Everything here is pure so the
 * offline harness can pin the arithmetic.
 */
function placePanel(options) {
  const anchorTop = options.anchorTop;
  const anchorBottom = options.anchorBottom;
  const anchorLeft = options.anchorLeft;
  const viewportWidth = options.viewportWidth;
  const viewportHeight = options.viewportHeight;
  const panelWidth = options.panelWidth || PANEL_WIDTH;
  const panelHeight = options.panelHeight || PANEL_HEIGHT;

  const roomAbove = anchorTop - PANEL_GAP - PANEL_EDGE;
  const roomBelow = viewportHeight - anchorBottom - PANEL_GAP - PANEL_EDGE;
  // Above by preference: the composer lives on the bottom edge, so hanging a tall
  // panel below the button is how it ends up outside the window.
  const up = roomAbove >= Math.min(panelHeight, PANEL_MIN_ROOM) || roomAbove >= roomBelow;
  const room = Math.max(PANEL_MIN_ROOM, up ? roomAbove : roomBelow);
  const height = Math.min(panelHeight, room);
  const pageTop = up ? anchorTop - PANEL_GAP - height : anchorBottom + PANEL_GAP;

  // Clamp in page space, then rebase onto the button for the actual `top`/`left`.
  const minTop = PANEL_EDGE - anchorTop;
  const maxTop = Math.max(minTop, viewportHeight - PANEL_EDGE - height - anchorTop);
  const localTop = Math.min(Math.max(minTop, pageTop - anchorTop), maxTop);
  const pageLeft = Math.min(
    Math.max(PANEL_EDGE, anchorLeft),
    Math.max(PANEL_EDGE, viewportWidth - PANEL_EDGE - panelWidth)
  );

  return {
    up,
    localTop: Math.round(localTop),
    localLeft: Math.round(pageLeft - anchorLeft),
    maxHeight: Math.round(room)
  };
}

/**
 * The 试听 button's label. A run locks the button until the last character has
 * finished, so the label names the lock instead of leaving a dead-looking button.
 */
function previewLabel(previewing) {
  return previewing ? "试听中…" : "试听";
}

function Panel(props) {
  const { store, audio, driver, anchor, onClose, leaving } = props;
  const [settings, setSettings] = useState(store.get());
  const [status, setStatus] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const fileRef = useRef(null);
  const panelRef = useRef(null);
  const previewTimer = useRef(0);
  /** Claimed synchronously by 试听 so two clicks cannot start two runs. */
  const previewingRef = useRef(false);
  const custom = settings.custom;
  const sampleMissing = settings.preset === "custom" && custom.source === "sample" && audio.sampleBuffer === null;
  const notice =
    status ?? (sampleMissing ? { tone: "error", text: "自定义音频文件还没载入：点「选择音频文件」" } : null);

  useEffect(() => store.subscribe(setSettings), [store]);

  // Place against the real panel size: the composer sits at the bottom of the
  // window, so the panel opens above the button and shrinks to the room it has.
  usePlacement(() => {
    const panel = panelRef.current;
    if (panel === null || anchor === null || anchor === undefined) return undefined;
    const place = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const size = measurePanel(panel);
      const next = placePanel({
        anchorTop: anchorRect.top,
        anchorBottom: anchorRect.bottom,
        anchorLeft: anchorRect.left,
        viewportWidth: window.innerWidth || 0,
        viewportHeight: window.innerHeight || 0,
        panelWidth: size.width,
        panelHeight: size.height
      });
      panel.style.top = `${next.localTop}px`;
      panel.style.left = `${next.localLeft}px`;
      // The entry animation slides in from the button's side, so it has to know
      // which side that is. Transform-only, so this cannot feed the observer back.
      panel.dataset.side = next.up ? "above" : "below";
      panel.style.setProperty("--twb-panel-shift", next.up ? "6px" : "-6px");
      // Write the cap only on change: the panel is resize-observed, and rewriting
      // the same max-height would feed the observer its own notification.
      const maxHeight = `${next.maxHeight}px`;
      if (panel.style.maxHeight !== maxHeight) panel.style.maxHeight = maxHeight;
    };
    place();
    window.addEventListener("resize", place);
    // Settle once the entry animation is over: whatever the animation did to the
    // panel, the final position is measured from the quiet layout.
    panel.addEventListener("animationend", place);
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    resizeObserver?.observe(panel);
    // The host can reflow the dock under an open panel (zoom, layout, a wider
    // composer), and the panel is anchored to the button, so watch it too.
    resizeObserver?.observe(anchor);
    return () => {
      window.removeEventListener("resize", place);
      panel.removeEventListener("animationend", place);
      resizeObserver?.disconnect();
    };
  }, [anchor, status, settings.preset, settings.sampleName, custom.source]);

  // Custom samples are decoded once per chosen data URL.
  useEffect(() => {
    if (settings.sampleDataUrl === "") return undefined;
    let alive = true;
    audio.loadSample(settings.sampleDataUrl).then((ok) => {
      if (alive && !ok) setStatus({ tone: "error", text: "无法解码这个音频文件" });
    });
    return () => {
      alive = false;
    };
  }, [audio, settings.sampleDataUrl]);

  const update = useCallback(
    (patch) => {
      store.set(patch);
    },
    [store]
  );

  // Touching a custom control means "I want this voice", so it selects itself.
  const updateCustom = useCallback(
    (patch) => {
      store.set({ custom: { ...store.get().custom, ...patch }, preset: "custom" });
    },
    [store]
  );

  const test = useCallback(() => {
    // "必须听完才能再点": one run at a time. The ref is claimed synchronously, so a
    // double click cannot start two runs while the first is still opening the graph.
    if (previewingRef.current) return;
    previewingRef.current = true;
    const fail = (text) => {
      previewingRef.current = false;
      setStatus({ tone: "error", text });
    };
    setStatus(null);
    // This click is the gesture, so the graph can be opened right here.
    try {
      audio.ensure();
    } catch {
      fail("这个页面不支持 Web Audio，无法发声");
      return;
    }
    audio.resume().then((running) => {
      if (!running) {
        fail("浏览器还没允许播放，请再点一下页面");
        return;
      }
      audio.applySettings();
      // A few characters, spaced out, so one press says what the voice sounds like.
      const start = audio.ensure().currentTime + 0.02;
      let at = start;
      let last = -1;
      for (const character of PREVIEW_TEXT) {
        if (audio.play(character, at)) last = at;
        at += PREVIEW_STEP;
      }
      if (last < 0) {
        if (settings.enabled === false) {
          fail("音效已关闭：先打开上面的「启用」");
          return;
        }
        fail(settings.preset === "custom" && custom.source === "sample" ? "还没有选择自定义音频文件" : "播放失败，请查看控制台");
        return;
      }
      // Locked until the last character has finished sounding. The hold also keeps
      // the driver's tail cutoff away: no characters arrive during a preview, so as
      // far as it knows the answer stopped and it would cut the run off mid-word.
      const span = last - start + audio.blipSeconds();
      driver.hold(span + PREVIEW_TAIL_MS / 1000);
      setPreviewing(true);
      clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => {
        previewingRef.current = false;
        setPreviewing(false);
      }, Math.round(span * 1000) + PREVIEW_TAIL_MS);
    });
  }, [audio, driver, settings.preset, custom.source]);

  // A preview that outlives the panel must not fire its timer at a dead component.
  useEffect(() => () => clearTimeout(previewTimer.current), []);

  const pickPreset = useCallback(
    (id) => {
      setStatus(null);
      update({ preset: id });
    },
    [update]
  );

  const pickSource = useCallback(
    (id) => {
      setStatus(null);
      updateCustom({ source: id });
      // Choosing "audio file" with nothing loaded is a request to load one.
      if (id === "sample" && store.get().sampleDataUrl === "") fileRef.current?.click();
    },
    [store, updateCustom]
  );

  const onFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file === undefined) return;
      try {
        const dataUrl = await readAsDataUrl(file);
        store.set({
          sampleDataUrl: dataUrl,
          sampleName: file.name,
          preset: "custom",
          custom: { ...store.get().custom, source: "sample" }
        });
        setStatus({ tone: "ok", text: `已载入 ${file.name}` });
      } catch {
        setStatus({ tone: "error", text: "读取文件失败" });
      }
    },
    [store]
  );

  const customSection = h(
    "div",
    { className: "twb-section" },
    h("span", { className: "twb-label" }, "自定义音色"),
    h(
      "div",
      { className: "twb-chiprow" },
      CUSTOM_SOURCES.map((source) =>
        h(
          "button",
          {
            key: source.id,
            type: "button",
            className: "twb-chip",
            "aria-pressed": custom.source === source.id,
            onClick: () => pickSource(source.id)
          },
          source.label
        )
      )
    ),
    custom.source === "synth"
      ? h(
          "div",
          { className: "twb-section" },
          h(
            "div",
            { className: "twb-chiprow" },
            CUSTOM_WAVES.map((wave) =>
              h(
                "button",
                {
                  key: wave.id,
                  type: "button",
                  className: "twb-chip",
                  "aria-pressed": custom.wave === wave.id,
                  onClick: () => updateCustom({ wave: wave.id })
                },
                wave.label
              )
            )
          ),
          sliderRow({
            label: "基频",
            hint: "这个音有多高",
            min: 150,
            max: 1500,
            step: 10,
            value: custom.freq,
            display: formatHertz(custom.freq),
            onChange: (freq) => updateCustom({ freq })
          }),
          sliderRow({
            label: "音长",
            hint: "每个字响多久",
            min: 10,
            max: 200,
            step: 5,
            value: Math.round(custom.duration * 1000),
            display: `${Math.round(custom.duration * 1000)} ms`,
            onChange: (ms) => updateCustom({ duration: ms / 1000 })
          }),
          sliderRow({
            label: "亮度",
            hint: "越高越清脆，越低越闷",
            min: 800,
            max: 8000,
            step: 100,
            value: custom.filter,
            display: formatHertz(custom.filter),
            onChange: (filter) => updateCustom({ filter })
          })
        )
      : h(
          "div",
          { className: "twb-section" },
          h(
            "div",
            { className: "twb-actions" },
            h(
              "button",
              { type: "button", className: "twb-action", onClick: () => fileRef.current?.click() },
              "选择音频文件"
            ),
            h("span", { className: "twb-value" }, settings.sampleName === "" ? "未选择" : settings.sampleName)
          ),
          sliderRow({
            label: "播放速度",
            hint: "加快或放慢这段音频",
            min: 0.5,
            max: 2,
            step: 0.05,
            value: settings.rate,
            display: formatRate(settings.rate),
            onChange: (rate) => update({ rate, preset: "custom" })
          }),
          h("div", { className: "twb-caption" }, "常见的短促哔声文件效果最好；每个字最多播 0.6 秒。")
        ),
    h("div", { className: "twb-caption" }, "改动这里会自动切到「自定义」音色。")
  );

  return h(
    "div",
    {
      className: "twb-panel",
      id: PANEL_ID,
      ref: panelRef,
      role: "dialog",
      "aria-label": "说话音效设置",
      "data-leaving": leaving ? "true" : undefined
    },
    h(
      "div",
      { className: "twb-head" },
      h("span", { className: "twb-title" }, "说话音效"),
      h("span", { className: "twb-sub" }, "回答时逐字发声"),
      h("button", { type: "button", className: "twb-close", onClick: onClose, "aria-label": "收起" }, "✕")
    ),
    switchRow({
      label: "启用",
      checked: settings.enabled,
      onChange: (enabled) => update({ enabled })
    }),
    h(
      "div",
      { className: "twb-section" },
      h("span", { className: "twb-label" }, "音色"),
      h(
        "div",
        { className: "twb-chiprow" },
        PRESET_ORDER.map((id) =>
          h(
            "button",
            {
              key: id,
              type: "button",
              className: "twb-chip",
              title: PRESETS[id].hint,
              "aria-pressed": settings.preset === id,
              onClick: () => pickPreset(id)
            },
            PRESETS[id].label
          )
        )
      )
    ),
    customSection,
    h(
      "div",
      { className: "twb-section" },
      h("span", { className: "twb-label" }, "音量与节奏"),
      sliderRow({
        label: "音高",
        hint: "整体升降调，±12 半音",
        min: -12,
        max: 12,
        step: 1,
        value: settings.pitch,
        display: formatPitch(settings.pitch),
        onChange: (pitch) => update({ pitch })
      }),
      sliderRow({
        label: "音量",
        min: 0,
        max: 1,
        step: 0.01,
        value: settings.volume,
        display: `${Math.round(settings.volume * 100)}%`,
        onChange: (volume) => update({ volume })
      }),
      sliderRow({
        label: "最小间隔",
        hint: "两个字之间至少隔多久；越小越密",
        min: 0,
        max: 200,
        step: 5,
        value: settings.interval,
        display: formatInterval(settings.interval),
        onChange: (interval) => update({ interval })
      }),
      sliderRow({
        label: "说完即停",
        hint: "最后一个字之后多久停声；越小停得越干脆",
        min: 20,
        max: 600,
        step: 10,
        value: settings.tail,
        display: formatInterval(settings.tail),
        onChange: (tail) => update({ tail })
      })
    ),
    h(
      "div",
      { className: "twb-section" },
      h("span", { className: "twb-label" }, "行为"),
      switchRow({
        label: "跳过空格",
        hint: "空格、换行不发声",
        checked: settings.skipWhitespace,
        onChange: (skipWhitespace) => update({ skipWhitespace })
      }),
      switchRow({
        label: "只对回答发声",
        hint: "工具调用、思考过程和你的消息都不发声，进入对话时也不会响",
        checked: settings.answerOnly,
        onChange: (answerOnly) => update({ answerOnly })
      }),
      sliderRow({
        label: "随机音高",
        hint: "每个音随机偏移多少半音，让声音更自然",
        min: 0,
        max: 2,
        step: 0.05,
        value: settings.jitter,
        display: `${settings.jitter.toFixed(2)} st`,
        onChange: (jitter) => update({ jitter })
      })
    ),
    notice !== null ? h("div", { className: "twb-caption", "data-tone": notice.tone }, notice.text) : null,
    h(
      "div",
      { className: "twb-foot" },
      h(
        "div",
        { className: "twb-actions" },
        h(
          "button",
          {
            type: "button",
            className: "twb-action",
            "data-variant": "primary",
            "data-previewing": previewing,
            disabled: previewing,
            onClick: test
          },
          previewLabel(previewing)
        ),
        h("button", { type: "button", className: "twb-action", onClick: () => store.reset() }, "恢复默认")
      ),
      h("span", { className: "twb-caption" }, "设置自动保存")
    ),
    h("input", {
      ref: fileRef,
      className: "twb-hidden",
      type: "file",
      accept: "audio/*",
      onChange: onFile,
      "aria-hidden": true,
      tabIndex: -1
    })
  );
}

/**
 * The panel's open/close state machine: closed → open → leaving → closed.
 *
 * Closing has to keep the panel mounted for one more animation, so "the user asked
 * to close" and "the panel is gone" are two different states. Pure, so the exit
 * path can be checked offline without a browser.
 */
function nextPhase(phase, action) {
  if (action === "toggle") return phase === "open" ? "leaving" : "open";
  if (action === "close") return phase === "open" ? "leaving" : phase;
  if (action === "settle") return phase === "leaving" ? "closed" : phase;
  return phase;
}

function Dock(props) {
  const [phase, setPhase] = useState("closed");
  const [settings, setSettings] = useState(props.store.get());
  const rootRef = useRef(null);
  const open = phase !== "closed";

  useEffect(() => props.store.subscribe(setSettings), [props.store]);

  const dispatch = useCallback((action) => setPhase((current) => nextPhase(current, action)), []);

  // Escape or an outside pointer starts the exit; the panel unmounts once the
  // animation has actually played, so closing fades out instead of blinking away.
  useEffect(() => {
    if (phase === "closed") return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") dispatch("close");
    };
    const onPointer = (event) => {
      if (rootRef.current?.contains(event.target) === true) return;
      dispatch("close");
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [phase, dispatch]);

  useEffect(() => {
    if (phase !== "leaving") return undefined;
    const timer = setTimeout(() => dispatch("settle"), PANEL_EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase, dispatch]);

  const toggle = useCallback(() => dispatch("toggle"), [dispatch]);
  const close = useCallback(() => dispatch("close"), [dispatch]);

  return h(
    "div",
    { className: "twb-root", ref: rootRef },
    h(
      "button",
      {
        type: "button",
        id: BUTTON_ID,
        className: "twb-button",
        "data-on": settings.enabled,
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "aria-controls": open ? PANEL_ID : undefined,
        title: "说话音效：回答时逐字发声",
        onClick: toggle
      },
      h("span", { className: "twb-glyph", "aria-hidden": true }, "♪"),
      h("span", null, "说话音效")
    ),
    open
      ? h(Panel, {
          store: props.store,
          audio: props.audio,
          driver: props.driver,
          anchor: rootRef.current,
          leaving: phase === "leaving",
          onClose: close
        })
      : null
  );
}

const plugin = {
  inject: ["slots"],
  apply(ctx) {
    const document = globalThis.document;
    if (document === undefined || document === null) return;
    // A client bundle may run before <body> exists (immediately-loaded modules sit
    // in the startup batch). Touching the DOM then throws out of the module
    // factory and can take the whole page boot down with it, so wait instead.
    if (document.body === undefined || document.body === null) {
      document.addEventListener?.("DOMContentLoaded", () => plugin.apply(ctx), { once: true });
      return;
    }
    ensureStyles(document);

    const store = new SettingsStore(globalThis.localStorage ?? null);
    const contexts = [];
    const audio = new BlipAudio({
      createContext: () => {
        const context = createAudioContext();
        contexts.push(context);
        return context;
      },
      getSettings: () => store.get()
    });
    const driver = new BlipDriver({ audio, getSettings: () => store.get() });
    let frame = 0;
    let lastFrame = 0;
    let lastPulse = 0;
    let lastText = 0;

    /**
     * One scheduler wake-up, whichever clock produced it.
     *
     * `idleMs` is measured from the last character rather than accumulated per tick: a
     * coarse wake-up covers text and silence at once, and a driver that counted the
     * whole gap as quiet would cut the answer it is still being handed.
     */
    const pulse = () => {
      const now = performance.now();
      lastPulse = now;
      const elapsed = lastFrame === 0 ? 0 : now - lastFrame;
      lastFrame = now;
      driver.tick(elapsed, lastText === 0 ? undefined : now - lastText);
    };

    /** Forget the wall clock: the next wake-up measures from here, not from the gap. */
    const restartClock = () => {
      lastFrame = 0;
      lastPulse = performance.now();
    };

    const observer = new ChatTextObserver({
      onCharacters: (characters) => {
        lastText = performance.now();
        driver.push(characters);
        // A hidden page's timers can be throttled to a wake-up a minute, long after the
        // answer is over. Text arriving is its own wake-up call.
        if (document.hidden === true) pulse();
      },
      shouldSkipWhitespace: () => store.get().skipWhitespace,
      // "只对回答发声": the answer text is the row kind the Conversation layer gives
      // the assistant's own prose. Its thinking half carries `reasoning` in the
      // group part, and tool rows are `turn-process`; neither is speech.
      shouldBlipRoot: (root) => {
        if (!store.get().answerOnly) return true;
        if (attribute(root, "data-chat-flow-kind") !== "assistant-step") return false;
        return attribute(root, "data-chat-group-part") !== "reasoning";
      }
    });

    // Sound may only start after a gesture, so a context that was opened without one —
    // or that the browser suspended while the page was in the background — is resumed
    // here. Resuming a context that is already running is free.
    const wake = () => {
      audio.resume().then((ok) => {
        if (ok) audio.applySettings();
      });
    };

    // A page may only open audio during a gesture. Opening the graph here — not
    // waiting for the first blip — is what keeps the very first character audible:
    // a context created outside a gesture starts suspended and would drop it.
    const unlock = () => {
      try {
        audio.ensure();
      } catch {
        return; // no Web Audio in this page; the panel reports it on 试听
      }
      wake();
    };
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });

    store.subscribe(() => audio.applySettings());

    const loop = () => {
      frame = requestAnimationFrame(loop);
      // The driver owns the tail: it trims the queue and cuts ringing voices once the
      // text has been quiet for a whole `说完即停` window.
      pulse();
    };

    // Frames are the good clock and they stop first, so a slow timer watches them.
    // Whatever a hidden page does to timers, it cannot stop the audio clock, and the
    // lead the driver measures from these gaps is what keeps that clock fed.
    const guard = setInterval(() => {
      if (performance.now() - lastPulse < GUARD_STARVED_MS) return;
      wake();
      pulse();
    }, GUARD_INTERVAL_MS);

    const onVisibility = () => {
      const hidden = document.hidden === true;
      // Hidden: the clock is about to become coarse, so buffer a whole wake-up. Back in
      // front: drop to the frame-rate lead, restart the measurement — the gap spent in
      // the background says nothing about the clock the driver is on now — and resume
      // whatever was suspended while nobody was watching.
      driver.setLead(hidden ? BACKGROUND_LEAD_SECONDS : 0);
      if (hidden) {
        pulse();
        return;
      }
      restartClock();
      wake();
      pulse();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // The page may already have opened hidden (a background tab that restores a session).
    driver.setLead(document.hidden === true ? BACKGROUND_LEAD_SECONDS : 0);

    const dispose = [];
    dispose.push(() => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    });
    dispose.push(() => cancelAnimationFrame(frame));
    dispose.push(() => clearInterval(guard));
    dispose.push(() => observer.stop());
    dispose.push(() => audio.dispose());
    dispose.push(
      ctx.effect(() => {
        const registration = ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            { name: "conversation.composer.dock", id: BUTTON_ID, order: 40 },
            (props) => h(Dock, { ...props, store, audio, driver })
          )
        );
        return () => registration?.();
      }, "typewriter-blip: composer dock")
    );

    observer.start();
    frame = requestAnimationFrame(loop);

    ctx.effect(
      () => () => {
        for (const off of dispose.reverse()) off();
      },
      "typewriter-blip: runtime"
    );

    // Seam for the offline harness: the components read these live instances, and
    // there is no other way to drive them without a real browser.
    plugin.__test__ = {
      store,
      audio,
      driver,
      observer,
      /** One scheduler wake-up, so the harness can drive it without a real clock. */
      pulse,
      components: { Dock, Panel },
      placePanel,
      measurePanel,
      nextPhase,
      previewLabel,
      contexts: () => [...contexts]
    };
  }
};

/** Read a data attribute without assuming the node is a real DOM element. */
function attribute(node, name) {
  return typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
}

module.exports = plugin;
