// Contrato entre el motor, el simulador y el mapa (sección 4 de docs/plan.md).
// Si algo de aquí cambia, se avisa a los otros dos antes de subirlo.

export type TipoCalle = 'avenida' | 'calle' | 'callejon' | 'puente';
export type TipoZombie = 'caminante' | 'corredor' | 'horda' | 'dormido';
export type EstadoSobreviviente = 'huyendo' | 'a_salvo' | 'mordido';

/** Velocidad por tipo de calle en km/h (decisión 2 del plan). */
export const VELOCIDAD_KMH: Readonly<Record<TipoCalle, number>> = {
  avenida: 50,
  calle: 30,
  callejon: 15,
  puente: 40,
};

export const ID_NODO = /^N-\d{4}$/;
export const ID_ARISTA = /^E-\d{4}$/;
export const ID_SOBREVIVIENTE = /^S-\d{4}$/;
export const ID_ZOMBIE = /^Z-\d{3}$/;
export const ID_REFUGIO = /^R-\d+$/;

// ── Mapa base: data/manta.json (y data/prueba.json, con el mismo formato) ──

export interface Nodo {
  id: string;
  lat: number;
  lng: number;
  barrio?: string;
}

/** Calle de doble sentido entre dos intersecciones: los sobrevivientes van a pie. */
export interface Arista {
  id: string;
  a: string;
  b: string;
  distancia_m: number;
  tipo: TipoCalle;
  nombre?: string;
}

export interface Refugio {
  id: string;
  nodo: string;
  nombre: string;
  capacidad: number;
}

export interface MapaBase {
  nodos: Nodo[];
  aristas: Arista[];
  refugios: Refugio[];
}

// ── Estado del turno: ítem de DynamoDB con partida = "actual" ──

export interface Zombie {
  id: string;
  tipo: TipoZombie;
  nodo: string;
  /** Nodos por los que pasó en este turno, desde donde empezó hasta donde terminó. */
  recorrido?: string[];
}

export interface Sobreviviente {
  id: string;
  nodo: string;
  estado: EstadoSobreviviente;
  /** Refugio que el motor le asignó en el turno anterior: permite la histéresis del reparto. */
  refugioAnterior?: string | null;
}

export interface OcupacionRefugio {
  id: string;
  ocupados: number;
  capacidad: number;
}

export interface EstadoTurno {
  partida: string;
  ronda: number | null;
  turno: number;
  /** Solo los visibles: los dormidos no se escriben hasta que despiertan. */
  zombies: Zombie[];
  aristasBloqueadas: string[];
  sobrevivientes: Sobreviviente[];
  refugios: OcupacionRefugio[];
  actualizadoEn: string;
}

// ── Endpoints del motor ──

export interface PedidoPaso {
  sobrevivienteId: string;
  nodoActual: string;
  turno: number;
}

export interface RespuestaPaso {
  siguienteNodo: string;
  /** Refugio al que va; solo informativo. */
  refugio?: string;
}

export interface PedidoRutas {
  turno: number;
}

/** Ruta planificada de cada sobreviviente que huye, desde su nodo actual hasta su refugio. */
export interface RespuestaRutas {
  turno: number;
  rutas: Record<string, string[]>;
}

// ── GET /estado del simulador: lo que dibuja el mapa en vivo ──

/** Latencia de POST /paso medida por el simulador contra la URL del motor. */
export interface MetricasLatencia {
  pedidos: number;
  /** Respuestas con error HTTP, cuerpo inválido o movimiento inválido. */
  errores: number;
  /** Pedidos que pasaron de 500 ms: el sobreviviente se quedó quieto. */
  fueraDeTiempo: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ResultadoRonda {
  ronda: number;
  semilla: number;
  turnos: number;
  total: number;
  salvados: number;
  mordidos: number;
  sinLlegar: number;
  /** Promedio de turnos mínimos / turnos usados entre los salvados (0 a 1). */
  eficiencia: number | null;
  latencia: MetricasLatencia;
}

/** Puntaje estimado con la rúbrica de la prueba de fuego, de 0 a 10. */
export interface Puntaje {
  supervivencia: number;
  eficiencia: number;
  latencia: number;
  disponibilidad: number;
  total: number;
  /** Rondas que entran en el cálculo (la última corrida de cada una). */
  rondas: number[];
}

export interface RefugioEnVivo extends OcupacionRefugio {
  nombre: string;
  nodo: string;
}

export interface VistaEstado {
  ronda: number | null;
  nombreRonda: string | null;
  semilla: number | null;
  turno: number;
  turnosTotales: number;
  enCurso: boolean;
  /** Solo los visibles: un dormido aparece cuando despierta. */
  zombies: Zombie[];
  aristasBloqueadas: string[];
  sobrevivientes: Sobreviviente[];
  refugios: RefugioEnVivo[];
  /** Rutas planificadas que devolvió el motor en este turno. */
  rutas: Record<string, string[]>;
  metricas: MetricasLatencia;
  /** Resultado de la ronda actual hasta este turno. */
  resultado: ResultadoRonda | null;
  /** Última corrida terminada de cada ronda. */
  historial: ResultadoRonda[];
  puntaje: Puntaje | null;
  eventos: { turno: number; texto: string }[];
  actualizadoEn: string;
}
