// Banco de pruebas: juega partidas completas con el núcleo del simulador y el motor en memoria,
// sin red. Sirve para medir supervivencia y eficiencia y para ajustar los pesos del planificador.
import type { Grafo } from '../../compartido/src/grafo.js';
import type { ResultadoRonda } from '../../compartido/src/tipos.js';
import { aplicarPasos, crearJuego, estadoTurno, moverZombies, resultado, terminado } from '../../simulador/src/juego.js';
import type { ConfigRonda } from '../../simulador/src/rondas.js';
import { construirPlan, decidirPaso, PARAMETROS, type Parametros } from './planificador.js';

const SIN_LATENCIA = { pedidos: 0, errores: 0, fueraDeTiempo: 0, p50: null, p95: null, p99: null };

export interface Partida extends ResultadoRonda {
  /** Milisegundos promedio que tarda el motor en armar el plan y decidir todos los pasos de un turno. */
  msPorTurno: number;
}

export function jugarPartida(
  grafo: Grafo,
  config: ConfigRonda,
  semilla: number,
  parametros: Readonly<Parametros> = PARAMETROS,
): Partida {
  const juego = crearJuego(grafo, config, semilla);
  let ms = 0;
  while (!terminado(juego)) {
    moverZombies(juego);
    const inicio = performance.now();
    const plan = construirPlan(grafo, estadoTurno(juego, ''), parametros);
    const pasos = new Map<string, string>();
    for (const s of juego.sobrevivientes) {
      if (s.estado !== 'huyendo') continue;
      const respuesta = decidirPaso(plan, s.id, grafo.ids[s.nodo]!);
      pasos.set(s.id, respuesta.siguienteNodo);
      s.refugioAnterior = respuesta.refugio ?? null;
    }
    ms += performance.now() - inicio;
    aplicarPasos(juego, pasos);
  }
  return { ...resultado(juego, SIN_LATENCIA), msPorTurno: ms / Math.max(1, juego.turno) };
}
