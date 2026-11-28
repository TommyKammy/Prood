export * from "./i18n/messages.js";
export {
  copyFromTarget,
  createCopyControl,
  ensureCopyCommandListener,
  type CopyLabels,
} from "./clipboard.js";
export {
  extractSignedOAuthQuery,
  isSafeRedirectUrl,
  ProodLoginFormElement,
  registerProodLoginForm,
} from "./login-form.js";
export {
  ProodShellElement,
  registerProodShell,
  type ShellAuthState,
  type ShellView,
} from "./shell.js";
import { registerProodLoginForm } from "./login-form.js";
import { registerProodShell } from "./shell.js";

registerProodLoginForm();
registerProodShell();
