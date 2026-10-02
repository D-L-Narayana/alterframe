import { fileURLToPath } from 'node:url';
/** Absolute path of the app root (the public payload root). Shared by W10 infra tests. */
export const APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
