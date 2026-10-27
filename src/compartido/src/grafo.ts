// Grafo de Manta con índices enteros. Con unos 300 nodos todo cabe en arreglos
// planos y cualquier recorrido toma microsegundos.
import { readFileSync } from 'node:fs';
import { VELOCIDAD_KMH, type Arista, type MapaBase } from './tipos.js';

export interface Vecino {
  readonly nodo: number;
  readonly arista: number;
}

export interface RefugioIndexado {
  readonly id: string;
  readonly nombre: string;
  readonly nodo: number;
  readonly capacidad: number;
}

export interface Grafo {
  /** Índice → id del nodo. */
  readonly ids: readonly string[];
  /** Índice → barrio del nodo, o null si no está en ninguno de los 4 barrios. */
  readonly barrios: readonly (string | null)[];
  /** Id del nodo → índice. */
  readonly indice: ReadonlyMap<string, number>;
  readonly aristas: readonly Arista[];
  /** Id de la arista → índice. */
  readonly indiceArista: ReadonlyMap<string, number>;
  /** Vecinos por cualquier calle, bloqueada o no. */
  readonly vecinos: readonly (readonly Vecino[])[];
  /** Segundos que toma recorrer cada arista a la velocidad de su tipo. */
  readonly segundos: Float64Array;
  readonly segundosPromedio: number;
  readonly refugios: readonly RefugioIndexado[];
  /** Índice del nodo → índice del refugio que está ahí, o -1. */
  readonly refugioEn: Int32Array;
}

export function crearGrafo(mapa: MapaBase): Grafo {
  const ids = mapa.nodos.map((n) => n.id);
  const indice = new Map<string, number>();
  ids.forEach((id, i) => {
    if (indice.has(id)) throw new Error(`Nodo repetido: ${id}`);
    indice.set(id, i);
  });

  const posicion = (id: string, donde: string): number => {
    const i = indice.get(id);
    if (i === undefined) throw new Error(`${donde} apunta a un nodo que no existe: ${id}`);
    return i;
  };

  const vecinos: Vecino[][] = ids.map(() => []);
  const indiceArista = new Map<string, number>();
  const segundos = new Float64Array(mapa.aristas.length);
  let total = 0;
  mapa.aristas.forEach((arista, e) => {
    if (indiceArista.has(arista.id)) throw new Error(`Arista repetida: ${arista.id}`);
    indiceArista.set(arista.id, e);
    const a = posicion(arista.a, `La arista ${arista.id}`);
    const b = posicion(arista.b, `La arista ${arista.id}`);
    const velocidad = VELOCIDAD_KMH[arista.tipo];
    if (!velocidad) throw new Error(`La arista ${arista.id} tiene un tipo desconocido: ${arista.tipo}`);
    segundos[e] = Math.max(arista.distancia_m, 1) / (velocidad / 3.6);
    total += segundos[e]!;
    if (a === b) return; // un lazo no lleva a ningún lado
    vecinos[a]!.push({ nodo: b, arista: e });
    vecinos[b]!.push({ nodo: a, arista: e });
  });

  const refugioEn = new Int32Array(ids.length).fill(-1);
  const refugios = mapa.refugios.map((r, k) => {
    const nodo = posicion(r.nodo, `El refugio ${r.id}`);
    refugioEn[nodo] = k;
    return { id: r.id, nombre: r.nombre, nodo, capacidad: r.capacidad };
  });

  return {
    ids,
    barrios: mapa.nodos.map((n) => n.barrio ?? null),
    indice,
    aristas: mapa.aristas,
    indiceArista,
    vecinos,
    segundos,
    segundosPromedio: mapa.aristas.length > 0 ? total / mapa.aristas.length : 1,
    refugios,
    refugioEn,
  };
}

/** Convierte los ids de aristas bloqueadas en índices; los desconocidos se ignoran. */
export function indicesDeAristas(grafo: Grafo, ids: readonly string[]): Set<number> {
  const resultado = new Set<number>();
  for (const id of ids) {
    const e = grafo.indiceArista.get(id);
    if (e !== undefined) resultado.add(e);
  }
  return resultado;
}

/**
 * La calle abierta más rápida entre dos nodos vecinos, o -1 si no hay ninguna.
 * Puede haber más de una calle entre el mismo par de intersecciones.
 */
export function aristaAbierta(grafo: Grafo, desde: number, hacia: number, bloqueadas: ReadonlySet<number>): number {
  let mejor = -1;
  for (const v of grafo.vecinos[desde] ?? []) {
    if (v.nodo !== hacia || bloqueadas.has(v.arista)) continue;
    if (mejor === -1 || grafo.segundos[v.arista]! < grafo.segundos[mejor]!) mejor = v.arista;
  }
  return mejor;
}

/** Cantidad de calles abiertas que salen de un nodo. */
export function gradoAbierto(grafo: Grafo, nodo: number, bloqueadas: ReadonlySet<number>): number {
  let grado = 0;
  for (const v of grafo.vecinos[nodo] ?? []) if (!bloqueadas.has(v.arista)) grado++;
  return grado;
}

/**
 * Distancia en calles desde el origen más cercano, solo por calles abiertas.
 * Devuelve -1 en los nodos a los que no se llega o que están más lejos que `maximo`.
 */
export function distanciasEnCalles(
  grafo: Grafo,
  origenes: readonly number[],
  bloqueadas: ReadonlySet<number>,
  maximo = Number.POSITIVE_INFINITY,
): Int32Array {
  const distancia = new Int32Array(grafo.ids.length).fill(-1);
  const cola: number[] = [];
  for (const o of origenes) {
    if (distancia[o] === -1) {
      distancia[o] = 0;
      cola.push(o);
    }
  }
  for (let cabeza = 0; cabeza < cola.length; cabeza++) {
    const u = cola[cabeza]!;
    const d = distancia[u]!;
    if (d >= maximo) continue;
    for (const v of grafo.vecinos[u]!) {
      if (bloqueadas.has(v.arista) || distancia[v.nodo] !== -1) continue;
      distancia[v.nodo] = d + 1;
      cola.push(v.nodo);
    }
  }
  return distancia;
}

/** Lee un mapa base desde un archivo JSON y revisa que tenga la forma mínima del contrato. */
export function leerMapa(ruta: string): MapaBase {
  const mapa = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<MapaBase>;
  if (!Array.isArray(mapa.nodos) || !Array.isArray(mapa.aristas) || !Array.isArray(mapa.refugios)) {
    throw new Error(`${ruta} no tiene nodos, aristas y refugios`);
  }
  return mapa as MapaBase;
}
