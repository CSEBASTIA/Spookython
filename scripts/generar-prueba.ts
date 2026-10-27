// Escribe data/prueba.json: la cuadrícula de 10×10 de las pruebas, con el formato de data/manta.json.
// Sirve para trabajar mientras no está el grafo real de Manta.
//   npm run mapa:prueba
import { mkdirSync, writeFileSync } from 'node:fs';
import { crearCuadricula } from '../src/compartido/src/cuadricula.js';

mkdirSync('data', { recursive: true });
writeFileSync('data/prueba.json', `${JSON.stringify(crearCuadricula(10), null, 2)}\n`);
console.log('data/prueba.json listo');
