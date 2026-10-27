// Mapa falso en cuadrícula para pruebas: mismo formato que data/manta.json.
import type { Arista, MapaBase, Nodo, TipoCalle } from './tipos.js';

const BARRIOS = ['Tarqui', 'Los Esteros', 'Barbasquillo', 'Jocay'] as const;

export const idNodo = (fila: number, columna: number, lado: number): string =>
  `N-${String(fila * lado + columna).padStart(4, '0')}`;

/**
 * Cuadrícula de `lado`×`lado` intersecciones separadas unos 100 m, con un refugio en
 * cada esquina (capacidades 80, 70, 60 y 30). La fila y la columna centrales son
 * avenidas, el borde son callejones y una calle de la columna central es un puente.
 */
export function crearCuadricula(lado = 10): MapaBase {
  const nodos: Nodo[] = [];
  const mitad = Math.floor(lado / 2);
  for (let f = 0; f < lado; f++) {
    for (let c = 0; c < lado; c++) {
      const barrio = BARRIOS[(f < mitad ? 0 : 2) + (c < mitad ? 0 : 1)]!;
      nodos.push({ id: idNodo(f, c, lado), lat: -0.945 - f * 0.0009, lng: -80.735 + c * 0.0009, barrio });
    }
  }

  const aristas: Arista[] = [];
  const agregar = (a: string, b: string, tipo: TipoCalle) => {
    aristas.push({ id: `E-${String(aristas.length).padStart(4, '0')}`, a, b, distancia_m: 100, tipo });
  };
  const tipoDe = (f1: number, c1: number, f2: number, c2: number): TipoCalle => {
    if (c1 === mitad && c2 === mitad && Math.min(f1, f2) === mitad - 1) return 'puente';
    if ((f1 === mitad && f2 === mitad) || (c1 === mitad && c2 === mitad)) return 'avenida';
    const borde = (f: number, c: number) => f === 0 || c === 0 || f === lado - 1 || c === lado - 1;
    if (borde(f1, c1) && borde(f2, c2)) return 'callejon';
    return 'calle';
  };
  for (let f = 0; f < lado; f++) {
    for (let c = 0; c < lado; c++) {
      if (c + 1 < lado) agregar(idNodo(f, c, lado), idNodo(f, c + 1, lado), tipoDe(f, c, f, c + 1));
      if (f + 1 < lado) agregar(idNodo(f, c, lado), idNodo(f + 1, c, lado), tipoDe(f, c, f + 1, c));
    }
  }

  const ultimo = lado - 1;
  const refugios = [
    { id: 'R-1', nodo: idNodo(0, 0, lado), nombre: 'Refugio noroeste', capacidad: 80 },
    { id: 'R-2', nodo: idNodo(0, ultimo, lado), nombre: 'Refugio noreste', capacidad: 70 },
    { id: 'R-3', nodo: idNodo(ultimo, 0, lado), nombre: 'Refugio suroeste', capacidad: 60 },
    { id: 'R-4', nodo: idNodo(ultimo, ultimo, lado), nombre: 'Refugio sureste', capacidad: 30 },
  ];
  return { nodos, aristas, refugios };
}
