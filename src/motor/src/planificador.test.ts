import { describe, expect, it } from 'vitest';
import { crearCuadricula, idNodo } from '../../compartido/src/cuadricula.js';
import { aristaAbierta, crearGrafo, distanciasEnCalles } from '../../compartido/src/grafo.js';
import { esMordida, esMovimientoValido } from '../../compartido/src/reglas.js';
import type { EstadoTurno, Sobreviviente, TipoZombie, Zombie } from '../../compartido/src/tipos.js';
import { construirPlan, decidirPaso, rutasDelPlan } from './planificador.js';
import { Planes, type FuenteEstado } from './planes.js';

const LADO = 10;
const n = (fila: number, columna: number) => idNodo(fila, columna, LADO);
const grafo = crearGrafo(crearCuadricula(LADO));
const i = (id: string) => grafo.indice.get(id)!;
const calle = (a: string, b: string) => grafo.aristas[aristaAbierta(grafo, i(a), i(b), new Set())]!.id;

function estado(parcial: Partial<EstadoTurno> = {}): EstadoTurno {
  return {
    partida: 'actual',
    ronda: 1,
    turno: 1,
    zombies: [],
    aristasBloqueadas: [],
    sobrevivientes: [],
    refugios: grafo.refugios.map((r) => ({ id: r.id, ocupados: 0, capacidad: r.capacidad })),
    actualizadoEn: '2026-10-30T15:00:00.000Z',
    ...parcial,
  };
}

const huye = (id: string, nodo: string, refugioAnterior?: string): Sobreviviente => ({ id, nodo, estado: 'huyendo', refugioAnterior });
const zombie = (id: string, tipo: TipoZombie, nodo: string, recorrido?: string[]): Zombie => ({ id, tipo, nodo, recorrido });

/** Generador pseudoaleatorio con semilla (mulberry32), para pruebas reproducibles. */
function azar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sin zombies', () => {
  it('llega al refugio más cercano por el camino más corto', () => {
    let nodo = n(2, 3);
    let turnos = 0;
    while (nodo !== n(0, 0) && turnos < 20) {
      const plan = construirPlan(grafo, estado({ turno: turnos + 1, sobrevivientes: [huye('S-0001', nodo)] }));
      const respuesta = decidirPaso(plan, 'S-0001', nodo);
      expect(respuesta.refugio).toBe('R-1');
      expect(esMovimientoValido(grafo, nodo, respuesta.siguienteNodo, [])).toBe(true);
      nodo = respuesta.siguienteNodo;
      turnos++;
    }
    expect(nodo).toBe(n(0, 0));
    expect(turnos).toBe(5); // 2 filas + 3 columnas
  });

  it('se queda quieto cuando ya está en su refugio', () => {
    const plan = construirPlan(grafo, estado({ sobrevivientes: [huye('S-0001', n(0, 0))] }));
    expect(decidirPaso(plan, 'S-0001', n(0, 0)).siguienteNodo).toBe(n(0, 0));
  });

  it('responde quedarse con un nodo que no existe', () => {
    const plan = construirPlan(grafo, estado());
    expect(decidirPaso(plan, 'S-0001', 'N-9999')).toEqual({ siguienteNodo: 'N-9999' });
  });
});

describe('reglas duras', () => {
  it('no entra en los vecinos de una horda', () => {
    // El camino natural de 2,4 a R-1 pasa por 2,3, que es vecino de la horda en 2,2
    const plan = construirPlan(grafo, estado({
      zombies: [zombie('Z-001', 'horda', n(2, 2))],
      sobrevivientes: [huye('S-0001', n(2, 4))],
    }));
    const { siguienteNodo } = decidirPaso(plan, 'S-0001', n(2, 4));
    expect([n(2, 3), n(2, 2)]).not.toContain(siguienteNodo);
    expect(plan.mortal[i(siguienteNodo)]).toBe(0);
  });

  it('nunca se cruza con un zombie por la misma calle', () => {
    // El corredor pasó por el nodo del sobreviviente: 2,1 → 2,2 → 3,2
    const plan = construirPlan(grafo, estado({
      zombies: [zombie('Z-001', 'corredor', n(3, 2), [n(2, 1), n(2, 2), n(3, 2)])],
      sobrevivientes: [huye('S-0001', n(2, 2))],
    }));
    const { siguienteNodo } = decidirPaso(plan, 'S-0001', n(2, 2));
    expect(siguienteNodo).not.toBe(n(2, 1)); // cruce
    expect(siguienteNodo).not.toBe(n(3, 2)); // nodo del zombie
    expect(siguienteNodo).not.toBe(n(2, 2)); // quedarse no es mordida, pero hay un paso seguro hacia el refugio
  });

  it('nunca usa una calle bloqueada', () => {
    const bloqueada = calle(n(0, 0), n(0, 1));
    const plan = construirPlan(grafo, estado({ aristasBloqueadas: [bloqueada], sobrevivientes: [huye('S-0001', n(0, 1))] }));
    const { siguienteNodo } = decidirPaso(plan, 'S-0001', n(0, 1));
    expect(siguienteNodo).not.toBe(n(0, 0));
    expect(esMovimientoValido(grafo, n(0, 1), siguienteNodo, [bloqueada])).toBe(true);
  });

  it('si queda encerrado por calles bloqueadas, se queda quieto', () => {
    const encierro = grafo.vecinos[i(n(4, 4))]!.map((v) => grafo.aristas[v.arista]!.id);
    const plan = construirPlan(grafo, estado({ aristasBloqueadas: encierro, sobrevivientes: [huye('S-0001', n(4, 4))] }));
    expect(decidirPaso(plan, 'S-0001', n(4, 4))).toEqual({ siguienteNodo: n(4, 4) });
  });

  it('en 500 estados al azar siempre responde un movimiento válido y evita la mordida si puede', () => {
    const tipos: TipoZombie[] = ['caminante', 'corredor', 'horda'];
    const al = azar(42);
    const nodoAlAzar = () => grafo.ids[Math.floor(al() * grafo.ids.length)]!;
    for (let caso = 0; caso < 500; caso++) {
      const zombies = Array.from({ length: 1 + Math.floor(al() * 8) }, (_, k) => {
        const nodo = nodoAlAzar();
        const vecino = grafo.vecinos[i(nodo)]![0]!.nodo;
        return zombie(`Z-${String(k).padStart(3, '0')}`, tipos[Math.floor(al() * 3)]!, nodo, [grafo.ids[vecino]!, nodo]);
      });
      const bloqueadas = grafo.aristas.filter(() => al() < 0.08).map((a) => a.id);
      const sobrevivientes = Array.from({ length: 5 }, (_, k) => huye(`S-${String(k).padStart(4, '0')}`, nodoAlAzar()));
      const plan = construirPlan(grafo, estado({ turno: caso, zombies, aristasBloqueadas: bloqueadas, sobrevivientes }));

      for (const s of sobrevivientes) {
        const { siguienteNodo } = decidirPaso(plan, s.id, s.nodo);
        expect(esMovimientoValido(grafo, s.nodo, siguienteNodo, bloqueadas)).toBe(true);
        const u = i(s.nodo);
        const opciones = [u, ...grafo.vecinos[u]!.filter((v) => !plan.bloqueadas.has(v.arista)).map((v) => v.nodo)];
        const haySalida = opciones.some((v) => !esMordida(grafo, u, v, plan.mortal, plan.cruces));
        if (haySalida) expect(esMordida(grafo, u, i(siguienteNodo), plan.mortal, plan.cruces)).toBe(false);
      }
    }
  });
});

describe('peligro', () => {
  it('rodea a un caminante en vez de pasar a su lado si el desvío es corto', () => {
    // De 0,4 a R-1 por la fila 0; un caminante en 1,2 pone en peligro 0,2
    const plan = construirPlan(grafo, estado({
      zombies: [zombie('Z-001', 'caminante', n(1, 2))],
      sobrevivientes: [huye('S-0001', n(0, 4))],
    }));
    expect(plan.peligro[i(n(0, 2))]).toBeGreaterThan(0);
    expect(plan.peligro[i(n(0, 4))]).toBe(0);
  });

  it('PRO: marca el camino que va a seguir un corredor que persigue', () => {
    const plan = construirPlan(grafo, estado({
      zombies: [zombie('Z-001', 'corredor', n(5, 5))],
      sobrevivientes: [huye('S-0001', n(5, 8))],
    }));
    const p = plan.parametros;
    // A 1 y 2 calles del corredor, en la línea de persecución: p2 + p3
    expect(plan.peligro[i(n(5, 6))]).toBeGreaterThanOrEqual(p.p2 + p.p3);
    expect(plan.peligro[i(n(5, 7))]).toBeGreaterThanOrEqual(p.p2 + p.p3);
    // A 2 calles pero fuera de la persecución: solo p2
    expect(plan.peligro[i(n(4, 6))]).toBe(p.p2);
  });
});

describe('reparto por capacidad', () => {
  it('nunca asigna un refugio lleno si otro tiene cupo', () => {
    const plan = construirPlan(grafo, estado({
      refugios: grafo.refugios.map((r) => ({ id: r.id, ocupados: r.id === 'R-1' ? r.capacidad : 0, capacidad: r.capacidad })),
      sobrevivientes: [huye('S-0001', n(1, 1))],
    }));
    expect(decidirPaso(plan, 'S-0001', n(1, 1)).refugio).not.toBe('R-1');
  });

  it('reparte a 40 sobrevivientes junto al refugio de 30 sin pasarse del cupo', () => {
    const sobrevivientes = Array.from({ length: 40 }, (_, k) => huye(`S-${String(k).padStart(4, '0')}`, n(8 + (k % 2), 8 + (k % 2))));
    const plan = construirPlan(grafo, estado({ sobrevivientes }));
    const enR4 = sobrevivientes.filter((s) => decidirPaso(plan, s.id, s.nodo).refugio === 'R-4');
    expect(enR4).toHaveLength(30);
  });

  it('mantiene el refugio anterior si el nuevo ahorra menos del 20 %', () => {
    // Desde 1,4 R-1 queda a 5 calles y R-2 a 6: cambiar de R-2 a R-1 ahorra un 16 %
    const plan = construirPlan(grafo, estado({ sobrevivientes: [huye('S-0001', n(1, 4), 'R-2')] }));
    expect(decidirPaso(plan, 'S-0001', n(1, 4)).refugio).toBe('R-2');
    const sinAnterior = construirPlan(grafo, estado({ sobrevivientes: [huye('S-0001', n(1, 4))] }));
    expect(decidirPaso(sinAnterior, 'S-0001', n(1, 4)).refugio).toBe('R-1');
  });

  it('dos tareas con el mismo estado dan las mismas respuestas', () => {
    const al = azar(7);
    const sobrevivientes = Array.from({ length: 200 }, (_, k) =>
      huye(`S-${String(k).padStart(4, '0')}`, grafo.ids[Math.floor(al() * grafo.ids.length)]!));
    const e = estado({ zombies: [zombie('Z-001', 'corredor', n(5, 5)), zombie('Z-002', 'horda', n(2, 7))], sobrevivientes });
    const a = construirPlan(grafo, e);
    const b = construirPlan(grafo, structuredClone(e));
    for (const s of sobrevivientes) expect(decidirPaso(a, s.id, s.nodo)).toEqual(decidirPaso(b, s.id, s.nodo));
    expect(rutasDelPlan(a)).toEqual(rutasDelPlan(b));
  });
});

describe('rutas', () => {
  it('cada ruta empieza en el sobreviviente, termina en su refugio y va por calles abiertas', () => {
    const bloqueadas = [calle(n(3, 3), n(3, 4))];
    const sobrevivientes = [huye('S-0001', n(3, 4)), huye('S-0002', n(6, 6))];
    const plan = construirPlan(grafo, estado({ aristasBloqueadas: bloqueadas, sobrevivientes }));
    const rutas = rutasDelPlan(plan);
    for (const s of sobrevivientes) {
      const ruta = rutas[s.id]!;
      expect(ruta[0]).toBe(s.nodo);
      const refugio = grafo.refugios.find((r) => r.id === decidirPaso(plan, s.id, s.nodo).refugio)!;
      expect(ruta.at(-1)).toBe(grafo.ids[refugio.nodo]);
      for (let k = 0; k + 1 < ruta.length; k++) {
        expect(esMovimientoValido(grafo, ruta[k]!, ruta[k + 1]!, bloqueadas)).toBe(true);
      }
      // Sin zombies, la ruta mide lo mismo que el camino más corto
      expect(ruta.length - 1).toBe(distanciasEnCalles(grafo, [refugio.nodo], plan.bloqueadas)[i(s.nodo)]);
    }
  });
});

describe('rendimiento', () => {
  it('arma el plan de una ciudad de 900 nodos con 200 sobrevivientes en pocos milisegundos', () => {
    const grande = crearGrafo(crearCuadricula(30));
    const al = azar(3);
    const nodoAlAzar = () => grande.ids[Math.floor(al() * grande.ids.length)]!;
    const tipos: TipoZombie[] = ['caminante', 'corredor', 'horda'];
    const e: EstadoTurno = {
      ...estado(),
      refugios: grande.refugios.map((r) => ({ id: r.id, ocupados: 0, capacidad: r.capacidad })),
      zombies: Array.from({ length: 60 }, (_, k) => zombie(`Z-${String(k).padStart(3, '0')}`, tipos[k % 3]!, nodoAlAzar())),
      sobrevivientes: Array.from({ length: 200 }, (_, k) => huye(`S-${String(k).padStart(4, '0')}`, nodoAlAzar())),
    };
    construirPlan(grande, e); // calentamiento del JIT
    const inicio = performance.now();
    const plan = construirPlan(grande, e);
    const armar = performance.now() - inicio;
    const inicioPasos = performance.now();
    for (const s of e.sobrevivientes) decidirPaso(plan, s.id, s.nodo);
    const pasos = performance.now() - inicioPasos;
    expect(armar).toBeLessThan(50);
    expect(pasos).toBeLessThan(10);
  });
});

describe('caché de planes', () => {
  const fuente = (turno: () => number) => {
    let lecturas = 0;
    const f: FuenteEstado & { lecturas: () => number } = {
      leer: async () => {
        lecturas++;
        return estado({ turno: turno(), sobrevivientes: [huye('S-0001', n(3, 3))] });
      },
      lecturas: () => lecturas,
    };
    return f;
  };

  it('lee la tabla una sola vez aunque lleguen 200 pedidos del mismo turno', async () => {
    const f = fuente(() => 7);
    const planes = new Planes(grafo, f);
    const resultados = await Promise.all(Array.from({ length: 200 }, () => planes.obtener(7)));
    expect(f.lecturas()).toBe(1);
    expect(new Set(resultados).size).toBe(1);
  });

  it('vuelve a leer si el plan es de otra ronda con el mismo número de turno', async () => {
    let reloj = 0;
    const f = fuente(() => 3);
    const planes = new Planes(grafo, f, undefined, () => reloj);
    await planes.obtener(3);
    reloj += 10_000;
    await planes.obtener(3);
    expect(f.lecturas()).toBe(2);
  });

  it('vuelve a leer después de un error', async () => {
    let falla = true;
    const f: FuenteEstado = {
      leer: async () => {
        if (falla) throw new Error('DynamoDB no responde');
        return estado({ turno: 5 });
      },
    };
    const planes = new Planes(grafo, f);
    await expect(planes.obtener(5)).rejects.toThrow('DynamoDB');
    await new Promise((r) => setTimeout(r, 0));
    falla = false;
    await expect(planes.obtener(5)).resolves.toMatchObject({ turno: 5 });
  });
});
