// Motor de rutas: POST /paso y POST /rutas (secciones 4 y 5 de docs/plan.md).
// Cada tarea arma el plan de un turno una sola vez y responde cada pedido con una búsqueda en memoria.
// Lo que exige la nube está en la sección 5 de docs/aws.md: puerto PUERTO, GET /salud y keep-alive de 65 s.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { crearGrafo, leerMapa } from '../../compartido/src/grafo.js';
import { ID_NODO, ID_SOBREVIVIENTE } from '../../compartido/src/tipos.js';
import { fuenteArchivo } from './fuente-archivo.js';
import { fuenteDynamo } from './fuente-dynamo.js';
import { decidirPaso, rutasDelPlan, type Plan } from './planificador.js';
import { Planes } from './planes.js';

const PUERTO = Number(process.env.PUERTO ?? 8080);
const API_KEY = process.env.API_KEY ?? '';
const TABLA_MUNDO = process.env.TABLA_MUNDO ?? '';
const ESTADO_ARCHIVO = process.env.ESTADO_ARCHIVO ?? '';
const LIMITE_CUERPO = 1024;
/** Si el plan del turno no está a tiempo, se responde quedarse: es mejor que pasar de 500 ms. */
const ESPERA_MAXIMA_MS = 350;

if (!API_KEY) {
  console.error('Falta la variable API_KEY');
  process.exit(1);
}
if (!TABLA_MUNDO && !ESTADO_ARCHIVO) {
  console.error('Falta la variable TABLA_MUNDO (o ESTADO_ARCHIVO para probar en local)');
  process.exit(1);
}

// El mapa base va dentro de la imagen: `npm run build` lo copia a dist/mapa.json
const rutaMapa = process.env.MAPA ?? join(dirname(process.argv[1] ?? '.'), 'mapa.json');
const grafo = crearGrafo(leerMapa(rutaMapa));
const planes = new Planes(
  grafo,
  ESTADO_ARCHIVO
    ? fuenteArchivo(ESTADO_ARCHIVO)
    : fuenteDynamo(TABLA_MUNDO, { region: process.env.AWS_REGION, endpoint: process.env.DYNAMO_ENDPOINT }),
);
const rutasCalculadas = new WeakMap<Plan, Record<string, string[]>>();

function llaveValida(recibida: string | string[] | undefined): boolean {
  if (typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function responder(res: ServerResponse, estado: number, cuerpo: unknown): void {
  const json = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function leerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of req) {
    total += (parte as Buffer).length;
    if (total > LIMITE_CUERPO) throw new Error('cuerpo demasiado grande');
    partes.push(parte as Buffer);
  }
  const valor: unknown = JSON.parse(Buffer.concat(partes).toString('utf8'));
  if (typeof valor !== 'object' || valor === null) throw new Error('se esperaba un objeto');
  return valor as Record<string, unknown>;
}

// Un solo aviso por turno en los logs, para no pagar un log por pedido
let ultimoAviso = Number.NaN;
function avisar(turno: number, mensaje: string, error?: unknown): void {
  if (turno === ultimoAviso) return;
  ultimoAviso = turno;
  console.error(`Turno ${turno}: ${mensaje}`, error ?? '');
}

/** Plan del turno, o null si no está listo a tiempo o la tabla falla: quien llama responde quedarse. */
async function planDelTurno(turno: number): Promise<Plan | null> {
  let reloj: NodeJS.Timeout | undefined;
  const limite = new Promise<null>((resolver) => {
    reloj = setTimeout(resolver, ESPERA_MAXIMA_MS, null);
  });
  try {
    const plan = await Promise.race([planes.obtener(turno), limite]);
    if (!plan) avisar(turno, `el plan tardó más de ${ESPERA_MAXIMA_MS} ms`);
    return plan;
  } catch (error) {
    avisar(turno, 'no se pudo leer el estado', error);
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ruta = (req.url ?? '/').split('?')[0];

  if (req.method === 'GET' && ruta === '/salud') {
    return responder(res, 200, { ok: true, servicio: 'motor', nodos: grafo.ids.length });
  }

  if (req.method === 'POST' && (ruta === '/paso' || ruta === '/rutas')) {
    if (!llaveValida(req.headers['x-api-key'])) return responder(res, 401, { error: 'no autorizado' });

    let cuerpo: Record<string, unknown>;
    try {
      cuerpo = await leerJson(req);
    } catch {
      return responder(res, 400, { error: 'cuerpo inválido' });
    }

    const { sobrevivienteId, nodoActual, turno } = cuerpo;
    if (typeof turno !== 'number' || !Number.isInteger(turno) || turno < 0) {
      return responder(res, 400, { error: 'cuerpo inválido' });
    }

    if (ruta === '/rutas') {
      const plan = await planDelTurno(turno);
      if (!plan) return responder(res, 200, { turno, rutas: {} });
      let rutas = rutasCalculadas.get(plan);
      if (!rutas) rutasCalculadas.set(plan, (rutas = rutasDelPlan(plan)));
      return responder(res, 200, { turno: plan.turno, rutas });
    }

    if (
      typeof sobrevivienteId !== 'string' || !ID_SOBREVIVIENTE.test(sobrevivienteId) ||
      typeof nodoActual !== 'string' || !ID_NODO.test(nodoActual)
    ) {
      return responder(res, 400, { error: 'cuerpo inválido' });
    }

    // Sin plan a tiempo, quedarse en el mismo nodo siempre es un movimiento válido
    const plan = await planDelTurno(turno);
    return responder(res, 200, plan ? decidirPaso(plan, sobrevivienteId, nodoActual) : { siguienteNodo: nodoActual });
  }

  responder(res, 404, { error: 'no encontrado' });
}

const servidor = createServer((req, res) => {
  atender(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) responder(res, 500, { error: 'error interno' });
  });
});

// Mayor que el tiempo de inactividad del ALB (60 s): si Node cierra primero, el ALB devuelve 502
servidor.keepAliveTimeout = 65_000;
servidor.headersTimeout = 66_000;

servidor.listen(PUERTO, () =>
  console.log(`motor escuchando en el puerto ${PUERTO} con ${grafo.ids.length} nodos y ${grafo.refugios.length} refugios`),
);
process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
