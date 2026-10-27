// Esqueleto desplegable del simulador. Publica GET /estado vacío, protege /admin/*
// y trae POST /admin/probar-motor para medir desde AWS la latencia de POST /paso.
// La persona B lo reemplaza por el simulador real (bucle de turnos, DynamoDB, rondas);
// lo que debe conservar: puerto PUERTO, GET /salud y la comparación segura de x-admin-key.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const PUERTO = Number(process.env.PUERTO ?? 8080);
const API_KEY = process.env.API_KEY ?? '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const URL_MOTOR = (process.env.URL_MOTOR ?? '').replace(/\/$/, '');
const PEDIDOS_DE_PRUEBA = 50;

for (const [nombre, valor] of Object.entries({ API_KEY, ADMIN_KEY, URL_MOTOR })) {
  if (!valor) {
    console.error(`Falta la variable ${nombre}`);
    process.exit(1);
  }
}

function llaveValida(recibida: string | string[] | undefined, esperada: string): boolean {
  if (typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
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

function percentil(valores: number[], p: number): number {
  const orden = [...valores].sort((a, b) => a - b);
  const indice = Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1);
  return Math.round((orden[Math.max(0, indice)] ?? 0) * 10) / 10;
}

// Manda pedidos seguidos a POST /paso por la URL pública, como lo hará el simulador real
async function probarMotor(): Promise<unknown> {
  const tiempos: number[] = [];
  const fallos: string[] = [];
  for (let i = 0; i < PEDIDOS_DE_PRUEBA; i++) {
    const inicio = performance.now();
    try {
      const respuesta = await fetch(`${URL_MOTOR}/paso`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ sobrevivienteId: 'S-0001', nodoActual: 'N-0001', turno: i }),
        signal: AbortSignal.timeout(500),
      });
      await respuesta.json();
      if (!respuesta.ok) fallos.push(`HTTP ${respuesta.status}`);
    } catch (error) {
      fallos.push(error instanceof Error ? error.name : 'error');
    }
    tiempos.push(performance.now() - inicio);
  }
  return {
    pedidos: PEDIDOS_DE_PRUEBA,
    fallos: fallos.length,
    primerFallo: fallos[0] ?? null,
    ms: { p50: percentil(tiempos, 50), p95: percentil(tiempos, 95), max: percentil(tiempos, 100) },
  };
}

async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ruta = (req.url ?? '/').split('?')[0] ?? '/';

  if (req.method === 'GET' && ruta === '/salud') {
    return responder(res, 200, { ok: true, servicio: 'simulador' });
  }

  if (req.method === 'GET' && ruta === '/estado') {
    return responder(res, 200, {
      ronda: null,
      turno: 0,
      zombies: [],
      aristasBloqueadas: [],
      sobrevivientes: [],
      refugios: [],
      actualizadoEn: new Date().toISOString(),
    });
  }

  if (ruta.startsWith('/admin/')) {
    if (!llaveValida(req.headers['x-admin-key'], ADMIN_KEY)) return responder(res, 401, { error: 'no autorizado' });
    if (req.method === 'POST' && ruta === '/admin/probar-motor') return responder(res, 200, await probarMotor());
    return responder(res, 501, { error: 'el simulador todavía es un esqueleto' });
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

servidor.listen(PUERTO, () => console.log(`simulador escuchando en el puerto ${PUERTO}`));
process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
