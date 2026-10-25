export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/+$/, '');

/** `ws://host:port/api/v1/ws` — the realtime path is relative to the API base like every other path. */
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';

export const USE_MOCKS = process.env.EXPO_PUBLIC_USE_MOCKS === '1';
