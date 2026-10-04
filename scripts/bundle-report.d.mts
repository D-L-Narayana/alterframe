/** Type surface of scripts/bundle-report.mjs for the TypeScript tests that import it. */
export interface BudgetInput {
  totalJsGz: number;
  entryGz: number;
  budgets: { totalJsGz: number; entryGz: number };
  mediaPipeHits: string[];
}
export interface BudgetResult {
  failures: string[];
  warnings: string[];
  mediaPipeStatus: 'OK' | 'WARN' | 'FAIL';
}
export const DEFAULT_BUDGET_JS_GZ: number;
export const DEFAULT_BUDGET_ENTRY_GZ: number;
export function entryChunksOf(html: string): string[];
export function mediaPipeMarkers(code: string, sources: readonly string[]): string[];
export function evaluateBudgets(input: BudgetInput, strict: boolean): BudgetResult;
export function parseFlags(argv: readonly string[]): { strict: boolean; dir: string };
export function fmtKb(bytes: number): string;
