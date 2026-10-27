# Persona C · Nube y producto

**Nombre:** _(escribir; quien tiene la PC con el CDK)_ · **Entrega:** miércoles 28 de octubre, 10:00 · **Plan general:** [`docs/plan.md`](../plan.md)

## Tu objetivo

Que todo esté en AWS con una URL pública que funcione hasta el pitch, que el mapa en vivo se entienda sin explicación y que los entregables que mira el jurado (Budget, diagrama, costos, README, repo público) estén completos. Cubres casi todo el 25 % de calidad técnica, el 15 % de producto y el 10 % de costos.

Eres dueña o dueño de la cuenta AWS, `infra/`, el despliegue, `docker-compose.yml`, `src/mapa`, el diagrama, `docs/costos.md`, el README integrado y el repo público.

## Lo que recibes y lo que entregas

| Qué | De / para |
|---|---|
| **Entregas** el repo público en GitHub con el primer commit | Para A y B (es lo primero que necesitan) |
| Recibes `src/compartido/tipos.ts` y `data/prueba.json` | De A y de B |
| **Entregas** la URL pública con los esqueletos | Para A y B |
| Recibes `data/manta.json` y `data/estado-ejemplo.json` | De B |
| Recibes la forma de la respuesta de `/rutas` | De A |
| **Entregas** `docker-compose.yml` funcionando | Para A y B |
| **Entregas** las diapositivas de arquitectura y costos | Para A |

## Tus tareas

En este orden; las primeras son las que los otros esperan. Si se puede, crea la cuenta de AWS cuanto antes: verificarla puede tardar horas.

| # | Tarea | Lista cuando |
|---|---|---|
| 1 | Revisar que el `.gitignore` deja fuera `.env`, `cdk.context.json`, `cdk.out` y `node_modules`. Primer commit con lo que ya existe, repo **público** `manta-zombie` en GitHub (con GitHub Desktop o la web) y sumar a A y B como colaboradores | A y B clonan y hacen su primer commit |
| 2 | Cuenta AWS según [`docs/aws.md`](../aws.md) sección 1: MFA en root, IAM Identity Center, AWS CLI, `aws configure sso` y cupo de Fargate | `aws sts get-caller-identity` responde |
| 3 | **Budget en la consola** ([`docs/aws.md`](../aws.md#2-presupuesto-antes-de-cualquier-otra-cosa) sección 2) y su captura en `docs/budget.png` | La captura muestra el monto y la alerta, sin correo ni número de cuenta |
| 4 | Quitar de `infra/bin/app.ts` el import de `presupuesto-stack.ts` y el bloque que crea `MantaZombie-Presupuesto`; quitar el script `presupuesto` de `package.json`. Correr `npm run typecheck` y `npm run synth` | Los dos comandos terminan sin errores |
| 5 | Docker Desktop abierto, `npx cdk bootstrap` y `npm run desplegar` con los esqueletos | Las pruebas de la sección 4 de `docs/aws.md` dan lo esperado: `/estado` responde, `/paso` sin llave da 401, el ALB directo no responde |
| 6 | Activar la etiqueta de costos `proyecto` en *Billing → Cost allocation tags* | Aparece como activa |
| 7 | `docker-compose.yml` con motor, simulador y DynamoDB Local (creando la tabla al arrancar) | A y B levantan las tres piezas con un comando |
| 8 | Mapa base en `src/mapa` (Vite + TypeScript + Leaflet, un workspace más): teselas oscuras de CARTO, calles por tipo, refugios con barra de ocupación, zombies con ícono por tipo, sobrevivientes por color, leyenda, línea de bienvenida, atribución de OSM y CARTO, usable en el celular | Dibuja Manta con `data/estado-ejemplo.json` |
| 9 | Mapa completo según la [sección 7 del plan](../plan.md#7-mapa-en-vivo-c): rutas planificadas, panel (ronda, turno, 5:00, vivos, salvados, mordidos, p95, errores, puntaje), «actualizado hace X s» en rojo después de 4 s, animación entre turnos, modo presentador (`admin-key` solo en `sessionStorage`, iniciar ronda, bloquear calle con un clic) | Una persona que no conoce el proyecto entiende qué pasa |
| 10 | Desplegar las imágenes reales del motor, del simulador y del mapa; revisar el panel de CloudWatch | R1–R3 corren en la URL pública |
| 11 | **Diagrama en draw.io** (detalle abajo): `docs/arquitectura.drawio` + `docs/arquitectura.png` y `.svg` | El README lo muestra y enlaza el `.drawio` |
| 12 | `docs/costos.md`: confirmar cada línea en la [calculadora de AWS](https://calculator.aws/), pegar el enlace del cálculo compartido y llenar «Gasto real» con Cost Explorer (captura en `docs/costo-real.png`) | Cada número tiene su cálculo visible y coincide con la cuenta |
| 13 | README de la raíz: qué hace, URL pública, URL de `/paso`, cómo desplegar (enlace a `docs/aws.md`), cómo probar, decisiones, limitaciones, captura del Budget, diagrama, costos, región `us-east-1` y «© OpenStreetMap contributors». Integrar las secciones de A y B | Todo lo que pide la lista de entregables está enlazado |
| 14 | Diapositivas de arquitectura y costos para el PDF | A las tiene |
| 15 | Día de la demo: `npm run desplegar -- -c motorMinimo=3` antes de entrar. Después del pitch: `npm run destruir` y anotar el gasto final en `costos.md` | — |

### Diagrama de arquitectura

- Hacerlo en [app.diagrams.net](https://app.diagrams.net/) con la biblioteca de formas de AWS (*More Shapes* → AWS), que usa los [íconos oficiales de arquitectura](https://aws.amazon.com/architecture/icons/).
- Contenido: el mismo flujo de [`docs/arquitectura.mmd`](../arquitectura.mmd). Grupos *AWS Cloud* → *Region us-east-1* → *VPC* con 2 subredes públicas. Usuario y jurado fuera de la nube. Flechas numeradas: navegador → CloudFront → S3 y ALB → motor y simulador → DynamoDB; Secrets Manager, CloudWatch y Budgets aparte.
- Marcar **qué es público**: solo CloudFront; el ALB solo recibe de CloudFront y las tareas solo del ALB.
- Guardar `docs/arquitectura.drawio` y exportar `docs/arquitectura.png` y `docs/arquitectura.svg`, que reemplazan a los generados desde Mermaid.

## Lo que tienes que poder explicar

- Por qué Fargate y no Lambda (sin arranques en frío, sin el límite de concurrencia de una cuenta nueva).
- Qué es público y qué no, y cómo se protege el ALB (lista de prefijos de CloudFront + encabezado secreto).
- Dónde están las llaves (Secrets Manager) y qué permisos tiene cada rol (mínimo privilegio).
- Por qué subredes públicas sin NAT y cuánto ahorra.
- Cuánto cuesta al mes, de dónde sale cada número y cuánto se gastó de verdad.
- Cómo el mapa demuestra que no está congelado.

## Reglas que no se rompen

- Ninguna llave, correo ni número de cuenta en el repo ni en las capturas. Las llaves se leen de Secrets Manager cuando hacen falta.
- No compartir las llaves por chat: A y B usan llaves de prueba en su `.env` local.
- Nadie despliega después del tag `v1.0`, salvo que la organización lo permita.
- El costo declarado tiene que coincidir con lo que muestra la cuenta.

## Encargo para tu asistente de IA

Pégalo al empezar y ve pidiéndole una tarea a la vez:

```text
Estoy en el repo manta-zombie (TypeScript, Node 22, npm workspaces, AWS CDK en infra/). Soy la persona C del equipo: me toca la nube, el mapa en vivo y los entregables del reto "Escape de Manta Zombie".

Lee primero docs/plan.md (secciones 3, 7, 8, 9 y 14), docs/aws.md completo, docs/costos.md y docs/equipo/persona-c.md.

Qué hay que hacer:
1. Arreglar infra/bin/app.ts: quitar el import de ../lib/presupuesto-stack (el archivo ya no existe) y el bloque que crea el stack MantaZombie-Presupuesto; quitar el script "presupuesto" de package.json. El Budget se crea a mano en la consola. Después correr npm run typecheck y npm run synth.
2. Acompañarme en el primer despliegue siguiendo docs/aws.md (no escribas llaves ni correos en archivos del repo; el correo va en cdk.context.json, que está en .gitignore).
3. src/mapa: Vite + TypeScript + Leaflet como workspace, que compile a src/mapa/dist (el stack lo sube a S3 si existe dist/index.html). Dibuja data/manta.json y consulta GET /estado cada segundo en el mismo origen: calles por tipo, refugios con barra de ocupación, zombies con ícono por tipo, sobrevivientes por color, rutas planificadas, panel con ronda, turno, cuenta regresiva, vivos, salvados, mordidos, p95, errores y puntaje, "actualizado hace X s" en rojo después de 4 s, animación entre turnos y modo presentador con la admin-key solo en sessionStorage. Todo en español, con leyenda y usable en el celular. Atribución a OpenStreetMap y CARTO.
4. docker-compose.yml con motor, simulador y DynamoDB Local, creando la tabla al arrancar.
5. README de la raíz con todo lo que pide la lista de entregables del reto.

Reglas: nada de llaves en el código; mínimo privilegio en IAM; si un cambio de infra/ agrega permisos, que sea solo para el rol que los usa.

Trabaja en pasos pequeños: después de cada paso, pruébalo, dime qué archivo cambiaste y explícame el código en dos o tres frases, porque tengo que poder defenderlo ante el jurado. Propón un mensaje de commit corto en español al final de cada paso.
```
