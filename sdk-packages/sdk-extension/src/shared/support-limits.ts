// Limits for support-ticket attachments crossing the transport. Mirror of the
// backend validation (online `/api/v1/paywall/[id]/support/ticket`) and of the
// SupportGate dropzone in @monetize.software/sdk — keep the three in sync.
// Enforced on BOTH sides of the port: content fails early (before reading the
// file), offscreen re-checks staged payloads (multiple tabs share one
// offscreen document — a single misbehaving page must not exhaust its heap).
export const MAX_SUPPORT_FILES = 5;
export const MAX_SUPPORT_FILE_SIZE = 5 * 1024 * 1024;
