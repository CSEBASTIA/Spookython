// Banco de pruebas del motor: juega muchas partidas sin red y muestra supervivencia y eficiencia.
//   npm run banco                              (las 3 rondas, 20 partidas cada una)
//   npm run banco -- --ronda 3 --partidas 100
//   npm run banco -- --mapa data/prueba.json
import { existsSync } from 'node:fs';
import { crearGrafo, leerMapa } from '../src/compartido/src/grafo.js';
import { jugarPartida, type Partida } from '../src/motor/src/banco.js';
import { calcularPuntaje } from '../src/simulador/src/puntaje.js';
import { RONDAS, esRonda } from '../src/simulador/src/rondas.js';

function opcion(nombre: string): string | undefined {
  const k = process.argv.indexOf(`--${nombre}`);
  return k === -1 ? undefined : process.argv[k + 1];
}

const rutaMapa = opcion('mapa') ?? (existsSync('data/manta.json') ? 'data/manta.json' : 'data/prueba.json');
const partidas = Number(opcion('partidas') ?? 20);
const rondaPedida = opcion('ronda') ? Number(opcion('ronda')) : null;
const rondas = rondaPedida === null ? [1, 2, 3] : [rondaPedida];
if (!rondas.every(esRonda) || !Number.isInteger(partidas) || partidas < 1) {
  console.error('Uso: npm run banco -- [--ronda 1|2|3] [--partidas N] [--mapa ruta.json]');
  process.exit(1);
}

const grafo = crearGrafo(leerMapa(rutaMapa));
console.log(`Mapa ${rutaMapa}: ${grafo.ids.length} nodos, ${grafo.aristas.length} calles, ${grafo.refugios.length} refugios · ${partidas} partidas por ronda\n`);

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
const promedio = (valores: number[]) => valores.reduce((a, b) => a + b, 0) / Math.max(1, valores.length);
const resumenes: Partida[] = [];

for (const r of rondas as (1 | 2 | 3)[]) {
  const config = RONDAS[r];
  const jugadas = Array.from({ length: partidas }, (_, k) => jugarPartida(grafo, config, 1000 * r + k));
  const supervivencia = jugadas.map((p) => p.salvados / p.total);
  const total = jugadas.reduce((s, p) => s + p.total, 0);
  const sumar = (campo: 'salvados' | 'mordidos' | 'sinLlegar') => jugadas.reduce((s, p) => s + p[campo], 0);
  console.log(`R${r} · ${config.nombre} (${config.sobrevivientes} sobrevivientes)`);
  console.log(`  supervivencia ${pct(promedio(supervivencia))} (peor ${pct(Math.min(...supervivencia))}, mejor ${pct(Math.max(...supervivencia))})`);
  console.log(`  salvados ${pct(sumar('salvados') / total)} · mordidos ${pct(sumar('mordidos') / total)} · sin llegar ${pct(sumar('sinLlegar') / total)}`);
  console.log(`  eficiencia ${pct(promedio(jugadas.map((p) => p.eficiencia ?? 0)))} · motor ${promedio(jugadas.map((p) => p.msPorTurno)).toFixed(2)} ms por turno\n`);

  // Para el puntaje, una «ronda promedio» con los totales de todas las partidas
  const salvados = sumar('salvados');
  resumenes.push({
    ...jugadas[0]!,
    total,
    salvados,
    mordidos: sumar('mordidos'),
    sinLlegar: sumar('sinLlegar'),
    eficiencia: salvados > 0 ? jugadas.reduce((s, p) => s + (p.eficiencia ?? 0) * p.salvados, 0) / salvados : null,
  });
}

const puntaje = calcularPuntaje(resumenes)!;
console.log(`Supervivencia ${puntaje.supervivencia.toFixed(2)}/10 · eficiencia ${puntaje.eficiencia.toFixed(2)}/10 (rondas ${puntaje.rondas.join(', ')})`);
console.log('La latencia y la disponibilidad se miden con el simulador contra la URL real del motor.');
