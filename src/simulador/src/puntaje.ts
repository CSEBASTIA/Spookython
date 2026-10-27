// Métricas de latencia y puntaje estimado con la rúbrica de la prueba de fuego (sección 10 del plan).
import type { MetricasLatencia, Puntaje, ResultadoRonda } from '../../compartido/src/tipos.js';

export const LIMITE_PASO_MS = 500;
const PESO_RONDA: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 3 };

function percentil(ordenados: readonly number[], p: number): number | null {
  if (ordenados.length === 0) return null;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1));
  return Math.round(ordenados[i]! * 10) / 10;
}

export function resumirLatencias(tiempos: readonly number[], errores: number, fueraDeTiempo: number): MetricasLatencia {
  const ordenados = [...tiempos].sort((a, b) => a - b);
  return {
    pedidos: tiempos.length,
    errores,
    fueraDeTiempo,
    p50: percentil(ordenados, 50),
    p95: percentil(ordenados, 95),
    p99: percentil(ordenados, 99),
  };
}

/** p95 ≤ 150 ms → 10 · ≤ 300 → 7 · ≤ 500 → 4 · más → 0 */
export function notaLatencia(p95: number | null): number {
  if (p95 === null) return 0;
  return p95 <= 150 ? 10 : p95 <= 300 ? 7 : p95 <= 500 ? 4 : 0;
}

/** Errores o fuera de tiempo: < 0,5 % → 10 · < 2 % → 6 · < 5 % → 3 · más → 0 */
export function notaDisponibilidad(fallidos: number, pedidos: number): number {
  if (pedidos === 0) return 0;
  const tasa = fallidos / pedidos;
  return tasa < 0.005 ? 10 : tasa < 0.02 ? 6 : tasa < 0.05 ? 3 : 0;
}

/**
 * Puntaje con la última corrida de cada ronda. Si falta alguna ronda, la supervivencia
 * se pondera solo con las que hay (en la prueba real entran las 3: R1 ×1, R2 ×2, R3 ×3).
 */
export function calcularPuntaje(resultados: readonly ResultadoRonda[]): Puntaje | null {
  if (resultados.length === 0) return null;
  let pesoTotal = 0;
  let supervivencia = 0;
  let eficienciaSuma = 0;
  let salvados = 0;
  let pedidos = 0;
  let fallidos = 0;
  let peorP95: number | null = null;
  for (const r of resultados) {
    const peso = PESO_RONDA[r.ronda] ?? 1;
    pesoTotal += peso;
    supervivencia += peso * (r.total > 0 ? r.salvados / r.total : 0);
    if (r.eficiencia !== null) {
      eficienciaSuma += r.eficiencia * r.salvados;
      salvados += r.salvados;
    }
    pedidos += r.latencia.pedidos;
    fallidos += r.latencia.errores + r.latencia.fueraDeTiempo;
    if (r.latencia.p95 !== null) peorP95 = Math.max(peorP95 ?? 0, r.latencia.p95);
  }
  const s = (10 * supervivencia) / pesoTotal;
  const e = salvados > 0 ? (10 * eficienciaSuma) / salvados : 0;
  const l = notaLatencia(peorP95);
  const d = notaDisponibilidad(fallidos, pedidos);
  const redondear = (x: number) => Math.round(x * 100) / 100;
  return {
    supervivencia: redondear(s),
    eficiencia: redondear(e),
    latencia: l,
    disponibilidad: d,
    total: redondear(0.5 * s + 0.2 * e + 0.15 * l + 0.15 * d),
    rondas: resultados.map((r) => r.ronda).sort((a, b) => a - b),
  };
}
