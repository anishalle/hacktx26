import { USE_MOCKS } from './config';
import { mockApi } from './mock';
import { realApi } from './real';
import type { Api } from './types';

/** The API client. Real backend by default; in-process mocks when EXPO_PUBLIC_USE_MOCKS=1. */
export const api: Api = USE_MOCKS ? mockApi : realApi;

export { API_URL, USE_MOCKS } from './config';
export { ApiError } from './real';
export * from './types';
