import { describe, expect, it } from 'vitest';
import { crearCuadricula, idNodo } from '../../compartido/src/cuadricula.js';
import { aristaAbierta, crearGrafo, distanciasEnCalles } from '../../compartido/src/grafo.js';
import type { TipoZombie } from '../../compartido/src/tipos.js';
import { jugarPartida } from '../../motor/src/banco.js';
import {
  aplicarPasos,
  crearJuego,
  estadoTurno,
  moverZombies,
  pedirBloqueo,
  resultado,
  terminado,
  type Juego,
} from './juego.js';
import { calcularPuntaje, resumirLatencias } from './puntaje.js';
import { RONDAS, type ConfigRonda } from './rondas.js';

const LADO = 10;
const n = (fila: number, columna: number) => idNodo(fila, columna, LADO);
const grafo = crearGrafo(crearCuadricula(LADO));
const i = (id: string) => grafo.indice.get(id)!;
const SIN_LATENCIA = resumirLatencias([], 0, 0);

/** Ronda a medida: sin eventos, con los zombies pedidos. */
function ronda(sobrevivientes: number, zombies: Partial<Record<TipoZombie, number>>): ConfigRonda {
  return {
    ronda: 1,
    nombre: 'Prueba',
    sobrevivientes,
    zombies: { caminante: 0, corredor: 0, horda: 0, dormido: 0, ...zombies },
    eventos: [],
    turnos: 150,
  };
}

/** Pone a cada uno donde diga la prueba, sin importar dónde lo dejó el reparto inicial. */
function ubicar(juego: Juego, sobrevivientes: string[], zombies: string[]): void {
  sobrevivientes.forEach((nodo, k) => (juego.sobrevivientes[k]!.nodo = i(nodo)));
  zombies.forEach((nodo, k) => {
    juego.zombies[k]!.nodo = i(nodo);
    juego.zombies[k]!.recorrido = [i(nodo)];
  });
}

const quedarse = (juego: Juego) => new Map(juego.sobrevivientes.map((s) => [s.id, grafo.ids[s.nodo]!]));

describe('reparto inicial', () => {
  it('con la misma semilla juega la misma partida', () => {
    const a = crearJuego(grafo, RONDAS[3], 7);
    const b = crearJuego(grafo, RONDAS[3], 7);
    for (let t = 0; t < 20; t++) {
      moverZombies(a);
      moverZombies(b);
      aplicarPasos(a, quedarse(a));
      aplicarPasos(b, quedarse(b));
    }
    expect(estadoTurno(a, 'x')).toEqual(estadoTurno(b, 'x'));
    expect(estadoTurno(crearJuego(grafo, RONDAS[3], 8), 'x')).not.toEqual(estadoTurno(crearJuego(grafo, RONDAS[3], 7), 'x'));
  });

  it('reparte sobrevivientes entre los 4 barrios, lejos de los refugios', () => {
    const juego = crearJuego(grafo, RONDAS[1], 1);
    const porBarrio = new Map<string, number>();
    for (const s of juego.sobrevivientes) {
      expect(grafo.refugioEn[s.nodo]).toBe(-1);
      expect(juego.distanciaRefugio[s.nodo]).toBeGreaterThanOrEqual(2);
      expect(s.minimo).toBe(juego.distanciaRefugio[s.nodo]);
      const barrio = grafo.barrios[s.nodo]!;
      porBarrio.set(barrio, (porBarrio.get(barrio) ?? 0) + 1);
    }
    expect([...porBarrio.values()]).toEqual([5, 5, 5, 5]);
  });

  it('pone a los zombies fuera de los refugios, uno por nodo, y las hordas lejos de los refugios', () => {
    const juego = crearJuego(grafo, RONDAS[2], 3);
    const nodos = juego.zombies.map((z) => z.nodo);
    expect(new Set(nodos).size).toBe(nodos.length);
    for (const z of juego.zombies) {
      expect(grafo.refugioEn[z.nodo]).toBe(-1);
      if (z.tipo === 'horda') expect(juego.distanciaRefugio[z.nodo]).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('zombies', () => {
  it('el caminante da 1 paso cada 2 turnos, al azar y por calles abiertas', () => {
    const juego = crearJuego(grafo, ronda(1, { caminante: 1 }), 5);
    ubicar(juego, [n(0, 5)], [n(5, 5)]);
    let pasos = 0;
    for (let t = 0; t < 10; t++) {
      const antes = juego.zombies[0]!.nodo;
      moverZombies(juego);
      const z = juego.zombies[0]!;
      if (z.nodo !== antes) {
        pasos++;
        expect(aristaAbierta(grafo, antes, z.nodo, juego.bloqueadas)).not.toBe(-1);
        expect(z.recorrido).toEqual([antes, z.nodo]);
      }
    }
    expect(pasos).toBe(5);
  });

  it('el corredor persigue al sobreviviente que tiene a 3 nodos y avanza 2 calles', () => {
    const juego = crearJuego(grafo, ronda(1, { corredor: 1 }), 5);
    ubicar(juego, [n(5, 8)], [n(5, 5)]);
    moverZombies(juego);
    expect(juego.zombies[0]!.recorrido).toEqual([i(n(5, 5)), i(n(5, 6)), i(n(5, 7))]);
  });

  it('el corredor sin nadie cerca camina 2 calles al azar sin volver atrás', () => {
    const juego = crearJuego(grafo, ronda(1, { corredor: 1 }), 5);
    ubicar(juego, [n(0, 0)], [n(6, 6)]);
    moverZombies(juego);
    const [a, , c] = juego.zombies[0]!.recorrido;
    expect(juego.zombies[0]!.recorrido).toHaveLength(3);
    expect(c).not.toBe(a);
  });

  it('la horda casi no se mueve', () => {
    const juego = crearJuego(grafo, ronda(1, { horda: 1 }), 5);
    ubicar(juego, [n(0, 5)], [n(5, 5)]);
    let pasos = 0;
    for (let t = 0; t < 30; t++) {
      const antes = juego.zombies[0]!.nodo;
      moverZombies(juego);
      if (juego.zombies[0]!.nodo !== antes) pasos++;
    }
    expect(pasos).toBeLessThanOrEqual(3);
  });

  it('el dormido es invisible hasta que alguien pasa a 2 nodos; ahí despierta como caminante', () => {
    const juego = crearJuego(grafo, ronda(1, { dormido: 1 }), 5);
    ubicar(juego, [n(5, 1)], [n(5, 5)]);
    moverZombies(juego);
    expect(estadoTurno(juego).zombies).toHaveLength(0);
    juego.sobrevivientes[0]!.nodo = i(n(5, 3));
    moverZombies(juego);
    expect(estadoTurno(juego).zombies).toEqual([expect.objectContaining({ id: 'Z-000', tipo: 'caminante', nodo: n(5, 5) })]);
    expect(juego.eventos.at(-1)!.texto).toContain('despertó');
  });
});

describe('mordidas y llegadas', () => {
  it('muerde a quien termina en el nodo de un zombie, aunque esté dormido', () => {
    const juego = crearJuego(grafo, ronda(2, { caminante: 1, dormido: 1 }), 5);
    ubicar(juego, [n(4, 4), n(7, 3)], [n(4, 5), n(7, 2)]);
    const resumen = aplicarPasos(juego, new Map([['S-0000', n(4, 5)], ['S-0001', n(7, 2)]]));
    expect(resumen.mordidos).toEqual(['S-0000', 'S-0001']);
  });

  it('muerde a quien se cruza con un zombie por la misma calle', () => {
    const juego = crearJuego(grafo, ronda(1, { corredor: 1 }), 5);
    ubicar(juego, [n(5, 6)], [n(5, 4)]);
    juego.zombies[0]!.nodo = i(n(5, 7));
    juego.zombies[0]!.recorrido = [i(n(5, 5)), i(n(5, 6)), i(n(5, 7))];
    // Ir a 5,5 es cruzarse: el corredor acaba de pasar de 5,5 a 5,6
    expect(aplicarPasos(juego, new Map([['S-0000', n(5, 5)]])).mordidos).toEqual(['S-0000']);
  });

  it('la horda muerde en su nodo y en todos sus vecinos', () => {
    const juego = crearJuego(grafo, ronda(2, { horda: 1 }), 5);
    ubicar(juego, [n(4, 4), n(4, 6)], [n(4, 5)]);
    const resumen = aplicarPasos(juego, new Map([['S-0000', n(4, 4)], ['S-0001', n(3, 6)]]));
    expect(resumen.mordidos).toEqual(['S-0000']);
  });

  it('un paso inválido cuenta como quedarse', () => {
    const juego = crearJuego(grafo, ronda(1, {}), 5);
    ubicar(juego, [n(4, 4)], []);
    const resumen = aplicarPasos(juego, new Map([['S-0000', n(6, 6)]]));
    expect(resumen.invalidos).toBe(1);
    expect(juego.sobrevivientes[0]!.nodo).toBe(i(n(4, 4)));
  });

  it('nadie entra a un refugio lleno', () => {
    const juego = crearJuego(grafo, ronda(2, {}), 5);
    ubicar(juego, [n(0, 1), n(9, 8)], []);
    juego.ocupados[0] = grafo.refugios[0]!.capacidad;
    const resumen = aplicarPasos(juego, new Map([['S-0000', n(0, 0)], ['S-0001', n(9, 9)]]));
    expect(resumen.llegados).toEqual(['S-0001']);
    expect(juego.sobrevivientes[0]!.estado).toBe('huyendo');
    expect(juego.eventos.at(-2)!.texto).toContain('lleno');
  });
});

describe('eventos de la ciudad', () => {
  it('en la ronda 2 colapsa un puente sin aislar a nadie', () => {
    const juego = crearJuego(grafo, RONDAS[2], 11);
    const turno = RONDAS[2].eventos[0]!.turno;
    for (let t = 0; t < turno - 1; t++) moverZombies(juego);
    expect(estadoTurno(juego).aristasBloqueadas).toEqual([]);
    moverZombies(juego);
    const bloqueadas = estadoTurno(juego).aristasBloqueadas;
    expect(bloqueadas).toHaveLength(1);
    expect(grafo.aristas[grafo.indiceArista.get(bloqueadas[0]!)!]!.tipo).toBe('puente');
    const distancia = distanciasEnCalles(grafo, grafo.refugios.map((r) => r.nodo), juego.bloqueadas);
    expect([...distancia].every((d) => d !== -1)).toBe(true);
  });

  it('el bloqueo del presentador se aplica al empezar el turno siguiente', () => {
    const juego = crearJuego(grafo, RONDAS[1], 11);
    const calle = grafo.aristas[0]!.id;
    expect(pedirBloqueo(juego, calle)).toBe(true);
    expect(pedirBloqueo(juego, 'E-9999')).toBe(false);
    expect(estadoTurno(juego).aristasBloqueadas).toEqual([]);
    moverZombies(juego);
    expect(estadoTurno(juego).aristasBloqueadas).toEqual([calle]);
  });
});

describe('resultado y puntaje', () => {
  it('la ronda termina a los 150 turnos o cuando ya nadie huye', () => {
    const juego = crearJuego(grafo, ronda(1, {}), 5);
    expect(terminado(juego)).toBe(false);
    juego.sobrevivientes[0]!.estado = 'a_salvo';
    expect(terminado(juego)).toBe(true);
  });

  it('calcula la supervivencia ponderada y las notas de latencia y disponibilidad', () => {
    const latencia = resumirLatencias(Array.from({ length: 100 }, (_, k) => k + 1), 0, 0);
    const base = { semilla: 1, turnos: 150, mordidos: 0, sinLlegar: 0, eficiencia: 1, latencia };
    const puntaje = calcularPuntaje([
      { ...base, ronda: 1, total: 20, salvados: 20 },
      { ...base, ronda: 2, total: 80, salvados: 40 },
      { ...base, ronda: 3, total: 200, salvados: 100 },
    ])!;
    expect(puntaje.supervivencia).toBeCloseTo((10 * (1 + 2 * 0.5 + 3 * 0.5)) / 6, 2);
    expect(puntaje.eficiencia).toBe(10);
    expect(puntaje.latencia).toBe(10); // p95 = 95 ms
    expect(puntaje.disponibilidad).toBe(10);
  });
});

describe('motor contra simulador (banco)', () => {
  it('en la ronda 1 el motor salva a casi todos y por caminos cortos', () => {
    const partidas = [1, 2, 3, 4, 5].map((semilla) => jugarPartida(grafo, RONDAS[1], semilla));
    const salvados = partidas.reduce((s, p) => s + p.salvados, 0) / partidas.reduce((s, p) => s + p.total, 0);
    const eficiencia = partidas.reduce((s, p) => s + (p.eficiencia ?? 0), 0) / partidas.length;
    expect(salvados).toBeGreaterThanOrEqual(0.9);
    expect(eficiencia).toBeGreaterThan(0.7);
  });

  it('el resultado cuenta salvados, mordidos y los que no llegaron', () => {
    const p = jugarPartida(grafo, RONDAS[3], 9);
    expect(p.salvados + p.mordidos + p.sinLlegar).toBe(p.total);
    expect(resultado(crearJuego(grafo, RONDAS[1], 1), SIN_LATENCIA).salvados).toBe(0);
  });
});
