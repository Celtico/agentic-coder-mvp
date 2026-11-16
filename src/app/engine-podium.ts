// Benchmark de motors (Avaluació): its figures, how each is shown, and who wins each one and overall (the
// podium under the charts). Without any UI, so it can be tested.
import type { EngineBenchmark, EngineBenchmarkEngine } from '../types';

/** An engine's name as shown: Node for the native one (runs saved earlier say «natiu»). */
export const engineName = (runtime: string) => (runtime === 'native' ? 'Node' : runtime === 'cuda' ? 'CUDA' : 'Python');

// Memory always with 3 decimals (9,890, not 9,89, beside 9,889); the rest with up to 3.
export const engineNumber = (value: number | null | undefined, unit: string) => (typeof value === 'number' ? `${(Math.round(value * 1000) / 1000).toLocaleString('ca', { maximumFractionDigits: 3, ...(unit === 'GB' ? { minimumFractionDigits: 3 } : {}) })} ${unit}` : '–');

/** The figures of a run: label, value, unit, and whether less or more is better. */
export const ENGINE_CHARTS: [string, (engine: EngineBenchmarkEngine) => number | null | undefined, string, string][] = [
  ['Càrrega del model', (engine) => engine.loadSeconds, 's', 'menys és millor'],
  ['Lectura, prompt llarg', (engine) => engine.long.promptTps, 'tok/s', 'més és millor'],
  ['Generació', (engine) => engine.generationTps, 'tok/s', 'més és millor'],
  ['Primer token, prompt curt', (engine) => engine.short.firstTokenSeconds, 's', 'menys és millor'],
  ['2n missatge amb memòria cau: primer token', (engine) => engine.second.firstTokenSeconds, 's', 'menys és millor'],
  ['Memòria màxima (MLX)', (engine) => engine.peakMemoryGb, 'GB', 'menys és millor'],
];


/** Who wins each figure (any difference wins; a tie only with the same value to the 3 decimals shown), how many each engine wins, the ties, and the overall winner (null on a tie). */
export function engineWinners(report: Pick<EngineBenchmark, 'engines'>) {
  const figures = ENGINE_CHARTS.map(([label, value, unit, better]) => {
    const values = report.engines.map((engine) => ({ engine, value: value(engine) })).filter((item): item is { engine: EngineBenchmarkEngine; value: number } => typeof item.value === 'number');
    if (values.length < 2) return { label, winner: null as string | null, tie: false, entries: [] as { name: string; runtime: string; text: string }[], note: '', detail: '' };
    const lower = better === 'menys és millor';
    const sorted = [...values].sort((a, b) => (lower ? a.value - b.value : b.value - a.value));
    const [best, next] = sorted;
    const gap = Math.abs(best.value - next.value) / Math.max(Math.abs(next.value), 1e-9);
    const entries = sorted.map((item) => ({ name: item.engine.name, runtime: item.engine.runtime, text: engineNumber(item.value, unit) }));
    // Any difference wins: only the same value, to the 3 decimals shown, is a tie.
    const tie = Math.round(best.value * 1000) === Math.round(next.value * 1000);
    if (tie) {
      return { label, winner: null, tie: true, entries, note: `empat (${engineNumber(best.value, unit)})`, detail: `empat (${engineNumber(best.value, unit)})` };
    }
    // Memory as the megabytes between them; otherwise the percentage (with decimals under 1%, never «0%»).
    const percent = gap * 100;
    const amount = unit === 'GB' ? `${Math.round(Math.abs(best.value - next.value) * 1000).toLocaleString('ca')} MB` : `${(percent < 1 ? Math.round(percent * 100) / 100 : Math.round(percent)).toLocaleString('ca')}%`;
    const note = `(${amount} ${lower ? 'menys' : 'més'})`;
    return { label, winner: best.engine.name, tie: false, entries, note, detail: `${entries.map((entry) => `${entry.name} ${entry.text}`).join(' · ')} ${note}` };
  });
  const wins = report.engines.map((engine) => ({ name: engine.name, runtime: engine.runtime, wins: figures.filter((figure) => figure.winner === engine.name).length })).sort((a, b) => b.wins - a.wins);
  const ties = figures.filter((figure) => figure.tie).length;
  return { figures, wins, ties, overall: wins.length > 1 && wins[0].wins > wins[1].wins ? wins[0].name : null };
}
