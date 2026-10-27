// Núcleo del Simulador del Apocalipsis (sección 6 de docs/plan.md). Es puro: no toca la red
// ni el reloj, y con la misma semilla juega siempre la misma partida. El banco del motor lo usa tal cual.
import { aristaAbierta, distanciasEnCalles, type Grafo } from '../../compartido/src/grafo.js';
import { esMordida, movimientosDeCruce, nodosMortales, persecucionDeCorredor } from '../../compartido/src/reglas.js';
import type {
  EstadoSobreviviente,
  EstadoTurno,
  MetricasLatencia,
  ResultadoRonda,
  TipoCalle,
  TipoZombie,
  Zombie,
} from '../../compartido/src/tipos.js';
import { crearAzar, type Azar } from './azar.js';
import type { ConfigRonda, TipoEvento } from './rondas.js';

/** Un dormido despierta si un sobreviviente pasa a esta distancia o menos. */
const RADIO_DESPERTAR = 2;
/** Cada cuántos turnos da un paso cada tipo lento. */
const CADA_CAMINANTE = 2;
const CADA_HORDA = 10;
/** Una horda nunca se acerca tanto a un refugio: lo dejaría bloqueado para siempre. */
const HORDA_LEJOS_DE_REFUGIO = 3;
const EVENTOS_GUARDADOS = 50;

export interface ZombieEnJuego {
  readonly id: string;
  /** Un dormido que despierta pasa a ser caminante. */
  tipo: TipoZombie;
  nodo: number;
  dormido: boolean;
  /** Resto del turno en que le toca moverse (caminante cada 2, horda cada 10). */
  fase: number;
  /** Nodos por los que pasó en el último turno, empezando por donde estaba. */
  recorrido: number[];
}

export interface SobrevivienteEnJuego {
  readonly id: string;
  nodo: number;
  readonly inicio: number;
  estado: EstadoSobreviviente;
  /** Turnos de la ruta más corta sin zombies desde el inicio: la base de la eficiencia. */
  readonly minimo: number;
  /** Turno en que llegó a un refugio o fue mordido. */
  turnoFinal: number | null;
  /** Refugio que el motor le asignó en el último turno. */
  refugioAnterior: string | null;
}

export interface Juego {
  readonly grafo: Grafo;
  readonly config: ConfigRonda;
  readonly semilla: number;
  readonly azar: Azar;
  turno: number;
  readonly zombies: ZombieEnJuego[];
  readonly sobrevivientes: SobrevivienteEnJuego[];
  readonly bloqueadas: Set<number>;
  /** Calles que bloqueó el presentador: se aplican al empezar el turno siguiente. */
  readonly bloqueosPendientes: number[];
  readonly ocupados: number[];
  readonly eventos: { turno: number; texto: string }[];
  /** Distancia en calles al refugio más cercano, con el mapa sin bloqueos. */
  readonly distanciaRefugio: Int32Array;
  readonly refugiosLlenos: Set<number>;
}

export interface ResumenTurno {
  mordidos: string[];
  llegados: string[];
  /** Pasos que no eran un vecino por calle abierta ni el mismo nodo: cuentan como quedarse. */
  invalidos: number;
}

const conCeros = (n: number, largo: number) => String(n).padStart(largo, '0');

function nodosDonde(grafo: Grafo, condicion: (v: number) => boolean): number[] {
  const resultado: number[] = [];
  for (let v = 0; v < grafo.ids.length; v++) if (condicion(v)) resultado.push(v);
  return resultado;
}

export function crearJuego(grafo: Grafo, config: ConfigRonda, semilla: number): Juego {
  const azar = crearAzar(semilla);
  const esRefugio = (v: number) => grafo.refugioEn[v] !== -1;
  const distanciaRefugio = distanciasEnCalles(grafo, grafo.refugios.map((r) => r.nodo), new Set());

  // Sobrevivientes: repartidos por turnos entre los barrios del mapa, a 2 calles o más de un refugio
  const barrios = [...new Set(grafo.barrios.filter((b): b is string => b !== null))].sort();
  const lejosDeRefugio = (v: number) => !esRefugio(v) && distanciaRefugio[v]! >= 2;
  const porBarrio = barrios
    .map((b) => nodosDonde(grafo, (v) => grafo.barrios[v] === b && lejosDeRefugio(v)))
    .filter((nodos) => nodos.length > 0);
  const cualquiera = nodosDonde(grafo, (v) => !esRefugio(v) && distanciaRefugio[v]! >= 1);
  const sobrevivientes: SobrevivienteEnJuego[] = [];
  for (let k = 0; k < config.sobrevivientes; k++) {
    const opciones = porBarrio.length > 0 ? porBarrio[k % porBarrio.length]! : cualquiera;
    const nodo = azar.elegir(opciones);
    sobrevivientes.push({
      id: `S-${conCeros(k, 4)}`,
      nodo,
      inicio: nodo,
      estado: 'huyendo',
      minimo: distanciaRefugio[nodo]!,
      turnoFinal: null,
      refugioAnterior: null,
    });
  }

  // Zombies: lo más lejos posible de los sobrevivientes (3 calles; si no hay sitio, 2 y luego 1),
  // nunca en un refugio, un solo zombie por nodo y las hordas lejos de los refugios
  const distanciaPresas = distanciasEnCalles(grafo, sobrevivientes.map((s) => s.nodo), new Set());
  const lejosDePresas = (v: number, minimo: number) => distanciaPresas[v] === -1 || distanciaPresas[v]! >= minimo;
  const ocupado = new Uint8Array(grafo.ids.length);
  const zombies: ZombieEnJuego[] = [];
  for (const tipo of ['horda', 'corredor', 'caminante', 'dormido'] as const) {
    for (let k = 0; k < config.zombies[tipo]; k++) {
      let nodo = -1;
      for (const minimo of [3, 2, 1]) {
        const opciones = nodosDonde(
          grafo,
          (v) =>
            !esRefugio(v) && ocupado[v] === 0 && lejosDePresas(v, minimo) &&
            (tipo !== 'horda' || distanciaRefugio[v]! >= HORDA_LEJOS_DE_REFUGIO),
        );
        if (opciones.length > 0) {
          nodo = azar.elegir(opciones);
          break;
        }
      }
      if (nodo === -1) nodo = azar.elegir(nodosDonde(grafo, (v) => !esRefugio(v)));
      ocupado[nodo] = 1;
      zombies.push({
        id: `Z-${conCeros(zombies.length, 3)}`,
        tipo,
        nodo,
        dormido: tipo === 'dormido',
        fase: tipo === 'caminante' ? azar.entero(CADA_CAMINANTE) : tipo === 'horda' ? azar.entero(CADA_HORDA) : 0,
        recorrido: [nodo],
      });
    }
  }

  const juego: Juego = {
    grafo,
    config,
    semilla,
    azar,
    turno: 0,
    zombies,
    sobrevivientes,
    bloqueadas: new Set(),
    bloqueosPendientes: [],
    ocupados: grafo.refugios.map(() => 0),
    eventos: [],
    distanciaRefugio,
    refugiosLlenos: new Set(),
  };
  registrar(
    juego,
    `Empieza la ronda ${config.ronda} · ${config.nombre}: ${sobrevivientes.length} sobrevivientes y ${zombies.length} zombies`,
  );
  return juego;
}

/** Primera mitad del turno: eventos de la ciudad, dormidos que despiertan y zombies que se mueven. */
export function moverZombies(juego: Juego): void {
  const { grafo, bloqueadas } = juego;
  juego.turno++;

  for (const e of juego.bloqueosPendientes.splice(0)) {
    if (!bloqueadas.has(e)) bloquear(juego, e, `El presentador bloqueó ${describirCalle(grafo, e)}`);
  }
  for (const evento of juego.config.eventos) {
    if (evento.turno === juego.turno) aplicarEvento(juego, evento.tipo);
  }

  const presas = new Uint8Array(grafo.ids.length);
  const nodosPresas: number[] = [];
  for (const s of juego.sobrevivientes) {
    if (s.estado !== 'huyendo') continue;
    presas[s.nodo] = 1;
    nodosPresas.push(s.nodo);
  }

  const dormidos = juego.zombies.filter((z) => z.dormido);
  if (dormidos.length > 0 && nodosPresas.length > 0) {
    const cerca = distanciasEnCalles(grafo, nodosPresas, bloqueadas, RADIO_DESPERTAR);
    for (const z of dormidos) {
      if (cerca[z.nodo] === -1) continue;
      z.dormido = false;
      z.tipo = 'caminante';
      z.fase = (juego.turno + 1) % CADA_CAMINANTE; // da su primer paso en el turno siguiente
      registrar(juego, `${z.id} despertó en ${grafo.ids[z.nodo]}`);
    }
  }

  for (const z of juego.zombies) {
    z.recorrido = [z.nodo];
    if (z.dormido) continue;
    if (z.tipo === 'caminante') {
      if (juego.turno % CADA_CAMINANTE === z.fase) pasoAlAzar(juego, z);
    } else if (z.tipo === 'horda') {
      if (juego.turno % CADA_HORDA === z.fase) {
        pasoAlAzar(juego, z, (v) => juego.distanciaRefugio[v]! >= HORDA_LEJOS_DE_REFUGIO);
      }
    } else if (z.tipo === 'corredor') {
      const camino = persecucionDeCorredor(grafo, z.nodo, presas, bloqueadas);
      if (camino.length > 0) {
        for (const v of camino) avanzar(z, v);
      } else {
        pasoAlAzar(juego, z);
        pasoAlAzar(juego, z);
      }
    }
  }
}

/**
 * Segunda mitad del turno: cada sobreviviente da el paso que pidió (un paso inválido o
 * ausente es quedarse), y al final se juzgan mordidas y llegadas a refugios con cupo.
 */
export function aplicarPasos(juego: Juego, pasos: ReadonlyMap<string, string | null>): ResumenTurno {
  const { grafo, bloqueadas } = juego;
  // Compartir nodo con un dormido también es mordida
  const todos = juego.zombies.map((z) => comoZombie(grafo, z));
  const mortal = nodosMortales(grafo, todos);
  const cruces = movimientosDeCruce(grafo, todos);
  const resumen: ResumenTurno = { mordidos: [], llegados: [], invalidos: 0 };

  for (const s of juego.sobrevivientes) {
    if (s.estado !== 'huyendo') continue;
    const desde = s.nodo;
    const pedido = pasos.get(s.id);
    if (pedido !== undefined && pedido !== null) {
      const v = grafo.indice.get(pedido);
      if (v !== undefined && (v === desde || aristaAbierta(grafo, desde, v, bloqueadas) !== -1)) s.nodo = v;
      else resumen.invalidos++;
    }

    if (esMordida(grafo, desde, s.nodo, mortal, cruces)) {
      s.estado = 'mordido';
      s.turnoFinal = juego.turno;
      resumen.mordidos.push(s.id);
      continue;
    }
    const k = grafo.refugioEn[s.nodo]!;
    if (k === -1) continue;
    if (juego.ocupados[k]! < grafo.refugios[k]!.capacidad) {
      juego.ocupados[k]!++;
      s.estado = 'a_salvo';
      s.turnoFinal = juego.turno;
      resumen.llegados.push(s.id);
    } else if (!juego.refugiosLlenos.has(k)) {
      juego.refugiosLlenos.add(k);
      registrar(juego, `${grafo.refugios[k]!.nombre} está lleno: quien llega no puede entrar`);
    }
  }

  if (resumen.mordidos.length > 0) {
    const nombres = resumen.mordidos.slice(0, 5).join(', ') + (resumen.mordidos.length > 5 ? '…' : '');
    registrar(juego, `${resumen.mordidos.length} ${resumen.mordidos.length === 1 ? 'mordido' : 'mordidos'}: ${nombres}`);
  }
  if (resumen.llegados.length > 0) {
    registrar(juego, `${resumen.llegados.length} ${resumen.llegados.length === 1 ? 'llegó' : 'llegaron'} a un refugio`);
  }
  return resumen;
}

export function terminado(juego: Juego): boolean {
  return juego.turno >= juego.config.turnos || !juego.sobrevivientes.some((s) => s.estado === 'huyendo');
}

/** Estado del turno para DynamoDB y el motor: sin los dormidos, que todavía son invisibles. */
export function estadoTurno(juego: Juego, actualizadoEn = new Date().toISOString()): EstadoTurno {
  const { grafo } = juego;
  return {
    partida: 'actual',
    ronda: juego.config.ronda,
    turno: juego.turno,
    zombies: zombiesVisibles(juego),
    aristasBloqueadas: [...juego.bloqueadas].sort((a, b) => a - b).map((e) => grafo.aristas[e]!.id),
    sobrevivientes: juego.sobrevivientes.map((s) => ({
      id: s.id,
      nodo: grafo.ids[s.nodo]!,
      estado: s.estado,
      refugioAnterior: s.refugioAnterior,
    })),
    refugios: grafo.refugios.map((r, k) => ({ id: r.id, ocupados: juego.ocupados[k]!, capacidad: r.capacidad })),
    actualizadoEn,
  };
}

export function zombiesVisibles(juego: Juego): Zombie[] {
  return juego.zombies.filter((z) => !z.dormido).map((z) => comoZombie(juego.grafo, z));
}

/** Pide bloquear una calle en vivo; se aplica al empezar el turno siguiente. */
export function pedirBloqueo(juego: Juego, aristaId: string): boolean {
  const e = juego.grafo.indiceArista.get(aristaId);
  if (e === undefined || juego.bloqueadas.has(e) || juego.bloqueosPendientes.includes(e)) return false;
  juego.bloqueosPendientes.push(e);
  return true;
}

export function resultado(juego: Juego, latencia: MetricasLatencia): ResultadoRonda {
  const salvados = juego.sobrevivientes.filter((s) => s.estado === 'a_salvo');
  const mordidos = juego.sobrevivientes.filter((s) => s.estado === 'mordido').length;
  const eficiencia =
    salvados.length === 0
      ? null
      : salvados.reduce((suma, s) => suma + Math.min(1, s.minimo / Math.max(1, s.turnoFinal!)), 0) / salvados.length;
  return {
    ronda: juego.config.ronda,
    semilla: juego.semilla,
    turnos: juego.turno,
    total: juego.sobrevivientes.length,
    salvados: salvados.length,
    mordidos,
    sinLlegar: juego.sobrevivientes.length - salvados.length - mordidos,
    eficiencia,
    latencia,
  };
}

// ── Detalles ──

function registrar(juego: Juego, texto: string): void {
  juego.eventos.push({ turno: juego.turno, texto });
  if (juego.eventos.length > EVENTOS_GUARDADOS) juego.eventos.splice(0, juego.eventos.length - EVENTOS_GUARDADOS);
}

function comoZombie(grafo: Grafo, z: ZombieEnJuego): Zombie {
  return {
    id: z.id,
    tipo: z.dormido ? 'dormido' : z.tipo,
    nodo: grafo.ids[z.nodo]!,
    recorrido: z.recorrido.map((v) => grafo.ids[v]!),
  };
}

function avanzar(z: ZombieEnJuego, v: number): void {
  z.nodo = v;
  z.recorrido.push(v);
}

/** Un paso a un vecino al azar por calle abierta, sin volver al nodo de donde acaba de llegar si puede. */
function pasoAlAzar(juego: Juego, z: ZombieEnJuego, permitido: (v: number) => boolean = () => true): void {
  const anterior = z.recorrido.length >= 2 ? z.recorrido[z.recorrido.length - 2]! : -1;
  const vecinos = new Set<number>();
  for (const v of juego.grafo.vecinos[z.nodo]!) {
    if (!juego.bloqueadas.has(v.arista) && permitido(v.nodo)) vecinos.add(v.nodo);
  }
  let opciones = [...vecinos];
  const sinVolver = opciones.filter((v) => v !== anterior);
  if (sinVolver.length > 0) opciones = sinVolver;
  if (opciones.length > 0) avanzar(z, juego.azar.elegir(opciones));
}

function describirCalle(grafo: Grafo, e: number): string {
  const arista = grafo.aristas[e]!;
  return arista.nombre ? `${arista.nombre} (${arista.id})` : `la calle ${arista.id}`;
}

function bloquear(juego: Juego, e: number, texto: string): void {
  juego.bloqueadas.add(e);
  registrar(juego, texto);
}

/** Cantidad de nodos desde los que se llega a algún refugio. */
function alcanzables(grafo: Grafo, bloqueadas: ReadonlySet<number>): number {
  const distancia = distanciasEnCalles(grafo, grafo.refugios.map((r) => r.nodo), bloqueadas);
  let total = 0;
  for (const d of distancia) if (d !== -1) total++;
  return total;
}

/**
 * Elige al azar una calle de esos tipos que no deje a nadie sin camino a un refugio,
 * preferentemente cerca de alguien que todavía huye (para que el evento se note).
 */
function elegirCalleParaCortar(juego: Juego, tipos: readonly TipoCalle[]): number {
  const { grafo, bloqueadas } = juego;
  const base = alcanzables(grafo, bloqueadas);
  const candidatas: number[] = [];
  grafo.aristas.forEach((arista, e) => {
    if (bloqueadas.has(e) || !tipos.includes(arista.tipo)) return;
    if (alcanzables(grafo, new Set([...bloqueadas, e])) === base) candidatas.push(e);
  });
  if (candidatas.length === 0) return -1;

  const huyendo = juego.sobrevivientes.filter((s) => s.estado === 'huyendo').map((s) => s.nodo);
  const cerca = distanciasEnCalles(grafo, huyendo, bloqueadas, 3);
  const cercanas = candidatas.filter((e) => {
    const a = grafo.indice.get(grafo.aristas[e]!.a)!;
    const b = grafo.indice.get(grafo.aristas[e]!.b)!;
    return cerca[a] !== -1 || cerca[b] !== -1;
  });
  return juego.azar.elegir(cercanas.length > 0 ? cercanas : candidatas);
}

function aplicarEvento(juego: Juego, tipo: TipoEvento): void {
  const { grafo } = juego;
  if (tipo === 'colapso-puente') {
    let e = elegirCalleParaCortar(juego, ['puente']);
    if (e === -1) e = elegirCalleParaCortar(juego, ['avenida']);
    if (e === -1) return registrar(juego, 'Ningún puente puede colapsar sin aislar parte de la ciudad');
    return bloquear(juego, e, `Colapsó ${grafo.aristas[e]!.tipo === 'puente' ? 'el puente' : 'la avenida'} ${describirCalle(grafo, e)}`);
  }
  const e = elegirCalleParaCortar(juego, ['avenida', 'calle']);
  if (e === -1) return registrar(juego, 'No hay calle que bloquear sin aislar parte de la ciudad');
  bloquear(juego, e, `Se bloqueó ${describirCalle(grafo, e)}`);
}
