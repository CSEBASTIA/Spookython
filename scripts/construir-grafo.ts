// Construye data/manta.json desde OpenStreetMap (sección 6 de docs/plan.md).
//   npm run grafo                  usa data/raw/overpass-vias.json si ya está descargado
//   npm run grafo -- --descargar   vuelve a bajar las vías de Overpass
//
// 1. Vías de la caja de Manta: avenidas en toda la caja; calles y callejones solo cerca
//    de los 4 barrios y de los 4 refugios (el radio se ajusta solo para llegar a ~300 nodos).
// 2. Los nodos son las intersecciones; las que están a menos de 25 m se fusionan.
// 3. Cada arista es un tramo entre intersecciones, con su distancia (haversine) y su tipo.
// 4. Componente conexo más grande y nodos de paso (grado 2) contraídos.
// Datos © OpenStreetMap contributors, licencia ODbL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { crearGrafo, distanciasEnCalles } from '../src/compartido/src/grafo.js';
import type { Arista, MapaBase, Nodo, TipoCalle } from '../src/compartido/src/tipos.js';

/** Caja de la descarga. */
const CAJA = { sur: -0.98, oeste: -80.77, norte: -0.93, este: -80.68 };
/** Caja del juego: los 4 barrios y los 4 refugios con unos 600 m de margen. Las vías se cortan en su borde. */
const CAJA_JUEGO = { sur: -0.97, oeste: -80.76, norte: -0.937, este: -80.686 };
/** Las calles residenciales cerca de un refugio entran hasta esta distancia, para que quede bien conectado. */
const RADIO_REFUGIO_M = 150;
const RUTA_CRUDA = 'data/raw/overpass-vias.json';
const RUTA_SALIDA = 'data/manta.json';
const OBJETIVO_NODOS = { minimo: 270, maximo: 330 };
const FUSION_M = 25;
/** Un nodo pertenece a un barrio si está a esta distancia o menos de su centro. */
const RADIO_BARRIO_M = 800;

/** Centros de los barrios: nodos `place` de OpenStreetMap. */
const BARRIOS = [
  { nombre: 'Barbasquillo', lat: -0.95154, lng: -80.75272 }, // place=quarter «Barbasquillo»
  { nombre: 'Jocay', lat: -0.95987, lng: -80.71611 }, // place=neighbourhood «Jocay»
  { nombre: 'Los Esteros', lat: -0.96215, lng: -80.69227 }, // place=suburb «Los Esteros»
  { nombre: 'Tarqui', lat: -0.95326, lng: -80.7152 }, // place=neighbourhood «Tarqui Centro»
] as const;

/** Refugios en lugares reconocibles de Manta (centro del lugar en OpenStreetMap). Suman 240. */
const REFUGIOS = [
  { id: 'R-1', nombre: 'Mall del Pacífico', lat: -0.94274, lng: -80.73233, capacidad: 80 },
  { id: 'R-2', nombre: 'Estadio Municipal Jocay', lat: -0.96397, lng: -80.70275, capacidad: 70 },
  { id: 'R-3', nombre: 'Hospital Rodríguez Zambrano', lat: -0.95381, lng: -80.74238, capacidad: 60 },
  { id: 'R-4', nombre: 'Megaparque Centenario', lat: -0.9487, lng: -80.71868, capacidad: 30 },
] as const;

interface ElementoOsm {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

// ── Descarga ──

async function descargar(): Promise<void> {
  const consulta = `[out:json][timeout:150];
way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|pedestrian)$"](${CAJA.sur},${CAJA.oeste},${CAJA.norte},${CAJA.este});
(._;>;);
out body;`;
  console.log('Descargando vías de Overpass…');
  const respuesta = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'manta-zombie-hackathon/1.0' },
    body: `data=${encodeURIComponent(consulta)}`,
    signal: AbortSignal.timeout(170_000),
  });
  if (!respuesta.ok) throw new Error(`Overpass respondió ${respuesta.status}; reintenta en unos minutos`);
  mkdirSync('data/raw', { recursive: true });
  writeFileSync(RUTA_CRUDA, await respuesta.text());
}

// ── Geometría ──

function metros(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}

function tipoDe(tags: Record<string, string>): TipoCalle {
  if (tags.bridge === 'yes') return 'puente';
  const h = tags.highway ?? '';
  if (/^(trunk|primary|secondary)(_link)?$/.test(h)) return 'avenida';
  if (h === 'living_street' || h === 'pedestrian') return 'callejon';
  return 'calle';
}

/** Las avenidas y las calles terciarias se toman en toda la caja del juego; el resto, solo cerca de barrios y refugios. */
function esPrincipal(tags: Record<string, string>): boolean {
  return /^(trunk|primary|secondary|tertiary)(_link)?$/.test(tags.highway ?? '');
}

// ── Construcción ──

interface Tramo {
  a: number;
  b: number;
  distancia: number;
  tipo: TipoCalle;
  nombre?: string;
}

interface Resultado {
  nodos: Map<number, { lat: number; lng: number }>;
  tramos: Tramo[];
}

function construir(elementos: ElementoOsm[], radio: number): Resultado {
  const posicion = new Map<number, { lat: number; lng: number }>();
  for (const e of elementos) if (e.type === 'node') posicion.set(e.id, { lat: e.lat!, lng: e.lon! });
  const dentro = (id: number) => {
    const p = posicion.get(id)!;
    return p.lat >= CAJA_JUEGO.sur && p.lat <= CAJA_JUEGO.norte && p.lng >= CAJA_JUEGO.oeste && p.lng <= CAJA_JUEGO.este;
  };

  // Cada vía se corta en el borde de la caja del juego; esas puntas son cortes artificiales
  const cortes = new Set<number>();
  const vias: { nodes: number[]; tags: Record<string, string> }[] = [];
  for (const e of elementos) {
    if (e.type !== 'way' || !e.nodes || !e.tags) continue;
    let pedazo: number[] = [];
    const cerrar = (final: boolean) => {
      if (pedazo.length >= 2) {
        if (pedazo[0] !== e.nodes![0]) cortes.add(pedazo[0]!);
        if (!final) cortes.add(pedazo.at(-1)!);
        vias.push({ nodes: pedazo, tags: e.tags! });
      }
      pedazo = [];
    };
    for (const id of e.nodes) {
      if (dentro(id)) pedazo.push(id);
      else cerrar(false);
    }
    cerrar(true);
  }

  // Tramos entre intersecciones: nodos que comparten 2 o más vías, más los extremos de cada vía
  const usos = new Map<number, number>();
  for (const v of vias) for (const id of new Set(v.nodes)) usos.set(id, (usos.get(id) ?? 0) + 1);
  const esCorte = (v: { nodes: number[] }, k: number) => k === 0 || k === v.nodes.length - 1 || (usos.get(v.nodes[k]!) ?? 0) >= 2;
  const todos: (Tramo & { principal: boolean })[] = [];
  for (const v of vias) {
    const tipo = tipoDe(v.tags);
    let desde = 0;
    let distancia = 0;
    for (let k = 1; k < v.nodes.length; k++) {
      const p = posicion.get(v.nodes[k - 1]!)!;
      const q = posicion.get(v.nodes[k]!)!;
      distancia += metros(p.lat, p.lng, q.lat, q.lng);
      if (!esCorte(v, k)) continue;
      todos.push({ a: v.nodes[desde]!, b: v.nodes[k]!, distancia, tipo, nombre: v.tags.name, principal: esPrincipal(v.tags) });
      desde = k;
      distancia = 0;
    }
  }

  // Las avenidas y terciarias entran todas; las demás calles, solo si están a `radio` metros de un
  // barrio caminando por la red (así cada barrio queda conectado) o cerca de un refugio
  const cercaDeBarrio = alcanceEnMetros(todos, posicion, BARRIOS, radio);
  const cercaDeRefugio = alcanceEnMetros(todos, posicion, REFUGIOS, RADIO_REFUGIO_M);
  const dentroDe = (alcance: Map<number, number>, t: Tramo) => alcance.has(t.a) && alcance.has(t.b);
  let tramos: Tramo[] = todos
    .filter((t) => t.principal || dentroDe(cercaDeBarrio, t) || dentroDe(cercaDeRefugio, t))
    .map(({ principal: _, ...t }) => t);

  // Fusionar intersecciones a menos de FUSION_M metros (unión-búsqueda sobre una rejilla)
  const extremos = [...new Set(tramos.flatMap((t) => [t.a, t.b]))];
  const padre = new Map(extremos.map((id) => [id, id]));
  const raiz = (id: number): number => {
    let r = id;
    while (padre.get(r) !== r) r = padre.get(r)!;
    padre.set(id, r);
    return r;
  };
  const celda = FUSION_M / 111_000;
  const rejilla = new Map<string, number[]>();
  for (const id of extremos) {
    const p = posicion.get(id)!;
    const clave = `${Math.floor(p.lat / celda)},${Math.floor(p.lng / celda)}`;
    (rejilla.get(clave) ?? rejilla.set(clave, []).get(clave)!).push(id);
  }
  for (const id of extremos) {
    const p = posicion.get(id)!;
    const f = Math.floor(p.lat / celda);
    const c = Math.floor(p.lng / celda);
    for (let df = -1; df <= 1; df++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const otro of rejilla.get(`${f + df},${c + dc}`) ?? []) {
          if (otro <= id) continue;
          const q = posicion.get(otro)!;
          if (metros(p.lat, p.lng, q.lat, q.lng) < FUSION_M) padre.set(raiz(otro), raiz(id));
        }
      }
    }
  }
  const grupos = new Map<number, number[]>();
  for (const id of extremos) (grupos.get(raiz(id)) ?? grupos.set(raiz(id), []).get(raiz(id))!).push(id);
  const nodos = new Map<number, { lat: number; lng: number }>();
  for (const [r, miembros] of grupos) {
    const lat = miembros.reduce((s, id) => s + posicion.get(id)!.lat, 0) / miembros.length;
    const lng = miembros.reduce((s, id) => s + posicion.get(id)!.lng, 0) / miembros.length;
    nodos.set(r, { lat, lng });
  }
  tramos = tramos.map((t) => ({ ...t, a: raiz(t.a), b: raiz(t.b) })).filter((t) => t.a !== t.b);

  // Una punta es un callejón sin salida real solo si en OpenStreetMap ninguna otra vía la toca;
  // si la toca una vía que quedó fuera del recorte, es un corte artificial y se poda
  const usosTotales = new Map<number, number>();
  for (const e of elementos) {
    if (e.type === 'way' && e.nodes) for (const id of new Set(e.nodes)) usosTotales.set(id, (usosTotales.get(id) ?? 0) + 1);
  }
  const puntaArtificial = (r: number) => grupos.get(r)!.some((id) => cortes.has(id) || (usosTotales.get(id) ?? 0) >= 2);

  tramos = sinParalelas(tramos);
  ({ tramos } = componenteMayor(nodos, tramos));
  tramos = podarPuntas(tramos, puntaArtificial);
  // La intersección más cercana a cada refugio no se contrae: así el refugio queda en su lugar
  const extremosActuales = [...new Set(tramos.flatMap((t) => [t.a, t.b]))];
  const protegidos = new Set(
    REFUGIOS.map((r) => {
      let mejor = -1;
      let menor = Number.POSITIVE_INFINITY;
      for (const v of extremosActuales) {
        const p = nodos.get(v)!;
        const d = metros(p.lat, p.lng, r.lat, r.lng);
        if (d < menor) {
          menor = d;
          mejor = v;
        }
      }
      return mejor;
    }),
  );
  tramos = contraerPaso(tramos, protegidos);
  ({ tramos } = componenteMayor(nodos, tramos));
  tramos = marcarCallejones(tramos);
  const usados = new Set(tramos.flatMap((t) => [t.a, t.b]));
  for (const id of [...nodos.keys()]) if (!usados.has(id)) nodos.delete(id);
  return { nodos, tramos };
}

/**
 * Nodos a `limite` metros o menos de algún punto caminando por las calles (Dijkstra desde
 * la intersección más cercana a cada punto). Devuelve nodo → metros.
 */
function alcanceEnMetros(
  tramos: readonly Tramo[],
  posicion: ReadonlyMap<number, { lat: number; lng: number }>,
  puntos: readonly { lat: number; lng: number }[],
  limite: number,
): Map<number, number> {
  const vecinos = new Map<number, { v: number; d: number }[]>();
  for (const t of tramos) {
    (vecinos.get(t.a) ?? vecinos.set(t.a, []).get(t.a)!).push({ v: t.b, d: t.distancia });
    (vecinos.get(t.b) ?? vecinos.set(t.b, []).get(t.b)!).push({ v: t.a, d: t.distancia });
  }
  const distancia = new Map<number, number>();
  const pendientes: [number, number][] = [];
  // Se parte de todas las intersecciones a 200 m o menos del punto: la más cercana puede
  // estar en un pedazo de calle suelto y entonces la búsqueda no saldría de ahí
  for (const p of puntos) {
    for (const id of vecinos.keys()) {
      const q = posicion.get(id)!;
      const d = metros(p.lat, p.lng, q.lat, q.lng);
      if (d <= Math.min(200, limite) && d < (distancia.get(id) ?? Number.POSITIVE_INFINITY)) {
        distancia.set(id, d);
        pendientes.push([d, id]);
      }
    }
  }
  while (pendientes.length > 0) {
    let k = 0;
    for (let j = 1; j < pendientes.length; j++) if (pendientes[j]![0] < pendientes[k]![0]) k = j;
    const [d, u] = pendientes.splice(k, 1)[0]!;
    if (d > distancia.get(u)!) continue;
    for (const { v, d: tramo } of vecinos.get(u)!) {
      const nueva = d + tramo;
      if (nueva <= limite && nueva < (distancia.get(v) ?? Number.POSITIVE_INFINITY)) {
        distancia.set(v, nueva);
        pendientes.push([nueva, v]);
      }
    }
  }
  return distancia;
}

function grados(tramos: readonly Tramo[]): Map<number, number> {
  const resultado = new Map<number, number>();
  for (const t of tramos) for (const v of [t.a, t.b]) resultado.set(v, (resultado.get(v) ?? 0) + 1);
  return resultado;
}

/** Quita, una y otra vez, las puntas sin salida que son artificiales. */
function podarPuntas(tramos: Tramo[], artificial: (nodo: number) => boolean): Tramo[] {
  let actuales = tramos;
  for (;;) {
    const grado = grados(actuales);
    const podar = (v: number) => grado.get(v) === 1 && artificial(v);
    const siguientes = actuales.filter((t) => !podar(t.a) && !podar(t.b));
    if (siguientes.length === actuales.length) return actuales;
    actuales = siguientes;
  }
}

/** Las calles que terminan en un callejón sin salida real pasan a ser `callejon` (15 km/h). */
function marcarCallejones(tramos: Tramo[]): Tramo[] {
  const grado = grados(tramos);
  return tramos.map((t) =>
    t.tipo === 'calle' && (grado.get(t.a) === 1 || grado.get(t.b) === 1) ? { ...t, tipo: 'callejon' } : t,
  );
}

/** Entre dos intersecciones queda solo la calle más corta. */
function sinParalelas(tramos: Tramo[]): Tramo[] {
  const mejor = new Map<string, Tramo>();
  for (const t of tramos) {
    const clave = t.a < t.b ? `${t.a}-${t.b}` : `${t.b}-${t.a}`;
    const actual = mejor.get(clave);
    if (!actual || t.distancia < actual.distancia) mejor.set(clave, t);
  }
  return [...mejor.values()];
}

function componenteMayor(nodos: Map<number, unknown>, tramos: Tramo[]): { tramos: Tramo[] } {
  const vecinos = new Map<number, number[]>();
  for (const t of tramos) {
    (vecinos.get(t.a) ?? vecinos.set(t.a, []).get(t.a)!).push(t.b);
    (vecinos.get(t.b) ?? vecinos.set(t.b, []).get(t.b)!).push(t.a);
  }
  const componente = new Map<number, number>();
  const tamanos: number[] = [];
  for (const inicio of vecinos.keys()) {
    if (componente.has(inicio)) continue;
    const id = tamanos.length;
    const pila = [inicio];
    componente.set(inicio, id);
    let tamano = 0;
    while (pila.length > 0) {
      const u = pila.pop()!;
      tamano++;
      for (const v of vecinos.get(u)!) {
        if (componente.has(v)) continue;
        componente.set(v, id);
        pila.push(v);
      }
    }
    tamanos.push(tamano);
  }
  const mayor = tamanos.indexOf(Math.max(...tamanos));
  void nodos;
  return { tramos: tramos.filter((t) => componente.get(t.a) === mayor) };
}

/**
 * Los nodos de paso (exactamente 2 calles) se quitan uniendo sus dos tramos, salvo que
 * uno sea puente y el otro no: el puente tiene que seguir siendo una arista propia.
 */
function contraerPaso(tramos: Tramo[], protegidos: ReadonlySet<number>): Tramo[] {
  let actuales = tramos;
  for (let cambio = true; cambio; ) {
    cambio = false;
    const incidentes = new Map<number, Tramo[]>();
    for (const t of actuales) {
      (incidentes.get(t.a) ?? incidentes.set(t.a, []).get(t.a)!).push(t);
      (incidentes.get(t.b) ?? incidentes.set(t.b, []).get(t.b)!).push(t);
    }
    const quitados = new Set<Tramo>();
    const nuevos: Tramo[] = [];
    for (const [v, lista] of incidentes) {
      if (lista.length !== 2 || protegidos.has(v)) continue;
      const [t1, t2] = lista as [Tramo, Tramo];
      if (quitados.has(t1) || quitados.has(t2)) continue;
      if ((t1.tipo === 'puente') !== (t2.tipo === 'puente')) continue;
      const u = t1.a === v ? t1.b : t1.a;
      const w = t2.a === v ? t2.b : t2.a;
      if (u === w) continue;
      const largo = t1.distancia >= t2.distancia ? t1 : t2;
      quitados.add(t1);
      quitados.add(t2);
      nuevos.push({ a: u, b: w, distancia: t1.distancia + t2.distancia, tipo: largo.tipo, nombre: largo.nombre ?? t1.nombre ?? t2.nombre });
      cambio = true;
    }
    actuales = sinParalelas([...actuales.filter((t) => !quitados.has(t)), ...nuevos]);
  }
  return actuales;
}

// ── Principal ──

/** Ajusta el radio alrededor de barrios y refugios para quedar cerca de 300 nodos. */
function conRadioAjustado(elementos: ElementoOsm[]): Resultado {
  let bajo = 0;
  let alto = 2500;
  let elegido = construir(elementos, 0);
  for (let intento = 0; intento < 14; intento++) {
    const radio = (bajo + alto) / 2;
    const prueba = construir(elementos, radio);
    console.log(`radio ${radio.toFixed(0)} m → ${prueba.nodos.size} nodos`);
    if (prueba.nodos.size > OBJETIVO_NODOS.maximo) alto = radio;
    else {
      elegido = prueba;
      if (prueba.nodos.size >= OBJETIVO_NODOS.minimo) break;
      bajo = radio;
    }
  }
  return elegido;
}

function aMapa({ nodos: puntos, tramos }: Resultado): MapaBase {
  // Ids estables: de oeste a este y de norte a sur
  const ordenados = [...puntos.entries()].sort((x, y) => x[1].lng - y[1].lng || y[1].lat - x[1].lat);
  const idNodo = new Map(ordenados.map(([osm], k) => [osm, `N-${String(k).padStart(4, '0')}`]));
  const nodos: Nodo[] = ordenados.map(([osm, p]) => {
    const centro = BARRIOS.map((b) => ({ b, d: metros(p.lat, p.lng, b.lat, b.lng) })).sort((x, y) => x.d - y.d)[0]!;
    const nodo: Nodo = { id: idNodo.get(osm)!, lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) };
    if (centro.d <= RADIO_BARRIO_M) nodo.barrio = centro.b.nombre;
    return nodo;
  });
  const aristas: Arista[] = tramos
    .map((t) => ({ a: idNodo.get(t.a)!, b: idNodo.get(t.b)!, t }))
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .map(({ a, b, t }, k) => {
      const arista: Arista = { id: `E-${String(k).padStart(4, '0')}`, a, b, distancia_m: Number(t.distancia.toFixed(1)), tipo: t.tipo };
      if (t.nombre) arista.nombre = t.nombre;
      return arista;
    });

  // Cada refugio va a la intersección más cercana con al menos 2 calles
  const grados = gradosDe(aristas);
  const usados = new Set<string>();
  const refugios = REFUGIOS.map((r) => {
    const { n, d } = nodos
      .filter((nodo) => (grados.get(nodo.id) ?? 0) >= 2 && !usados.has(nodo.id))
      .map((nodo) => ({ n: nodo, d: metros(nodo.lat, nodo.lng, r.lat, r.lng) }))
      .sort((x, y) => x.d - y.d)[0]!;
    usados.add(n.id);
    console.log(`${r.id} ${r.nombre}: ${n.id}, a ${d.toFixed(0)} m del lugar`);
    return { id: r.id, nodo: n.id, nombre: r.nombre, capacidad: r.capacidad };
  });
  return { nodos, aristas, refugios };
}

function gradosDe(aristas: readonly Arista[]): Map<string, number> {
  const grados = new Map<string, number>();
  for (const a of aristas) for (const id of [a.a, a.b]) grados.set(id, (grados.get(id) ?? 0) + 1);
  return grados;
}

/** Validación de la sección 6 del plan; devuelve los problemas encontrados. */
function validar(mapa: MapaBase, alcanzan: Int32Array): string[] {
  const problemas: string[] = [];
  if ([...alcanzan].some((d) => d === -1)) problemas.push('hay nodos que no llegan a ningún refugio');
  if (!mapa.aristas.some((a) => a.tipo === 'puente')) problemas.push('no hay ningún puente (la ronda 2 lo necesita)');
  for (const b of BARRIOS) {
    const cuantos = mapa.nodos.filter((n) => n.barrio === b.nombre).length;
    if (cuantos < 10) problemas.push(`${b.nombre} tiene ${cuantos} nodos (mínimo 10)`);
  }
  return problemas;
}

async function principal(): Promise<void> {
  if (process.argv.includes('--descargar') || !existsSync(RUTA_CRUDA)) await descargar();
  const elementos = (JSON.parse(readFileSync(RUTA_CRUDA, 'utf8')) as { elements: ElementoOsm[] }).elements;
  const mapa = aMapa(conRadioAjustado(elementos));
  const grafo = crearGrafo(mapa);
  const alcanzan = distanciasEnCalles(grafo, grafo.refugios.map((r) => r.nodo), new Set());
  const problemas = validar(mapa, alcanzan);
  if (problemas.length > 0) throw new Error(`El grafo no pasa la validación:\n- ${problemas.join('\n- ')}`);

  writeFileSync(RUTA_SALIDA, `${JSON.stringify(mapa, null, 1)}\n`);
  const porTipo: Record<string, number> = {};
  for (const a of mapa.aristas) porTipo[a.tipo] = (porTipo[a.tipo] ?? 0) + 1;
  const porBarrio = BARRIOS.map((b) => `${b.nombre} ${mapa.nodos.filter((n) => n.barrio === b.nombre).length}`).join(' · ');
  const sinSalida = [...gradosDe(mapa.aristas).values()].filter((g) => g === 1).length;
  console.log(`\n${RUTA_SALIDA}: ${mapa.nodos.length} nodos y ${mapa.aristas.length} calles ${JSON.stringify(porTipo)}, ${sinSalida} sin salida`);
  console.log(`Nodos por barrio: ${porBarrio} · el más lejano está a ${Math.max(...alcanzan)} calles de un refugio`);
}

principal().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
