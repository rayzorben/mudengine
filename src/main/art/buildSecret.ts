/**
 * The art server's registration secret, put in when the client is built from
 * the `ART_BUILD_SECRET` environment variable (`electron.vite.config.ts`, main
 * only) and never kept in the repository. It tells a mudengine build from a
 * casual caller and nothing more: anyone who unpacks the app can find it, and
 * the server takes no prompt text and limits every new drawing. A build made
 * without it draws no portraits and says so.
 */
declare const __ART_BUILD_SECRET__: string | undefined;

export const ART_BUILD_SECRET: string | null =
  typeof __ART_BUILD_SECRET__ === 'string' && __ART_BUILD_SECRET__.length > 0
    ? __ART_BUILD_SECRET__
    : null;
