// Reglas del reto que comparten el motor (para no equivocarse) y el simulador (para juzgar).
import { aristaAbierta, indicesDeAristas, type Grafo } from './grafo.js';
import type { Zombie } from './tipos.js';

/**
 * Movimiento permitido: quedarse en el mismo nodo, o ir a un vecino por una calle abierta.
 * Un movimiento inválido equivale a quedarse quieto.
 */
export function esMovimientoValido(
  grafo: Grafo,
  desde: string,
  hacia: string,
  aristasBloqueadas: readonly string[] | ReadonlySet<number>,
): boolean {
  const u = grafo.indice.get(desde);
  const v = grafo.indice.get(hacia);
  if (u === undefined || v === undefined) return false;
  if (u === v) return true;
  const bloqueadas = Array.isArray(aristasBloqueadas)
    ? indicesDeAristas(grafo, aristasBloqueadas)
    : (aristasBloqueadas as ReadonlySet<number>);
  return aristaAbierta(grafo, u, v, bloqueadas) !== -1;
}

/**
 * Nodos donde terminar el turno es mordida: los que tienen un zombie visible,
 * y el nodo de cada horda con todos sus vecinos (decisión 3 del plan).
 * Los vecinos de la horda cuentan por cualquier calle, aunque esté bloqueada.
 */
export function nodosMortales(grafo: Grafo, zombies: readonly Zombie[]): Uint8Array {
  const mortal = new Uint8Array(grafo.ids.length);
  for (const z of zombies) {
    const nodo = grafo.indice.get(z.nodo);
    if (nodo === undefined) continue;
    mortal[nodo] = 1;
    if (z.tipo === 'horda') for (const v of grafo.vecinos[nodo]!) mortal[v.nodo] = 1;
  }
  return mortal;
}

/** Clave de un movimiento dirigido desde → hacia. */
export function claveMovimiento(grafo: Grafo, desde: number, hacia: number): number {
  return desde * grafo.ids.length + hacia;
}

/**
 * Movimientos que cruzan a un zombie por la misma calle en sentido contrario.
 * Si un zombie fue de v a u en este turno, ir de u a v es mordida.
 */
export function movimientosDeCruce(grafo: Grafo, zombies: readonly Zombie[]): Set<number> {
  const cruces = new Set<number>();
  for (const z of zombies) {
    const recorrido = z.recorrido ?? [];
    for (let i = 0; i + 1 < recorrido.length; i++) {
      const v = grafo.indice.get(recorrido[i]!);
      const u = grafo.indice.get(recorrido[i + 1]!);
      if (u === undefined || v === undefined || u === v) continue;
      cruces.add(claveMovimiento(grafo, u, v));
    }
  }
  return cruces;
}

/** True si el movimiento termina en mordida según las reglas: nodo mortal o cruce. */
export function esMordida(
  grafo: Grafo,
  desde: number,
  hacia: number,
  mortal: Uint8Array,
  cruces: ReadonlySet<number>,
): boolean {
  if (mortal[hacia] === 1) return true;
  return desde !== hacia && cruces.has(claveMovimiento(grafo, desde, hacia));
}
