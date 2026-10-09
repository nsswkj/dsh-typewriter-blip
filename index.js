/**
 * Host half of the typewriter-blip bundle.
 *
 * The feature lives entirely in the page: the Client module watches the chat
 * transcript and synthesizes the blips with Web Audio. This half only exists so
 * the bundle owns a real row in the Loader tree, which is what the Plugin
 * Manager and the Settings plugin inventory display.
 */

/** @param {import('@deepseek-ai/cordis').Context} _ctx */
export function apply(_ctx) {}
