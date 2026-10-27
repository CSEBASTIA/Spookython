// Las 3 rondas de la prueba de fuego (sección 6 de docs/plan.md). Las cantidades
// de zombies son la propuesta inicial; se ajustan con el banco para que sean difíciles pero justas.
// En el mapa de Manta casi todos llegan a un refugio en menos de 40 turnos, así que los eventos
// van temprano: si no, la ronda termina antes y el jurado no los ve.
import type { TipoZombie } from '../../compartido/src/tipos.js';

export type TipoEvento = 'colapso-puente' | 'bloqueo-calle';

export interface EventoProgramado {
  turno: number;
  tipo: TipoEvento;
}

export interface ConfigRonda {
  ronda: 1 | 2 | 3;
  nombre: string;
  sobrevivientes: number;
  zombies: Readonly<Record<TipoZombie, number>>;
  eventos: readonly EventoProgramado[];
  /** 150 turnos de 2 s son los 5 minutos de cada ronda; termina antes si ya nadie huye. */
  turnos: number;
}

export const RONDAS: Readonly<Record<1 | 2 | 3, ConfigRonda>> = {
  1: {
    ronda: 1,
    nombre: 'Anochecer',
    sobrevivientes: 20,
    zombies: { caminante: 15, corredor: 0, horda: 0, dormido: 0 },
    eventos: [],
    turnos: 150,
  },
  2: {
    ronda: 2,
    nombre: 'Medianoche',
    sobrevivientes: 80,
    zombies: { caminante: 20, corredor: 8, horda: 3, dormido: 0 },
    eventos: [{ turno: 10, tipo: 'colapso-puente' }],
    turnos: 150,
  },
  3: {
    ronda: 3,
    nombre: 'Apocalipsis',
    sobrevivientes: 200,
    zombies: { caminante: 30, corredor: 12, horda: 4, dormido: 15 },
    eventos: [
      { turno: 8, tipo: 'bloqueo-calle' },
      { turno: 16, tipo: 'bloqueo-calle' },
    ],
    turnos: 150,
  },
};

export function esRonda(valor: unknown): valor is 1 | 2 | 3 {
  return valor === 1 || valor === 2 || valor === 3;
}
