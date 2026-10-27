// Simulador del Apocalipsis: el dueño del juego (sección 6 de docs/plan.md).
// Cada 2 s mueve a los zombies, guarda el turno, le pide POST /paso al motor por cada sobreviviente
// (por la URL pública, igual que el jurado), aplica mordidas y llegadas y publica todo en GET /estado.
// Lo que exige la nube está en la sección 5 de docs/aws.md: puerto PUERTO, GET /salud y keep-alive de 65 s.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { crearGrafo, leerMapa } from '../../compartido/src/grafo.js';
import type { RespuestaPaso, RespuestaRutas, ResultadoRonda, VistaEstado } from '../../compartido/src/tipos.js';
import { destinoArchivo, destinoDynamo } from './destino.js';
import {
  aplicarPasos,
  crearJuego,
  estadoTurno,
  moverZombies,
  pedirBloqueo,
  resultado,
  terminado,
  type Juego,
  type SobrevivienteEnJuego,
} from './juego.js';
import { publicadorCloudWatch } from './metricas-cloudwatch.js';
import { calcularPuntaje, LIMITE_PASO_MS, resumirLatencias } from './puntaje.js';
import { esRonda, RONDAS } from './rondas.js';

const PUERTO = Number(process.env.PUERTO ?? 8080);
const API_KEY = process.env.API_KEY ?? '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const URL_MOTOR = (process.env.URL_MOTOR ?? '').replace(/\/$/, '');
const TABLA_MUNDO = process.env.TABLA_MUNDO ?? '';
const ESTADO_ARCHIVO = process.env.ESTADO_ARCHIVO ?? '';
/** Duración de un turno. En local se puede acortar (TURNO_MS=300) para probar más rápido. */
const TURNO_MS = Number(process.env.TURNO_MS ?? 2000);
const LIMITE_CUERPO = 1024;
const PEDIDOS_DE_PRUEBA = 50;
/** Semillas por omisión: con la misma semilla se repite la misma partida (se publican en el README). */
const SEMILLAS: Readonly<Record<1 | 2 | 3, number>> = { 1: 101, 2: 202, 3: 303 };

for (const [nombre, valor] of Object.entries({ API_KEY, ADMIN_KEY, URL_MOTOR })) {
  if (!valor) {
    console.error(`Falta la variable ${nombre}`);
    process.exit(1);
  }
}
if (!TABLA_MUNDO && !ESTADO_ARCHIVO) {
  console.error('Falta la variable TABLA_MUNDO (o ESTADO_ARCHIVO para probar en local)');
  process.exit(1);
}

// El mapa base va dentro de la imagen: `npm run build` lo copia a dist/mapa.json
const grafo = crearGrafo(leerMapa(process.env.MAPA ?? join(dirname(process.argv[1] ?? '.'), 'mapa.json')));
const destino = TABLA_MUNDO
  ? destinoDynamo(TABLA_MUNDO, { region: process.env.AWS_REGION, endpoint: process.env.DYNAMO_ENDPOINT })
  : destinoArchivo(ESTADO_ARCHIVO);
// La métrica solo se publica en AWS: en local no hay CloudWatch
const publicarLatencias = TABLA_MUNDO && !process.env.DYNAMO_ENDPOINT ? publicadorCloudWatch(process.env.AWS_REGION) : null;

interface Partida {
  readonly juego: Juego;
  enCurso: boolean;
  /** Latencias de todos los POST /paso de la ronda, en ms. */
  readonly tiempos: number[];
  errores: number;
  fueraDeTiempo: number;
  rutas: Record<string, string[]>;
  reloj?: NodeJS.Timeout;
}

let partida: Partida | null = null;
/** Última corrida terminada de cada ronda. */
const historial = new Map<number, ResultadoRonda>();
let vista = serializar(construirVista());

// ── Avisos en los logs: uno por motivo, para no pagar un log por pedido ──

const avisados = new Set<string>();
function avisar(clave: string, mensaje: string, error?: unknown): void {
  if (avisados.has(clave)) return;
  avisados.add(clave);
  if (avisados.size > 500) avisados.clear();
  console.error(mensaje, error instanceof Error ? error.message : (error ?? ''));
}

// ── Pedidos al motor ──

interface Respuesta {
  ms: number;
  ok: boolean;
  fueraDeTiempo: boolean;
  siguienteNodo: string | null;
  refugio?: string;
}

/** Un POST /paso cronometrado de punta a punta; más de 500 ms o un error es quedarse quieto. */
async function pedirPaso(s: SobrevivienteEnJuego, turno: number): Promise<Respuesta> {
  const inicio = performance.now();
  try {
    const respuesta = await fetch(`${URL_MOTOR}/paso`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ sobrevivienteId: s.id, nodoActual: grafo.ids[s.nodo], turno }),
      signal: AbortSignal.timeout(LIMITE_PASO_MS),
    });
    const cuerpo = (await respuesta.json()) as Partial<RespuestaPaso>;
    const ms = performance.now() - inicio;
    if (ms > LIMITE_PASO_MS) return { ms, ok: false, fueraDeTiempo: true, siguienteNodo: null };
    if (!respuesta.ok || typeof cuerpo.siguienteNodo !== 'string') {
      avisar(`paso-${respuesta.status}`, `POST /paso respondió ${respuesta.status}`);
      return { ms, ok: false, fueraDeTiempo: false, siguienteNodo: null };
    }
    return { ms, ok: true, fueraDeTiempo: false, siguienteNodo: cuerpo.siguienteNodo, refugio: cuerpo.refugio };
  } catch (error) {
    const ms = performance.now() - inicio;
    const tarde = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (!tarde) avisar('paso-error', 'POST /paso falló:', error);
    return { ms, ok: false, fueraDeTiempo: tarde, siguienteNodo: null };
  }
}

/** Rutas completas para dibujar en el mapa; si el motor no responde a tiempo, no se dibujan. */
async function pedirRutas(turno: number): Promise<Record<string, string[]>> {
  try {
    const respuesta = await fetch(`${URL_MOTOR}/rutas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ turno }),
      signal: AbortSignal.timeout(LIMITE_PASO_MS),
    });
    if (!respuesta.ok) return {};
    return ((await respuesta.json()) as Partial<RespuestaRutas>).rutas ?? {};
  } catch {
    return {};
  }
}

// ── El turno ──

async function jugarTurno(p: Partida): Promise<void> {
  const { juego } = p;
  moverZombies(juego);
  const turno = juego.turno;
  try {
    await destino.guardar(estadoTurno(juego));
  } catch (error) {
    avisar(`guardar-${juego.config.ronda}`, `No se pudo guardar el turno ${turno}:`, error);
  }
  if (partida !== p) return;

  const huyendo = juego.sobrevivientes.filter((s) => s.estado === 'huyendo');
  const respuestas = await Promise.all(huyendo.map((s) => pedirPaso(s, turno)));
  const rutas = await pedirRutas(turno);
  if (partida !== p) return;

  const pasos = new Map<string, string | null>();
  const tiemposDelTurno: number[] = [];
  respuestas.forEach((r, k) => {
    const s = huyendo[k]!;
    tiemposDelTurno.push(r.ms);
    if (r.fueraDeTiempo) p.fueraDeTiempo++;
    else if (!r.ok) p.errores++;
    pasos.set(s.id, r.siguienteNodo);
    if (r.refugio) s.refugioAnterior = r.refugio;
  });
  for (const ms of tiemposDelTurno) p.tiempos.push(ms);
  p.rutas = rutas;
  p.errores += aplicarPasos(juego, pasos).invalidos;

  publicarLatencias?.(tiemposDelTurno).catch((error: unknown) =>
    avisar('cloudwatch', 'No se pudo publicar LatenciaPaso:', error),
  );
  if (terminado(juego)) terminar(p);
  actualizarVista();
}

function programar(p: Partida, inicio: number): void {
  // Compensa el desfase: si un turno se atrasó, el siguiente empieza enseguida, sin acumular atraso
  const siguiente = Math.max(inicio + TURNO_MS, Date.now());
  p.reloj = setTimeout(() => void ciclo(p, siguiente), siguiente - Date.now());
}

async function ciclo(p: Partida, inicio: number): Promise<void> {
  if (partida !== p || !p.enCurso) return;
  try {
    await jugarTurno(p);
  } catch (error) {
    console.error('Error en el turno', error);
  }
  if (partida === p && p.enCurso) programar(p, inicio);
}

async function iniciarRonda(ronda: 1 | 2 | 3, semilla: number): Promise<void> {
  detener();
  const juego = crearJuego(grafo, RONDAS[ronda], semilla);
  const p: Partida = { juego, enCurso: true, tiempos: [], errores: 0, fueraDeTiempo: 0, rutas: {} };
  partida = p;
  try {
    await destino.guardar(estadoTurno(juego));
  } catch (error) {
    avisar(`guardar-${ronda}`, 'No se pudo guardar el turno 0:', error);
  }
  console.log(`Empieza la ronda ${ronda} (${RONDAS[ronda].nombre}) con la semilla ${semilla}`);
  actualizarVista();
  programar(p, Date.now());
}

function terminar(p: Partida): void {
  p.enCurso = false;
  clearTimeout(p.reloj);
  const final = resultado(p.juego, resumirLatencias(p.tiempos, p.errores, p.fueraDeTiempo));
  historial.set(final.ronda, final);
  p.juego.eventos.push({ turno: p.juego.turno, texto: `Fin de la ronda: ${final.salvados} de ${final.total} a salvo` });
  console.log(JSON.stringify({ reporte: final }));
}

function detener(): boolean {
  const p = partida;
  if (!p?.enCurso) return false;
  p.enCurso = false;
  clearTimeout(p.reloj);
  p.juego.eventos.push({ turno: p.juego.turno, texto: 'El presentador detuvo la ronda' });
  actualizarVista();
  return true;
}

// ── GET /estado ──

function construirVista(): VistaEstado {
  const actualizadoEn = new Date().toISOString();
  const rondas = [...historial.values()].sort((a, b) => a.ronda - b.ronda);
  const comun = { historial: rondas, puntaje: calcularPuntaje(rondas), actualizadoEn };
  const juego = partida?.juego;
  const refugios = grafo.refugios.map((r, k) => ({
    id: r.id,
    nombre: r.nombre,
    nodo: grafo.ids[r.nodo]!,
    ocupados: juego ? juego.ocupados[k]! : 0,
    capacidad: r.capacidad,
  }));
  if (!partida || !juego) {
    return {
      ronda: null, nombreRonda: null, semilla: null, turno: 0, turnosTotales: 0, enCurso: false,
      zombies: [], aristasBloqueadas: [], sobrevivientes: [], refugios, rutas: {},
      metricas: resumirLatencias([], 0, 0), resultado: null, eventos: [], ...comun,
    };
  }
  const estado = estadoTurno(juego, actualizadoEn);
  const metricas = resumirLatencias(partida.tiempos, partida.errores, partida.fueraDeTiempo);
  return {
    ronda: juego.config.ronda,
    nombreRonda: juego.config.nombre,
    semilla: juego.semilla,
    turno: juego.turno,
    turnosTotales: juego.config.turnos,
    enCurso: partida.enCurso,
    zombies: estado.zombies,
    aristasBloqueadas: estado.aristasBloqueadas,
    sobrevivientes: estado.sobrevivientes,
    refugios,
    rutas: partida.rutas,
    metricas,
    resultado: resultado(juego, metricas),
    eventos: juego.eventos.slice(-20),
    ...comun,
  };
}

/** El mapa consulta /estado cada segundo: se arma y se comprime una sola vez por turno. */
function serializar(v: VistaEstado): { json: string; gzip: Buffer } {
  const json = JSON.stringify(v);
  return { json, gzip: gzipSync(json) };
}

function actualizarVista(): void {
  vista = serializar(construirVista());
}

// ── HTTP ──

function llaveValida(recibida: string | string[] | undefined, esperada: string): boolean {
  if (typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

function responder(res: ServerResponse, estado: number, cuerpo: unknown): void {
  const json = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function leerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of req) {
    total += (parte as Buffer).length;
    if (total > LIMITE_CUERPO) throw new Error('cuerpo demasiado grande');
    partes.push(parte as Buffer);
  }
  if (total === 0) return {};
  const valor: unknown = JSON.parse(Buffer.concat(partes).toString('utf8'));
  if (typeof valor !== 'object' || valor === null) throw new Error('se esperaba un objeto');
  return valor as Record<string, unknown>;
}

function percentil(valores: number[], p: number): number {
  const orden = [...valores].sort((a, b) => a - b);
  const indice = Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1);
  return Math.round((orden[Math.max(0, indice)] ?? 0) * 10) / 10;
}

// Manda pedidos seguidos a POST /paso por la URL pública y mide la latencia desde AWS
async function probarMotor(): Promise<unknown> {
  const tiempos: number[] = [];
  const fallos: string[] = [];
  for (let k = 0; k < PEDIDOS_DE_PRUEBA; k++) {
    const inicio = performance.now();
    try {
      const respuesta = await fetch(`${URL_MOTOR}/paso`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ sobrevivienteId: 'S-9999', nodoActual: grafo.ids[0], turno: 0 }),
        signal: AbortSignal.timeout(LIMITE_PASO_MS),
      });
      await respuesta.json();
      if (!respuesta.ok) fallos.push(`HTTP ${respuesta.status}`);
    } catch (error) {
      fallos.push(error instanceof Error ? error.name : 'error');
    }
    tiempos.push(performance.now() - inicio);
  }
  return {
    pedidos: PEDIDOS_DE_PRUEBA,
    fallos: fallos.length,
    primerFallo: fallos[0] ?? null,
    ms: { p50: percentil(tiempos, 50), p95: percentil(tiempos, 95), max: percentil(tiempos, 100) },
  };
}

async function atenderAdmin(req: IncomingMessage, res: ServerResponse, ruta: string): Promise<void> {
  if (!llaveValida(req.headers['x-admin-key'], ADMIN_KEY)) return responder(res, 401, { error: 'no autorizado' });
  if (req.method !== 'POST') return responder(res, 405, { error: 'usa POST' });
  let cuerpo: Record<string, unknown>;
  try {
    cuerpo = await leerJson(req);
  } catch {
    return responder(res, 400, { error: 'cuerpo inválido' });
  }

  if (ruta === '/admin/ronda') {
    const { ronda, semilla } = cuerpo;
    if (!esRonda(ronda)) return responder(res, 400, { error: 'ronda debe ser 1, 2 o 3' });
    if (semilla !== undefined && (typeof semilla !== 'number' || !Number.isInteger(semilla) || semilla < 0)) {
      return responder(res, 400, { error: 'semilla debe ser un entero positivo' });
    }
    const elegida = (semilla as number | undefined) ?? SEMILLAS[ronda];
    await iniciarRonda(ronda, elegida);
    return responder(res, 200, { ronda, nombre: RONDAS[ronda].nombre, semilla: elegida, turnoMs: TURNO_MS });
  }
  if (ruta === '/admin/bloquear') {
    const { arista } = cuerpo;
    if (!partida?.enCurso) return responder(res, 409, { error: 'no hay una ronda en curso' });
    if (typeof arista !== 'string' || !pedirBloqueo(partida.juego, arista)) {
      return responder(res, 400, { error: 'arista desconocida o ya bloqueada' });
    }
    return responder(res, 200, { arista, desdeTurno: partida.juego.turno + 1 });
  }
  if (ruta === '/admin/detener') return responder(res, 200, { detenida: detener() });
  if (ruta === '/admin/probar-motor') return responder(res, 200, await probarMotor());
  responder(res, 404, { error: 'no encontrado' });
}

async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ruta = (req.url ?? '/').split('?')[0] ?? '/';

  if (req.method === 'GET' && ruta === '/salud') {
    return responder(res, 200, { ok: true, servicio: 'simulador', nodos: grafo.ids.length });
  }

  if (req.method === 'GET' && ruta === '/estado') {
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const cuerpo = gzip ? vista.gzip : Buffer.from(vista.json);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': cuerpo.length,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*', // datos públicos de solo lectura
      vary: 'accept-encoding',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    return void res.end(cuerpo);
  }

  if (ruta.startsWith('/admin/')) return atenderAdmin(req, res, ruta);
  responder(res, 404, { error: 'no encontrado' });
}

const servidor = createServer((req, res) => {
  atender(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) responder(res, 500, { error: 'error interno' });
  });
});

// Mayor que el tiempo de inactividad del ALB (60 s): si Node cierra primero, el ALB devuelve 502
servidor.keepAliveTimeout = 65_000;
servidor.headersTimeout = 66_000;

servidor.listen(PUERTO, () =>
  console.log(`simulador escuchando en el puerto ${PUERTO} con ${grafo.ids.length} nodos; turnos de ${TURNO_MS} ms`),
);
process.on('SIGTERM', () => {
  detener();
  servidor.close(() => process.exit(0));
});
