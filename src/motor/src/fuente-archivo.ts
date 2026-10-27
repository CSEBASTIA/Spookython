// Fuente para probar el motor en local sin DynamoDB: lee el estado de un archivo JSON
// en cada pedido de plan (ESTADO_ARCHIVO=data/estado-ejemplo.json).
import { readFile } from 'node:fs/promises';
import type { EstadoTurno } from '../../compartido/src/tipos.js';
import type { FuenteEstado } from './planes.js';

export function fuenteArchivo(ruta: string): FuenteEstado {
  return {
    async leer() {
      return JSON.parse(await readFile(ruta, 'utf8')) as EstadoTurno;
    },
  };
}
