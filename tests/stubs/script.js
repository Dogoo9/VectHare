export function getRequestHeaders() { return {}; }
export function substituteParams(text) { return text; }
export function saveSettingsDebounced() {}
export function getCurrentChatId() { return 'test-chat'; }
export function setExtensionPrompt() {}
export const characters = [];
export const chat_metadata = {};
export const extension_prompts = {};
export const is_send_press = false;
export const eventSource = { on() {}, once() {}, emit: async () => {}, removeListener() {} };
export const event_types = new Proxy({}, { get: (_, key) => String(key) });
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
