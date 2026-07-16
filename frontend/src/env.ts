export const env = {
  /** Empty keeps requests relative so Vite's proxy handles them and CORS never applies. */
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  enableDevtools: import.meta.env.VITE_ENABLE_DEVTOOLS === 'true',
} as const;
