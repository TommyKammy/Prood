export * from "./i18n/messages.js";
export { ProodLoginFormElement, registerProodLoginForm } from "./login-form.js";
export { ProodShellElement, registerProodShell } from "./shell.js";
import { registerProodLoginForm } from "./login-form.js";
import { registerProodShell } from "./shell.js";

registerProodLoginForm();
registerProodShell();
