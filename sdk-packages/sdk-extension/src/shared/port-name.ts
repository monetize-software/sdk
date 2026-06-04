// Port name for chrome.runtime.connect. Filters out foreign connections so the
// SW-forwarder and offscreen-server only listen to their own. If the host uses
// runtime.connect for its own logic — there will be no false triggers.
export const PORT_NAME = '@monetize.software/sdk-extension';

// A separate name for the SW→offscreen relay-port. Needed because
// chrome.runtime.connect from a popup/extension-page is delivered to ALL
// extension contexts with an onConnect listener — including offscreen directly,
// bypassing the SW. Without separate names, a single popup.connect() creates TWO
// ports in offscreen (SW relay + direct), one send from the popup arrives twice
// → the handler is duplicated. Offscreen accepts only RELAY_PORT_NAME; direct
// PORT_NAME connects to it are ignored.
export const RELAY_PORT_NAME = '@monetize.software/sdk-extension/relay';
