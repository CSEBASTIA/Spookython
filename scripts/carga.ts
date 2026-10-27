// Prueba de carga contra el motor: 200 POST /paso a la vez cada 2 s durante 5 minutos,
// como en la ronda 3, y al final el p50/p95/p99 y la tasa de errores con las notas de la rúbrica.
//   URL=https://dxxxx.cloudfront.net API_KEY=... npm run carga
//   URL=http://localhost:8080 API_KEY=llave-local npm run carga -- --segundos 30
import { existsSync } from 'node:fs';
import { leerMapa } from '../src/compartido/src/grafo.js';
import { LIMITE_PASO_MS, notaDisponibilidad, notaLatencia, resumirLatencias } from '../src/simulador/src/puntaje.js';

function opcion(nombre: string, porOmision: number): number {
  const k = process.argv.indexOf(`--${nombre}`);
  const valor = k === -1 ? porOmision : Number(process.argv[k + 1]);
  if (!Number.isFinite(valor) || valor <= 0) throw new Error(`--${nombre} debe ser un número positivo`);
  return valor;
}

const URL_MOTOR = (process.env.URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.API_KEY ?? '';
if (!URL_MOTOR || !API_KEY) {
  console.error('Uso: URL=https://... API_KEY=... npm run carga -- [--segundos 300] [--concurrencia 200] [--cada-ms 2000]');
  process.exit(1);
}
const segundos = opcion('segundos', 300);
const concurrencia = opcion('concurrencia', 200);
const cadaMs = opcion('cada-ms', 2000);

const mapa = leerMapa(existsSync('data/manta.json') ? 'data/manta.json' : 'data/prueba.json');
const nodos = mapa.nodos.map((n) => n.id);
const tiempos: number[] = [];
let errores = 0;
let fueraDeTiempo = 0;

async function pedir(k: number, turno: number): Promise<void> {
  const inicio = performance.now();
  try {
    const respuesta = await fetch(`${URL_MOTOR}/paso`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        sobrevivienteId: `S-${String(k).padStart(4, '0')}`,
        nodoActual: nodos[(k * 7919 + turno) % nodos.length],
        turno,
      }),
      signal: AbortSignal.timeout(LIMITE_PASO_MS),
    });
    await respuesta.json();
    const ms = performance.now() - inicio;
    tiempos.push(ms);
    if (ms > LIMITE_PASO_MS) fueraDeTiempo++;
    else if (!respuesta.ok) errores++;
  } catch (error) {
    tiempos.push(performance.now() - inicio);
    if (error instanceof Error && error.name === 'TimeoutError') fueraDeTiempo++;
    else errores++;
  }
}

async function principal(): Promise<void> {
  console.log(`${concurrencia} pedidos a la vez cada ${cadaMs} ms durante ${segundos} s contra ${URL_MOTOR}/paso`);
  const fin = Date.now() + segundos * 1000;
  for (let turno = 1; Date.now() < fin; turno++) {
    const inicio = Date.now();
    await Promise.all(Array.from({ length: concurrencia }, (_, k) => pedir(k, turno)));
    if (turno % 10 === 0) {
      const parcial = resumirLatencias(tiempos, errores, fueraDeTiempo);
      console.log(`turno ${turno}: p95 ${parcial.p95} ms · ${errores + fueraDeTiempo} fallidos de ${parcial.pedidos}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, cadaMs - (Date.now() - inicio))));
  }
  const m = resumirLatencias(tiempos, errores, fueraDeTiempo);
  const fallidos = errores + fueraDeTiempo;
  console.log(`\n${m.pedidos} pedidos · p50 ${m.p50} ms · p95 ${m.p95} ms · p99 ${m.p99} ms`);
  console.log(`errores ${errores} · fuera de tiempo ${fueraDeTiempo} (${((100 * fallidos) / Math.max(1, m.pedidos)).toFixed(2)} %)`);
  console.log(`Nota de latencia ${notaLatencia(m.p95)}/10 · nota de disponibilidad ${notaDisponibilidad(fallidos, m.pedidos)}/10`);
}

principal().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
