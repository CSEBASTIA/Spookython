# Persona A · Motor de rutas

**Nombre:** _(escribir)_ · **Entrega:** miércoles 28 de octubre, 10:00 · **Plan general:** [`docs/plan.md`](../plan.md)

## Tu objetivo

Que `POST /paso` responda en milisegundos un paso **válido y seguro** para cada sobreviviente, recalculado en cada turno. De ti depende la mitad de la nota de la prueba de fuego (supervivencia) y la quinta parte (eficiencia). Además armas la presentación.

Eres dueña o dueño de `src/compartido`, `src/motor`, las pruebas, el banco y el PDF del pitch.

## Lo que recibes y lo que entregas

| Qué | De / para |
|---|---|
| **Entregas** `src/compartido/tipos.ts` con el contrato de la [sección 4 del plan](../plan.md#4-contrato-interno) | Para B y C (es lo primero que necesitan) |
| Recibes `data/prueba.json` y después `data/manta.json` | De B |
| Recibes la URL pública con los esqueletos | De C |
| Recibes `src/simulador/juego.ts` para el banco | De B |
| **Entregas** la forma de la respuesta de `/rutas` | Para C |
| Recibes `docker-compose.yml` con DynamoDB Local | De C |
| Recibes las diapositivas de números (B) y de arquitectura y costos (C) | De B y C |

## Tus tareas

En este orden; las primeras son las que los otros esperan.

| # | Tarea | Lista cuando |
|---|---|---|
| 1 | `src/compartido/tipos.ts`: mapa, nodo, arista, refugio, zombie, sobreviviente, estado del turno, pedido y respuesta de `/paso` y `/rutas`, velocidades por tipo de calle y regex de ids | B y C lo importan sin preguntar nada |
| 2 | Carga del grafo (`prueba.json` y `manta.json`), lista de vecinos, arista entre dos nodos y `esMovimientoValido` | Funciona con los dos grafos |
| 3 | Reglas duras: nodo con zombie visible, nodo de horda **y sus vecinos**, arista bloqueada, cruce con un zombie según su `recorrido`. Pruebas con vitest | Pasan las pruebas de la [sección 5](../plan.md#5-motor-de-rutas-a) |
| 4 | Costo blando (P1 caminante, P2 corredor, P4 callejón sin salida) y Dijkstra desde cada refugio con `costo = 1 + λ·tiempo/tiempo_medio + peligro` | Cada Dijkstra tarda menos de 1 ms con unos 300 nodos |
| 5 | Elección del paso y `POST /paso` real sobre el servidor del esqueleto | Siempre devuelve un vecino válido o el mismo nodo |
| 6 | Caché `Map<turno, Promise<Plan>>`: un solo GetItem por turno aunque lleguen 200 pedidos (singleflight, lectura fuerte, guarda 2 turnos) | Un turno nuevo se lee una sola vez por tarea |
| 7 | `POST /rutas` con la ruta completa de cada sobreviviente | C la dibuja en el mapa |
| 8 | Banco sin red con el `juego.ts` de B: `npm run banco -- --ronda 1 --partidas 100` | Da supervivencia y eficiencia de la ronda 1 |
| 9 | PRO: predicción de corredores (P3 en los nodos de su persecución) | El banco muestra la mejora en R2 y R3 |
| 10 | PRO: reparto por capacidad (arrepentimiento, histéresis del 20 % con `refugioAnterior`, empates por id) | Nunca se asigna un refugio lleno |
| 11 | Ajuste de λ y P1–P4 con el banco; cada ajuste en `docs/resultados.md` | Los números de R1–R3 en AWS están anotados |
| 12 | README: algoritmo, decisiones de diseño del motor y limitaciones conocidas | Se entiende sin leer el código |
| 13 | **PDF del pitch** (máximo 20 MB) siguiendo el guion de la [sección 14](../plan.md#14-entregables-y-pitch), con las diapositivas de B y C | Listo para subir a la plataforma |

## Lo que tienes que poder explicar

- Por qué el plan se rehace **en cada turno** y aun así responde en menos de 1 ms (plan por turno + caché).
- Por qué se prohíben también **los vecinos de la horda**.
- Cómo se evita **cruzarse** con un zombie por la misma calle.
- Por qué dos tareas del motor dan siempre la misma respuesta (el estado sale de DynamoDB, empates por id).
- Qué hace λ y cómo se ajustó con el banco.
- Por qué no hay estado en la memoria de una Lambda (no hay Lambda; la caché es por turno e inmutable).

## Reglas que no se rompen

- La respuesta siempre es un **vecino por una calle abierta o el mismo nodo**. Ante cualquier duda, quedarse quieto es mejor que un movimiento inválido o un error.
- Nunca responder 5xx: un nodo o sobreviviente desconocido devuelve `{"siguienteNodo": nodoActual}`.
- Lo que exige la nube está en la [sección 5 de `docs/aws.md`](../aws.md#5-lo-que-la-nube-espera-del-motor-y-del-simulador): bundle único `dist/index.cjs`, puerto `PUERTO`, `GET /salud`, sin escribir en disco, keep-alive de 65 s.
- Conservar del esqueleto la comparación de `x-api-key` con `timingSafeEqual`.
- Sin logs por pedido (como mucho, muestreo del 1 %).

## Encargo para tu asistente de IA

Pégalo al empezar y ve pidiéndole una tarea a la vez:

```text
Estoy en el repo manta-zombie (TypeScript, Node 22, npm workspaces). Soy la persona A del equipo y me toca el motor de rutas del reto "Escape de Manta Zombie".

Lee primero docs/plan.md (secciones 4, 5 y 10), docs/aws.md (sección 5) y docs/equipo/persona-a.md. El contrato de la sección 4 no se cambia sin avisar al equipo.

Qué hay que construir:
1. src/compartido: tipos del contrato, carga del grafo (data/prueba.json y data/manta.json), vecinos, esMovimientoValido y las reglas duras (zombie visible, horda y todos sus vecinos, arista bloqueada, cruce con el recorrido de un zombie).
2. src/motor: POST /paso y POST /rutas sobre el servidor que ya existe en src/motor/src/index.ts (conserva GET /salud, la validación de x-api-key con timingSafeEqual, el límite de 1 KB y el keepAliveTimeout de 65 s). El estado del turno se lee de DynamoDB (tabla TABLA_MUNDO, clave partida = "actual") con un solo GetItem por turno y tarea (singleflight, ConsistentRead) y se cachean los últimos 2 turnos.
3. Plan por turno: costo blando por caminantes, corredores y callejones; Dijkstra desde cada refugio con costo = 1 + λ·tiempo/tiempo_medio + peligro; elegir entre los vecinos permitidos y quedarse quieto el que minimiza costo + campo del refugio asignado.
4. PRO: predicción de corredores y reparto por capacidad de refugios con histéresis (refugioAnterior) y desempate por id.
5. Pruebas con vitest y un banco sin red que use src/simulador/juego.ts de la persona B.

Reglas: la respuesta siempre es un vecino por calle abierta o el mismo nodo; nunca un 5xx; nada de llaves en el código; todo debe compilar con esbuild a un solo dist/index.cjs sin módulos nativos.

Trabaja en pasos pequeños: después de cada paso, corre las pruebas, dime qué archivo cambiaste y explícame el código en dos o tres frases, porque tengo que poder defenderlo ante el jurado. Propón un mensaje de commit corto en español al final de cada paso.
```
