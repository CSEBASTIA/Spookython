// Plan por turno (sección 5 de docs/plan.md). Se arma una sola vez por turno y por tarea
// con el estado que escribió el simulador, y después cada POST /paso es una búsqueda en arreglos.
import {
  distanciasEnCalles,
  gradoAbierto,
  indicesDeAristas,
  type Grafo,
} from '../../compartido/src/grafo.js';
import { esMordida, movimientosDeCruce, nodosMortales } from '../../compartido/src/reglas.js';
import type { EstadoTurno, RespuestaPaso, Sobreviviente, Zombie } from '../../compartido/src/tipos.js';

/** Pesos del plan, en «turnos equivalentes». El banco de pruebas decide los valores finales. */
export interface Parametros {
  /** Cuánto pesa el tiempo de la calle (distancia y tipo) frente a contar turnos. */
  lambda: number;
  /** Nodo a 1 calle de un caminante. */
  p1: number;
  /** Nodo a 2 calles o menos de un corredor (la mitad a 3 calles). */
  p2: number;
  /** Camino previsto de un corredor que persigue a alguien (PRO). */
  p3: number;
  /** Callejón sin salida. */
  p4: number;
  /** Nodo con un zombie, para el resto de la ruta: en el paso inmediato ya está prohibido. */
  pZombie: number;
  /** Nodo de una horda y sus vecinos, para el resto de la ruta: la horda casi no se mueve. */
  pHorda: number;
  /** Solo se cambia de refugio si el nuevo ahorra más que esta fracción del costo. */
  histeresis: number;
}

export const PARAMETROS: Readonly<Parametros> = {
  lambda: 0.3,
  p1: 1.5,
  p2: 2.5,
  p3: 6,
  p4: 2,
  pZombie: 4,
  pHorda: 30,
  histeresis: 0.2,
};

/** Costo que se suma a un paso que termina en mordida: solo se elige si no hay otra opción. */
const PROHIBIDO = 1e6;
const LARGO_MAXIMO_RUTA = 400;

export interface Plan {
  readonly turno: number;
  readonly grafo: Grafo;
  readonly parametros: Readonly<Parametros>;
  readonly bloqueadas: ReadonlySet<number>;
  /** 1 si terminar el turno en ese nodo es mordida. */
  readonly mortal: Uint8Array;
  /** Movimientos que cruzan a un zombie por la misma calle. */
  readonly cruces: ReadonlySet<number>;
  /** Peligro de terminar un paso en cada nodo. */
  readonly peligro: Float64Array;
  /** Por refugio: costo de llegar desde cada nodo (Infinity si no se puede). */
  readonly campos: readonly Float64Array[];
  /** Por refugio: siguiente nodo del mejor camino desde cada nodo (-1 si no hay). */
  readonly siguientes: readonly Int32Array[];
  /** Cupo libre de cada refugio según el estado, antes del reparto. */
  readonly cupo: readonly number[];
  /** Refugio (índice) asignado a cada sobreviviente que huye. */
  readonly asignado: ReadonlyMap<string, number>;
  readonly huyendo: readonly Sobreviviente[];
}

export function construirPlan(grafo: Grafo, estado: EstadoTurno, parametros: Readonly<Parametros> = PARAMETROS): Plan {
  const bloqueadas = indicesDeAristas(grafo, estado.aristasBloqueadas ?? []);
  const zombies = (estado.zombies ?? []).filter((z) => grafo.indice.has(z.nodo));
  const huyendo = (estado.sobrevivientes ?? []).filter((s) => s.estado === 'huyendo' && grafo.indice.has(s.nodo));
  const peligro = calcularPeligro(grafo, zombies, huyendo, bloqueadas, parametros);

  const campos: Float64Array[] = [];
  const siguientes: Int32Array[] = [];
  for (const refugio of grafo.refugios) {
    const campo = campoHacia(grafo, refugio.nodo, peligro, bloqueadas, parametros.lambda);
    campos.push(campo.costo);
    siguientes.push(campo.siguiente);
  }

  const cupo = grafo.refugios.map((r) => {
    const ocupacion = (estado.refugios ?? []).find((o) => o.id === r.id);
    return ocupacion ? Math.max(0, ocupacion.capacidad - ocupacion.ocupados) : r.capacidad;
  });

  return {
    turno: estado.turno,
    grafo,
    parametros,
    bloqueadas,
    mortal: nodosMortales(grafo, zombies),
    cruces: movimientosDeCruce(grafo, zombies),
    peligro,
    campos,
    siguientes,
    cupo,
    asignado: repartir(grafo, huyendo, campos, cupo, parametros.histeresis),
    huyendo,
  };
}

/** Siguiente nodo para un sobreviviente: siempre un vecino por calle abierta o el mismo nodo. */
export function decidirPaso(plan: Plan, sobrevivienteId: string, nodoActual: string): RespuestaPaso {
  const u = plan.grafo.indice.get(nodoActual);
  if (u === undefined) return { siguienteNodo: nodoActual };
  const refugio = refugioPara(plan, sobrevivienteId, u);
  const siguiente = plan.grafo.ids[mejorPaso(plan, u, refugio)]!;
  return refugio === -1 ? { siguienteNodo: siguiente } : { siguienteNodo: siguiente, refugio: plan.grafo.refugios[refugio]!.id };
}

/** Ruta planificada de cada sobreviviente que huye: el paso de este turno y después el mejor camino. */
export function rutasDelPlan(plan: Plan): Record<string, string[]> {
  const { grafo } = plan;
  const rutas: Record<string, string[]> = {};
  for (const s of plan.huyendo) {
    const u = grafo.indice.get(s.nodo)!;
    const r = refugioPara(plan, s.id, u);
    if (r === -1) continue;
    const destino = grafo.refugios[r]!.nodo;
    const ruta = [u];
    const vistos = new Set(ruta);
    let actual = mejorPaso(plan, u, r);
    if (actual !== u) {
      ruta.push(actual);
      vistos.add(actual);
    }
    while (actual !== destino && ruta.length < LARGO_MAXIMO_RUTA) {
      const siguiente = plan.siguientes[r]![actual]!;
      if (siguiente < 0 || vistos.has(siguiente)) break;
      ruta.push(siguiente);
      vistos.add(siguiente);
      actual = siguiente;
    }
    rutas[s.id] = ruta.map((k) => grafo.ids[k]!);
  }
  return rutas;
}

// ── Peligro ──

function calcularPeligro(
  grafo: Grafo,
  zombies: readonly Zombie[],
  huyendo: readonly Sobreviviente[],
  bloqueadas: ReadonlySet<number>,
  p: Readonly<Parametros>,
): Float64Array {
  const total = grafo.ids.length;
  const peligro = new Float64Array(total);
  const presas = new Uint8Array(total);
  for (const s of huyendo) presas[grafo.indice.get(s.nodo)!] = 1;
  const sinBloqueos = new Set<number>();

  for (const z of zombies) {
    const origen = grafo.indice.get(z.nodo)!;
    if (z.tipo === 'horda') {
      // Su nodo y sus vecinos son mortales; a 2 calles, por si da su paso lento
      const distancia = distanciasEnCalles(grafo, [origen], sinBloqueos, 2);
      for (let v = 0; v < total; v++) {
        const d = distancia[v]!;
        if (d === 0 || d === 1) peligro[v]! += p.pHorda;
        else if (d === 2) peligro[v]! += p.p1;
      }
      continue;
    }

    peligro[origen]! += p.pZombie;
    const distancia = distanciasEnCalles(grafo, [origen], bloqueadas, 3);
    for (let v = 0; v < total; v++) {
      const d = distancia[v]!;
      if (d <= 0) continue;
      if (z.tipo === 'corredor') {
        if (d <= 2) peligro[v]! += p.p2;
        else peligro[v]! += p.p2 / 2;
      } else if (d === 1) {
        peligro[v]! += p.p1; // caminante, o dormido que acaba de despertar
      }
    }
    if (z.tipo === 'corredor') {
      for (const v of persecucionPrevista(grafo, origen, presas, bloqueadas)) peligro[v]! += p.p3;
    }
  }

  for (let v = 0; v < total; v++) {
    if (grafo.refugioEn[v] === -1 && gradoAbierto(grafo, v, bloqueadas) <= 1) peligro[v]! += p.p4;
  }
  return peligro;
}

/**
 * PRO: si el corredor tiene un sobreviviente a 3 nodos o menos, lo va a perseguir.
 * Se repite lo que hará el simulador (BFS hacia el más cercano) y se devuelven
 * los 2 nodos que recorrerá en el próximo turno.
 */
function persecucionPrevista(grafo: Grafo, origen: number, presas: Uint8Array, bloqueadas: ReadonlySet<number>): number[] {
  if (presas[origen] === 1) return [];
  const padre = new Int32Array(grafo.ids.length).fill(-2);
  const nivel = new Int32Array(grafo.ids.length);
  padre[origen] = -1;
  const cola = [origen];
  let encontrada = -1;
  for (let cabeza = 0; cabeza < cola.length && encontrada === -1; cabeza++) {
    const u = cola[cabeza]!;
    if (nivel[u]! >= 3) continue;
    for (const v of grafo.vecinos[u]!) {
      if (bloqueadas.has(v.arista) || padre[v.nodo] !== -2) continue;
      padre[v.nodo] = u;
      nivel[v.nodo] = nivel[u]! + 1;
      if (presas[v.nodo] === 1) {
        encontrada = v.nodo;
        break;
      }
      cola.push(v.nodo);
    }
  }
  if (encontrada === -1) return [];
  const camino: number[] = [];
  for (let x = encontrada; x !== origen; x = padre[x]!) camino.push(x);
  return camino.reverse().slice(0, 2);
}

// ── Campo de costo por refugio (Dijkstra desde el refugio) ──

function campoHacia(
  grafo: Grafo,
  destino: number,
  peligro: Float64Array,
  bloqueadas: ReadonlySet<number>,
  lambda: number,
): { costo: Float64Array; siguiente: Int32Array } {
  const costo = new Float64Array(grafo.ids.length).fill(Number.POSITIVE_INFINITY);
  const siguiente = new Int32Array(grafo.ids.length).fill(-1);
  const monticulo = new Monticulo();
  costo[destino] = 0;
  monticulo.agregar(0, destino);
  while (monticulo.tamano > 0) {
    const [c, y] = monticulo.sacar();
    if (c > costo[y]!) continue;
    for (const { nodo: x, arista } of grafo.vecinos[y]!) {
      if (bloqueadas.has(arista)) continue;
      // Ir de x a y cuesta un turno, el tiempo de la calle y el peligro de terminar en y
      const paso = 1 + (lambda * grafo.segundos[arista]!) / grafo.segundosPromedio + peligro[y]!;
      if (c + paso < costo[x]!) {
        costo[x] = c + paso;
        siguiente[x] = y;
        monticulo.agregar(c + paso, x);
      }
    }
  }
  return { costo, siguiente };
}

// ── Reparto por capacidad (PRO) ──

function compararDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

/**
 * Primero se asigna a quien más pierde si no va a su mejor refugio («arrepentimiento»),
 * y cada uno va al mejor refugio con cupo. Con histéresis frente al refugio anterior,
 * para que nadie oscile entre dos. Empates por id: todas las tareas dan lo mismo.
 */
function repartir(
  grafo: Grafo,
  huyendo: readonly Sobreviviente[],
  campos: readonly Float64Array[],
  cupoInicial: readonly number[],
  histeresis: number,
): Map<string, number> {
  const cupo = [...cupoInicial];
  const indiceRefugio = new Map(grafo.refugios.map((r, k) => [r.id, k]));
  const filas = huyendo.map((s) => {
    const u = grafo.indice.get(s.nodo)!;
    const costos = campos.map((campo) => campo[u]!);
    const orden = costos
      .map((_, k) => k)
      .filter((k) => Number.isFinite(costos[k]))
      .sort((a, b) => costos[a]! - costos[b]! || a - b);
    const arrepentimiento =
      orden.length === 0 ? Number.NEGATIVE_INFINITY
      : orden.length === 1 ? Number.POSITIVE_INFINITY
      : costos[orden[1]!]! - costos[orden[0]!]!;
    return { s, costos, orden, arrepentimiento };
  });
  filas.sort((a, b) => compararDesc(a.arrepentimiento, b.arrepentimiento) || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0));

  const asignado = new Map<string, number>();
  for (const { s, costos, orden } of filas) {
    if (orden.length === 0) continue; // no llega a ningún refugio: decide el paso más seguro
    let elegido = orden.find((k) => cupo[k]! > 0) ?? orden[0]!;
    const anterior = s.refugioAnterior ? indiceRefugio.get(s.refugioAnterior) : undefined;
    if (anterior !== undefined && anterior !== elegido && cupo[anterior]! > 0 && Number.isFinite(costos[anterior])) {
      const base = costos[anterior]!;
      if (base <= 0 || (base - costos[elegido]!) / base <= histeresis) elegido = anterior;
    }
    asignado.set(s.id, elegido);
    cupo[elegido]!--;
  }
  return asignado;
}

// ── Elección del paso ──

/** Refugio asignado, o el mejor con cupo para quien no está en el estado o ya no llega al suyo. */
function refugioPara(plan: Plan, sobrevivienteId: string, u: number): number {
  const asignado = plan.asignado.get(sobrevivienteId);
  if (asignado !== undefined && Number.isFinite(plan.campos[asignado]![u])) return asignado;
  let mejor = -1;
  let mejorConCupo = -1;
  plan.campos.forEach((campo, k) => {
    const c = campo[u]!;
    if (!Number.isFinite(c)) return;
    if (mejor === -1 || c < plan.campos[mejor]![u]!) mejor = k;
    if (plan.cupo[k]! > 0 && (mejorConCupo === -1 || c < plan.campos[mejorConCupo]![u]!)) mejorConCupo = k;
  });
  return mejorConCupo !== -1 ? mejorConCupo : mejor;
}

/**
 * Entre quedarse y cada vecino por calle abierta, el que minimiza
 * costo(u→v) + campo del refugio en v. Lo que termina en mordida solo se elige si no queda otra.
 */
function mejorPaso(plan: Plan, u: number, refugio: number): number {
  const { grafo, parametros, peligro, mortal, cruces } = plan;
  if (refugio !== -1 && grafo.refugios[refugio]!.nodo === u && mortal[u] === 0) return u; // ya llegó
  const campo = refugio === -1 ? null : plan.campos[refugio]!;

  const costo = (v: number, segundos: number): number =>
    (esMordida(grafo, u, v, mortal, cruces) ? PROHIBIDO : 0) +
    1 +
    (parametros.lambda * segundos) / grafo.segundosPromedio +
    peligro[v]! +
    (campo ? campo[v]! : 0);

  let mejor = u;
  let mejorCosto = costo(u, 0);
  for (const { nodo: v, arista } of grafo.vecinos[u]!) {
    if (plan.bloqueadas.has(arista)) continue;
    const c = costo(v, grafo.segundos[arista]!);
    if (c < mejorCosto || (c === mejorCosto && v < mejor)) {
      mejor = v;
      mejorCosto = c;
    }
  }
  return mejor;
}

/** Montículo binario mínimo de pares (costo, nodo) para Dijkstra. */
class Monticulo {
  private readonly costos: number[] = [];
  private readonly nodos: number[] = [];

  get tamano(): number {
    return this.costos.length;
  }

  agregar(costo: number, nodo: number): void {
    let i = this.costos.length;
    this.costos.push(costo);
    this.nodos.push(nodo);
    while (i > 0) {
      const padre = (i - 1) >> 1;
      if (this.costos[padre]! <= costo) break;
      this.costos[i] = this.costos[padre]!;
      this.nodos[i] = this.nodos[padre]!;
      i = padre;
    }
    this.costos[i] = costo;
    this.nodos[i] = nodo;
  }

  sacar(): [number, number] {
    const costo = this.costos[0]!;
    const nodo = this.nodos[0]!;
    const ultimoCosto = this.costos.pop()!;
    const ultimoNodo = this.nodos.pop()!;
    const n = this.costos.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const izquierdo = 2 * i + 1;
        if (izquierdo >= n) break;
        const derecho = izquierdo + 1;
        const menor = derecho < n && this.costos[derecho]! < this.costos[izquierdo]! ? derecho : izquierdo;
        if (this.costos[menor]! >= ultimoCosto) break;
        this.costos[i] = this.costos[menor]!;
        this.nodos[i] = this.nodos[menor]!;
        i = menor;
      }
      this.costos[i] = ultimoCosto;
      this.nodos[i] = ultimoNodo;
    }
    return [costo, nodo];
  }
}
