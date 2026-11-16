// Benchmark de motors (Avaluació): its figures, how each is shown, and who wins each one and overall (the
// podium under the charts). Without any UI, so it can be tested.
import type { EngineBenchmark, EngineBenchmarkEngine } from '../types';

export const engineNumber = (value: number | null | undefined, unit: string) => (typeof value === 'number' ? `${(Math.round(value * 1000) / 1000).toLocaleString('ca', { maximumFractionDigits: 3 })} ${unit}` : '–');

/** The figures of a run: label, value, unit, and whether less or more is better. */
export const ENGINE_CHARTS: [string, (engine: EngineBenchmarkEngine) => number | null | undefined, string, string][] = [
  ['Càrrega del model', (engine) => engine.loadSeconds, 's', 'menys és millor'],
  ['Lectura, prompt llarg', (engine) => engine.long.promptTps, 'tok/s', 'més és millor'],
  ['Generació', (engine) => engine.generationTps, 'tok/s', 'més és millor'],
  ['Primer token, prompt curt', (engine) => engine.short.firstTokenSeconds, 's', 'menys és millor'],
  ['2n missatge amb memòria cau: primer token', (engine) => engine.second.firstTokenSeconds, 's', 'menys és millor'],
  ['Memòria màxima (MLX)', (engine) => engine.peakMemoryGb, 'GB', 'menys és millor'],
];

/** Differences under this share of the other value are a tie; for times, also those under TIE_SECONDS. */
export const TIE_SHARE = 0.02;
export const TIE_SECONDS = 0.1;

/** Who wins each figure (a tie under 2%, or under 0,1 s for a time), how many each engine wins, the ties, and the overall winner (null on a tie). */
export function engineWinners(report: Pick<EngineBenchmark, 'engines'>) {
  const figures = ENGINE_CHARTS.map(([label, value, unit, better]) => {
    const values = report.engines.map((engine) => ({ engine, value: value(engine) })).filter((item): item is { engine: EngineBenchmarkEngine; value: number } => typeof item.value === 'number');
    if (values.length < 2) return { label, winner: null as string | null, detail: '' };
    const lower = better === 'menys és millor';
    const [best, next] = [...values].sort((a, b) => (lower ? a.value - b.value : b.value - a.value));
    const gap = Math.abs(best.value - next.value) / Math.max(Math.abs(next.value), 1e-9);
    if (gap < TIE_SHARE || (unit === 's' && Math.abs(best.value - next.value) < TIE_SECONDS)) return { label, winner: null, detail: `empat (${engineNumber(best.value, unit)})` };
    return { label, winner: best.engine.name, detail: `${best.engine.name} ${engineNumber(best.value, unit)} · ${next.engine.name} ${engineNumber(next.value, unit)} (${Math.round(gap * 100)}% ${lower ? 'menys' : 'més'})` };
  });
  const wins = report.engines.map((engine) => ({ name: engine.name, wins: figures.filter((figure) => figure.winner === engine.name).length })).sort((a, b) => b.wins - a.wins);
  const ties = figures.filter((figure) => figure.winner === null && figure.detail).length;
  return { figures, wins, ties, overall: wins.length > 1 && wins[0].wins > wins[1].wins ? wins[0].name : null };
}
