import { describe, expect, it } from 'vitest';
import { crearCuadricula, idNodo } from './cuadricula.js';
import { aristaAbierta, crearGrafo, distanciasEnCalles, indicesDeAristas } from './grafo.js';
import { esMordida, esMovimientoValido, movimientosDeCruce, nodosMortales } from './reglas.js';
import type { MapaBase } from './tipos.js';

const LADO = 10;
const n = (fila: number, columna: number) => idNodo(fila, columna, LADO);
const grafo = crearGrafo(crearCuadricula(LADO));
const i = (id: string) => grafo.indice.get(id)!;
const aristaEntre = (a: string, b: string) => grafo.aristas[aristaAbierta(grafo, i(a), i(b), new Set())]!.id;

describe('grafo', () => {
  it('indexa nodos, aristas y refugios de la cuadrícula', () => {
    expect(grafo.ids).toHaveLength(LADO * LADO);
    expect(grafo.aristas).toHaveLength(2 * LADO * (LADO - 1));
    expect(grafo.refugios.map((r) => r.id)).toEqual(['R-1', 'R-2', 'R-3', 'R-4']);
    expect(grafo.refugioEn[i(n(0, 0))]).toBe(0);
    expect(grafo.vecinos[i(n(5, 5))]).toHaveLength(4);
  });

  it('rechaza aristas que apuntan a nodos que no existen', () => {
    const mapa: MapaBase = {
      nodos: [{ id: 'N-0001', lat: 0, lng: 0 }],
      aristas: [{ id: 'E-0001', a: 'N-0001', b: 'N-0002', distancia_m: 10, tipo: 'calle' }],
      refugios: [],
    };
    expect(() => crearGrafo(mapa)).toThrow(/N-0002/);
  });

  it('elige la calle abierta más rápida cuando hay dos entre el mismo par', () => {
    const mapa: MapaBase = {
      nodos: [{ id: 'N-0001', lat: 0, lng: 0 }, { id: 'N-0002', lat: 0, lng: 0.001 }],
      aristas: [
        { id: 'E-0001', a: 'N-0001', b: 'N-0002', distancia_m: 100, tipo: 'callejon' },
        { id: 'E-0002', a: 'N-0001', b: 'N-0002', distancia_m: 100, tipo: 'avenida' },
      ],
      refugios: [],
    };
    const g = crearGrafo(mapa);
    expect(aristaAbierta(g, 0, 1, new Set())).toBe(1);
    expect(aristaAbierta(g, 0, 1, new Set([1]))).toBe(0);
    expect(aristaAbierta(g, 0, 1, new Set([0, 1]))).toBe(-1);
  });

  it('mide distancias en calles sin pasar por calles bloqueadas', () => {
    const libre = distanciasEnCalles(grafo, [i(n(0, 0))], new Set());
    expect(libre[i(n(0, 3))]).toBe(3);
    const cortada = indicesDeAristas(grafo, [aristaEntre(n(0, 0), n(0, 1))]);
    expect(distanciasEnCalles(grafo, [i(n(0, 0))], cortada)[i(n(0, 3))]).toBe(5);
    expect(distanciasEnCalles(grafo, [i(n(0, 0))], new Set(), 2)[i(n(0, 3))]).toBe(-1);
  });
});

describe('esMovimientoValido', () => {
  it('permite quedarse y moverse a un vecino', () => {
    expect(esMovimientoValido(grafo, n(2, 2), n(2, 2), [])).toBe(true);
    expect(esMovimientoValido(grafo, n(2, 2), n(2, 3), [])).toBe(true);
  });

  it('rechaza saltos, calles bloqueadas y nodos desconocidos', () => {
    expect(esMovimientoValido(grafo, n(2, 2), n(2, 4), [])).toBe(false);
    expect(esMovimientoValido(grafo, n(2, 2), n(3, 3), [])).toBe(false);
    expect(esMovimientoValido(grafo, n(2, 2), n(2, 3), [aristaEntre(n(2, 2), n(2, 3))])).toBe(false);
    expect(esMovimientoValido(grafo, n(2, 2), 'N-9999', [])).toBe(false);
  });
});

describe('mordidas', () => {
  it('la horda hace mortal su nodo y todos sus vecinos', () => {
    const mortal = nodosMortales(grafo, [{ id: 'Z-001', tipo: 'horda', nodo: n(4, 4) }]);
    for (const id of [n(4, 4), n(3, 4), n(5, 4), n(4, 3), n(4, 5)]) expect(mortal[i(id)]).toBe(1);
    expect(mortal[i(n(3, 3))]).toBe(0);
    expect(mortal[i(n(4, 6))]).toBe(0);
  });

  it('un caminante solo hace mortal su propio nodo', () => {
    const mortal = nodosMortales(grafo, [{ id: 'Z-001', tipo: 'caminante', nodo: n(4, 4) }]);
    expect(mortal[i(n(4, 4))]).toBe(1);
    expect(mortal[i(n(4, 5))]).toBe(0);
  });

  it('cruzarse con un zombie por la misma calle en sentido contrario es mordida', () => {
    const zombies = [{ id: 'Z-001', tipo: 'corredor' as const, nodo: n(2, 4), recorrido: [n(2, 2), n(2, 3), n(2, 4)] }];
    const mortal = nodosMortales(grafo, zombies);
    const cruces = movimientosDeCruce(grafo, zombies);
    // El corredor fue 2,3 → 2,4: quien está en 2,4 no puede ir a 2,3 (y además 2,4 es mortal)
    expect(esMordida(grafo, i(n(2, 4)), i(n(2, 3)), mortal, cruces)).toBe(true);
    // Fue 2,2 → 2,3: quien está en 2,3 no puede ir a 2,2
    expect(esMordida(grafo, i(n(2, 3)), i(n(2, 2)), mortal, cruces)).toBe(true);
    // Ir en el mismo sentido que el zombie no es cruce
    expect(esMordida(grafo, i(n(2, 2)), i(n(2, 3)), mortal, cruces)).toBe(false);
    expect(esMordida(grafo, i(n(1, 3)), i(n(0, 3)), mortal, cruces)).toBe(false);
  });
});
