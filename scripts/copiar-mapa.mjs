// Copia el mapa base al dist de un servicio para que vaya dentro de la imagen (dist/mapa.json).
// Usa data/manta.json si existe; mientras no esté el grafo real, data/prueba.json.
//   node ../../scripts/copiar-mapa.mjs dist
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destino = resolve(process.argv[2] ?? 'dist');
const origen = ['manta.json', 'prueba.json'].map((f) => join(raiz, 'data', f)).find((f) => existsSync(f));
if (!origen) {
  console.error('No hay mapa: falta data/manta.json o data/prueba.json (npm run mapa:prueba genera el de prueba)');
  process.exit(1);
}
mkdirSync(destino, { recursive: true });
copyFileSync(origen, join(destino, 'mapa.json'));
console.log(`mapa: ${relative(raiz, origen)} → ${relative(raiz, join(destino, 'mapa.json'))}`);
