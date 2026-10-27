// Números al azar con semilla (mulberry32): la misma semilla da la misma partida.

export interface Azar {
  /** Número entre 0 (incluido) y 1 (excluido). */
  siguiente(): number;
  /** Entero entre 0 (incluido) y `tope` (excluido). */
  entero(tope: number): number;
  elegir<T>(lista: readonly T[]): T;
}

export function crearAzar(semilla: number): Azar {
  let a = semilla >>> 0;
  const siguiente = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const entero = (tope: number): number => Math.floor(siguiente() * tope);
  return {
    siguiente,
    entero,
    elegir: <T>(lista: readonly T[]): T => {
      if (lista.length === 0) throw new Error('No hay de dónde elegir');
      return lista[entero(lista.length)]!;
    },
  };
}
