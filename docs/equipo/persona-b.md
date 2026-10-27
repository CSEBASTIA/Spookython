# Persona B · Mundo: grafo y simulador

**Nombre:** _(escribir)_ · **Entrega:** miércoles 28 de octubre, 10:00 · **Plan general:** [`docs/plan.md`](../plan.md)

## Tu objetivo

Construir el mundo del juego: el grafo real de Manta y el **Simulador del Apocalipsis**, que mueve a los zombies con las reglas exactas del reto, pregunta `POST /paso` por cada sobreviviente, mide la latencia y calcula el puntaje. Con tu simulador se corre la prueba de fuego en vivo, y el jurado tiene que ver que no está «a favor».

Eres dueña o dueño de `scripts/construir-grafo.ts`, `data/`, `src/simulador`, `scripts/carga.ts` y el video de respaldo.

## Lo que recibes y lo que entregas

| Qué | De / para |
|---|---|
| **Entregas** `data/prueba.json` (grafo falso de 10×10) | Para A y C (es lo primero que necesitan) |
| Recibes `src/compartido/tipos.ts` | De A |
| **Entregas** `data/manta.json` real y validado | Para A y C |
| Recibes la URL pública con los esqueletos | De C |
| **Entregas** `src/simulador/juego.ts` puro, aunque al principio solo tenga caminantes | Para A (su banco lo usa) |
| **Entregas** `data/estado-ejemplo.json` con la forma de `GET /estado` | Para C (dibuja el mapa con él) |
| Recibes la forma de la respuesta de `/rutas` | De A |
| Recibes `docker-compose.yml` con DynamoDB Local | De C |
| **Entregas** las diapositivas de números y capturas del mapa | Para A |

## Tus tareas

En este orden; las primeras son las que los otros esperan.

| # | Tarea | Lista cuando |
|---|---|---|
| 1 | `data/prueba.json`: cuadrícula de 10×10 con ids del contrato, 4 refugios, al menos una arista `puente` y distancias de unos 100 m | A y C lo cargan sin errores |
| 2 | `scripts/construir-grafo.ts` según la [sección 6 del plan](../plan.md#grafo-de-manta-b): Overpass → **guardar `data/raw/` en cuanto salga** → intersecciones, fusión a menos de 25 m, aristas con distancia y tipo, componente conexo más grande, recorte a unos 300 nodos, barrios (`data/barrios.geojson`) y los 4 refugios acordados | `data/manta.json` pasa la validación: conexo, ≥ 1 puente, ≥ 10 nodos por barrio, todos llegan a un refugio |
| 3 | `juego.ts` puro: caminante (1 calle cada 2 turnos), corredor (2 calles, persigue a ≤ 3 nodos), horda (1 calle cada 10 turnos), dormido (invisible hasta ≤ 2 nodos) y el `recorrido` de cada zombie | Los 4 tipos se mueven con las reglas del reto |
| 4 | Mordidas (mismo nodo, cruce por la misma calle, vecino de horda), llegada a refugio con capacidad, eventos (puente que colapsa, calles bloqueadas), semilla fija y la configuración de las 3 rondas | El banco de A corre la ronda 1 completa con tu `juego.ts` |
| 5 | `data/estado-ejemplo.json` con un turno real de la ronda 3 | C dibuja el mapa con él |
| 6 | Servidor del simulador sobre `src/simulador/src/index.ts`: bucle de 2 s que compensa el desfase, PutItem del estado, todos los `/paso` en paralelo (undici con keep-alive y corte a 500 ms), `/rutas`, aplicar pasos, `GET /estado` (con rutas, métricas y `actualizadoEn`; **nunca los dormidos**), `/admin/ronda`, `/admin/bloquear`, `/admin/detener` | R1 corre en local con `docker-compose` |
| 7 | Métricas p50/p95/p99, errores y fuera de tiempo, puntaje con la rúbrica ([sección 10](../plan.md#10-medición-y-puntaje)) y `LatenciaPaso` en CloudWatch | El panel de CloudWatch muestra la latencia |
| 8 | `scripts/carga.ts`: 200 pedidos a la vez cada 2 s durante 5 minutos contra `/paso` | Da p95 y porcentaje de errores |
| 9 | Ensayo de R1, R2 y R3 en AWS con las semillas definitivas; números en `docs/resultados.md` | Los números del README salen de este ensayo |
| 10 | README: URL de `POST /paso`, cómo ejecutar el simulador (local y en AWS) y cómo se mide la latencia | Alguien de fuera corre una ronda leyendo solo el README |
| 11 | Diapositivas de números y capturas del mapa para el PDF | A las tiene |
| 12 | Video de una ronda completa (por ejemplo con Win + Alt + R), subido como enlace no listado. Opcional | Hay enlace en el README |

## Lo que tienes que poder explicar

- Cómo se armó el grafo desde OpenStreetMap y cómo se eligió el tipo de cada calle.
- Las reglas de los 4 zombies, de la mordida y del refugio lleno, tal como las pide el reto.
- Por qué el motor nunca ve a los dormidos (no se escriben en el estado hasta que despiertan).
- Cómo se mide la latencia: desde el simulador, contra la URL pública, con `performance.now()`, y qué cuenta como fuera de tiempo.
- Cómo se calcula el puntaje (supervivencia ponderada, eficiencia, latencia y disponibilidad).
- Por qué el simulador corre dentro de AWS y no en una laptop.

## Reglas que no se rompen

- **Un solo simulador** a la vez: es el dueño del juego.
- Las reglas del juego son las del reto, sin trucos a favor del motor. Las semillas se publican en el README.
- Un paso inválido, tardío (más de 500 ms) o con error equivale a quedarse quieto, y cuenta en las métricas.
- Lo que exige la nube está en la [sección 5 de `docs/aws.md`](../aws.md#5-lo-que-la-nube-espera-del-motor-y-del-simulador): bundle único, puerto `PUERTO`, `GET /salud`, **disco de solo lectura** (los reportes van a la salida estándar y a `/estado`), `LatenciaPaso` sin dimensiones en el namespace `MantaZombie`.
- Conservar del esqueleto la comparación de `x-admin-key` con `timingSafeEqual` y la ruta `/admin/probar-motor`.
- Atribución «© OpenStreetMap contributors» en el README.

## Encargo para tu asistente de IA

Pégalo al empezar y ve pidiéndole una tarea a la vez:

```text
Estoy en el repo manta-zombie (TypeScript, Node 22, npm workspaces). Soy la persona B del equipo: me toca el grafo de Manta y el simulador del reto "Escape de Manta Zombie".

Lee primero docs/plan.md (secciones 4, 6 y 10), docs/aws.md (sección 5) y docs/equipo/persona-b.md. Los tipos del contrato están en src/compartido/tipos.ts y no se cambian sin avisar al equipo.

Qué hay que construir:
1. data/prueba.json: grafo falso de 10x10 con el formato del contrato, 4 refugios y al menos una arista de tipo puente.
2. scripts/construir-grafo.ts (Node, sin Python): consulta Overpass para la caja de Manta, guarda la respuesta cruda en data/raw/, arma intersecciones (fusiona las que están a menos de 25 m), aristas con distancia_m (haversine) y tipo (avenida, calle, callejon, puente), se queda con el componente conexo más grande, recorta a unos 300 nodos, asigna barrios con data/barrios.geojson, agrega los 4 refugios y valida el resultado. Sale data/manta.json.
3. src/simulador/juego.ts, puro y sin red: moverZombies(estado, rng) y aplicarPasos(estado, pasos), con caminante, corredor, horda y dormido según la tabla de la sección 6, el recorrido de cada zombie, mordidas (mismo nodo, cruce por la misma calle, vecino de horda), refugios con capacidad, eventos de calles bloqueadas, semilla fija y las 3 rondas.
4. Servidor del simulador sobre src/simulador/src/index.ts (conserva GET /salud, la validación de x-admin-key con timingSafeEqual y /admin/probar-motor): bucle de 2 s que compensa el desfase, PutItem del estado en TABLA_MUNDO (partida = "actual"), todos los POST /paso en paralelo a URL_MOTOR con undici (keep-alive, corte a 500 ms), POST /rutas, GET /estado sin dormidos, /admin/ronda, /admin/bloquear, /admin/detener, métricas p50/p95/p99, errores, puntaje con la rúbrica del reto y la métrica LatenciaPaso con PutMetricData.
5. scripts/carga.ts: 200 pedidos a la vez cada 2 s durante 5 minutos contra /paso.

Reglas: las reglas del juego son las del reto, sin favorecer al motor; el disco es de solo lectura; nada de llaves en el código; todo compila con esbuild a un solo dist/index.cjs sin módulos nativos.

Trabaja en pasos pequeños: después de cada paso, pruébalo, dime qué archivo cambiaste y explícame el código en dos o tres frases, porque tengo que poder defenderlo ante el jurado. Propón un mensaje de commit corto en español al final de cada paso.
```
