import { createFreebuffNext } from "@freebuff/auth/next";

/**
 * FREEBUFF_CLIENT_ID and APP_ORIGIN are public configuration injected by the
 * Sites platform, never secrets. When they are absent (local development
 * without Sites auth) the app falls back to APP_PASSWORD sign-in.
 */
export const freebuff =
  process.env.FREEBUFF_CLIENT_ID && process.env.APP_ORIGIN
    ? createFreebuffNext({
        clientId: process.env.FREEBUFF_CLIENT_ID,
        baseUrl: process.env.APP_ORIGIN,
        allowInsecureLocalhost: true,
      })
    : null;

export const freebuffConfigured = freebuff !== null;
