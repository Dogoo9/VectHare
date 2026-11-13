export const extension_settings = {};
export const modules = [];
export function getContext() { return {}; }
export function openThirdPartyExtensionMenu() {}
export class ModuleWorkerWrapper { constructor(fn) { this.fn = fn; } update() { return this.fn(); } }
