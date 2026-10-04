/** Type surface of scripts/serve-dist.mjs for the TypeScript tests that import it. */
export interface VercelHeader { key: string; value: string }
export interface VercelConfig {
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  headers?: { source: string; headers: VercelHeader[] }[];
  rewrites?: { source: string; destination: string }[];
}
export type Resolution =
  | { kind: 'file'; status: 200; file: string; pathname: string; rewritten: boolean }
  | { kind: 'redirect'; status: 308; location: string; pathname: string }
  | { kind: 'notfound'; status: 404; pathname: string }
  | { kind: 'badrequest'; status: 400; pathname: string };
export interface ServeArgs { port: number; host: string; dir: string; config: string }
export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}
export const DEFAULT_CACHE_CONTROL: string;
export function loadVercelConfig(path: string): VercelConfig;
export function vercelSourceToRegExp(source: string): RegExp;
export function headersFor(pathname: string, cfg: VercelConfig): Record<string, string>;
export function resolveRequest(rawUrl: string, cfg: VercelConfig, exists: (rel: string) => boolean): Resolution;
export function contentTypeFor(file: string): string;
export function parseArgs(argv: readonly string[]): ServeArgs;
export function startServer(opts: { dir: string; host: string; port: number; config: VercelConfig | null; log?: (line: string) => void }): Promise<RunningServer>;
