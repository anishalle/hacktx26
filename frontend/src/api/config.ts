/** The shared dev API on the homelab by default; set EXPO_PUBLIC_API_URL for a local backend. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://hacktx26.anishalle.com/api/v1').replace(/\/+$/, '');

/** `ws://host:port/api/v1/ws` — the realtime path is relative to the API base like every other path. */
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';

export const USE_MOCKS = process.env.EXPO_PUBLIC_USE_MOCKS === '1';
