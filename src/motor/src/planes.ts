// Caché de planes por número de turno, con un solo pedido a la fuente por turno
// aunque lleguen 200 pedidos juntos (singleflight). El estado de un turno no cambia
// una vez escrito, así que esta caché es derivada: la verdad sigue en DynamoDB.
import type { Grafo } from '../../compartido/src/grafo.js';
import type { EstadoTurno } from '../../compartido/src/tipos.js';
import { construirPlan, PARAMETROS, type Parametros, type Plan } from './planificador.js';

export interface FuenteEstado {
  leer(): Promise<EstadoTurno | null>;
}

const TURNOS_GUARDADOS = 3;
/**
 * Un turno dura 2 s. Un plan más viejo que esto con el mismo número de turno
 * es de una ronda anterior (el turno vuelve a empezar), así que se lee de nuevo.
 */
const VIGENCIA_MS = 3000;

export class Planes {
  private readonly cache = new Map<number, { plan: Promise<Plan>; creado: number }>();

  constructor(
    private readonly grafo: Grafo,
    private readonly fuente: FuenteEstado,
    private readonly parametros: Readonly<Parametros> = PARAMETROS,
    private readonly ahora: () => number = Date.now,
  ) {}

  obtener(turno: number): Promise<Plan> {
    const guardado = this.cache.get(turno);
    if (guardado && this.ahora() - guardado.creado <= VIGENCIA_MS) return guardado.plan;

    const plan = this.fuente.leer().then((estado) => {
      if (!estado) throw new Error('La tabla todavía no tiene el estado del turno');
      return construirPlan(this.grafo, estado, this.parametros);
    });
    this.cache.delete(turno);
    this.cache.set(turno, { plan, creado: this.ahora() });
    plan.then(
      // Si la tabla todavía tenía un turno anterior, el próximo pedido vuelve a leer
      (p) => {
        if (p.turno < turno && this.cache.get(turno)?.plan === plan) this.cache.delete(turno);
      },
      () => {
        if (this.cache.get(turno)?.plan === plan) this.cache.delete(turno);
      },
    );
    // Se descartan los más viejos por orden de llegada (el turno se reinicia en cada ronda)
    while (this.cache.size > TURNOS_GUARDADOS) this.cache.delete(this.cache.keys().next().value!);
    return plan;
  }
}
