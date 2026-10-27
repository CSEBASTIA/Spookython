# Despliegue en AWS

Guía para crear la cuenta, desplegar el sistema, probarlo y apagarlo. Todo se ejecuta desde la **raíz del repositorio** y la región es **us-east-1** (fija en `infra/bin/app.ts`).

| Archivo | Qué es |
|---|---|
| [`infra/bin/app.ts`](../infra/bin/app.ts) | App de CDK con el stack `MantaZombie`. **Pendiente de C:** todavía importa `presupuesto-stack.ts`, que ya no existe; hay que quitar ese import, el bloque `if (correoAlertas)` que crea `MantaZombie-Presupuesto` y el script `presupuesto` de `package.json` (el Budget se crea en la consola, sección 2) |
| [`infra/lib/manta-stack.ts`](../infra/lib/manta-stack.ts) | Todo el sistema: VPC, DynamoDB, secretos, ALB, ECS Fargate, CloudFront, S3, CloudWatch |
| [`infra/sitio-provisional/`](../infra/sitio-provisional/index.html) | Página que se publica mientras `src/mapa/dist` no exista |
| `src/motor`, `src/simulador` | **Esqueletos desplegables**: cumplen el contrato pero no juegan. A y B los reemplazan (ver [sección 5](#5-lo-que-la-nube-espera-del-motor-y-del-simulador)) |

## 1. Cuenta de AWS (una sola vez)

Esto lo hace una persona del equipo con su propia tarjeta y su correo; nadie más debe escribir esos datos.

1. Crear la cuenta en <https://aws.amazon.com/free>.
2. **MFA en el usuario root:** consola → nombre de la cuenta (arriba a la derecha) → *Security credentials* → *Assign MFA device*. Después de esto, el root no se usa para el trabajo diario.
3. **Usuario para desplegar:** abrir *IAM Identity Center* en us-east-1 → *Enable*. Crear un usuario y asignarle el conjunto de permisos `AdministratorAccess` sobre la cuenta. Solo lo usa la persona que despliega, con credenciales temporales; las tareas del sistema tienen sus propios roles mínimos.
4. **Instalar AWS CLI** en la PC que despliega. Con winget:

   ```bash
   winget install -e --id Amazon.AWSCLI
   ```

   Después cerrar y volver a abrir la terminal.
5. **Iniciar sesión** con el usuario de Identity Center (pide la URL del portal que muestra Identity Center; la región es `us-east-1` y el nombre de perfil puede ser `manta`):

   ```bash
   aws configure sso
   ```

   Cada vez que caduque la sesión:

   ```bash
   aws sso login --profile manta
   ```

   En cada terminal nueva hay que decir qué perfil usar: en Git Bash `export AWS_PROFILE=manta`, en PowerShell `$env:AWS_PROFILE="manta"`.
6. Verificar que la CLI ve la cuenta:

   ```bash
   aws sts get-caller-identity
   ```

7. **Cupo de Fargate.** El sistema usa como máximo 1,75 vCPU (hasta 6 motores y 1 simulador de 0,25 vCPU). Las cuentas nuevas a veces traen un cupo bajo:

   ```bash
   aws service-quotas get-service-quota --service-code fargate --quota-code L-3032A538 --query Quota.Value
   ```

   Si devuelve menos de 2, pedir el aumento en *Service Quotas* el mismo día.

## 2. Presupuesto (antes de cualquier otra cosa)

El Budget se crea **a mano en la consola**, siguiendo la guía oficial [Creating a budget](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html). El reto lo pide desde el primer día y la captura sale de la misma pantalla. Se puede hacer con el usuario root (con MFA) o con el usuario de Identity Center.

1. Abrir la consola de [Billing and Cost Management](https://console.aws.amazon.com/cost-management/) → en el menú, **Budgets** → **Create budget**.
2. En *Budget setup* elegir **Use a template (simplified)** y la plantilla **Monthly cost budget** (avisa si el gasto real supera el presupuesto o si el pronóstico lo va a superar).
3. *Budget name:* `manta-zombie-mensual`. *Enter your budgeted amount:* `25`. *Email recipients:* el correo del equipo (si llega un correo de verificación, aceptarlo).
4. **Create budget**.
5. Opcional, para un aviso temprano: abrir el budget → **Edit** → en las alertas agregar una de gasto real (*Actual*) al **50 %**.
6. **Captura para el README:** *Budgets* → `manta-zombie-mensual`, con el monto y las alertas a la vista. Guardarla como `docs/budget.png` y revisar que no muestre el correo ni el número de cuenta completo.

El correo del equipo **no se sube al repo**. Para que las alarmas de CloudWatch del stack también manden correo, va como contexto en un `cdk.context.json` en la raíz (ya está en `.gitignore`):

```json
{ "correoAlertas": "correo-del-equipo@ejemplo.com" }
```

Después, instalar dependencias y preparar la cuenta para CDK (crea un bucket y un repositorio ECR propios de CDK; una sola vez):

```bash
npm install
```

```bash
npx cdk bootstrap
```

Para filtrar el gasto del proyecto en Cost Explorer: *Billing* → *Cost allocation tags* → activar la etiqueta `proyecto` (todos los recursos la llevan con el valor `manta-zombie`; tarda hasta 24 h en aparecer).

## 3. Desplegar el sistema

Docker Desktop tiene que estar abierto: CDK construye las imágenes del motor y del simulador.

```bash
npm run desplegar
```

`npm run desplegar` compila los servicios (`npm run build`) y ejecuta `cdk deploy MantaZombie`. La primera vez tarda entre 15 y 20 minutos, sobre todo por CloudFront. Al terminar imprime:

| Salida | Para qué |
|---|---|
| `Url` | URL pública: mapa en vivo y API |
| `UrlPaso` | El endpoint `POST /paso` que va en el README |
| `SecretoApiKey` | ARN del secreto con la `x-api-key` |
| `SecretoAdminKey` | ARN del secreto con la `x-admin-key` |
| `TablaMundo` | Nombre de la tabla de DynamoDB |
| `UrlPanel` | Panel de CloudWatch con latencia, errores y CPU |

Si se configuró `correoAlertas`, llega un correo de SNS para confirmar la suscripción a las alarmas: hay que aceptarlo.

Opciones (se pasan con `-c`, por ejemplo `npm run desplegar -- -c motorMinimo=3`):

| Opción | Valor por defecto | Para qué |
|---|---|---|
| `motorMinimo` | `2` | Tareas del motor siempre encendidas. **Subirlo a 3 antes de la demo** |
| `arquitectura` | `arm64` | `x86` si la imagen ARM64 da problemas en Windows (cuesta un poco más) |

## 4. Probar que funciona

En Git Bash, reemplazando los valores por las salidas del despliegue:

```bash
URL=https://dxxxxxxxxxxxx.cloudfront.net
API_KEY=$(aws secretsmanager get-secret-value --secret-id ARN_DE_SecretoApiKey --query SecretString --output text)
ADMIN_KEY=$(aws secretsmanager get-secret-value --secret-id ARN_DE_SecretoAdminKey --query SecretString --output text)
```

| Prueba | Comando | Resultado esperado |
|---|---|---|
| `/paso` con llave | `curl -s -X POST "$URL/paso" -H "x-api-key: $API_KEY" -H 'content-type: application/json' -d '{"sobrevivienteId":"S-0001","nodoActual":"N-0001","turno":1}'` | `{"siguienteNodo":"N-0001"}` |
| `/paso` sin llave | `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/paso" -d '{}'` | `401` |
| Estado público | `curl -s "$URL/estado"` | JSON con `"turno":0` |
| Latencia desde AWS | `curl -s -X POST "$URL/admin/probar-motor" -H "x-admin-key: $ADMIN_KEY"` | 50 pedidos del simulador al motor por la URL pública, con p50, p95 y máximo en ms |
| Mapa | Abrir `$URL` en el navegador | Página provisional que dice que `/estado` responde |
| ALB directo | Abrir en el navegador el DNS del ALB (consola de EC2 → *Load Balancers*) | No responde: solo entra el tráfico de CloudFront |

En PowerShell la llave se lee así:

```powershell
$API_KEY = aws secretsmanager get-secret-value --secret-id ARN_DE_SecretoApiKey --query SecretString --output text
Invoke-RestMethod -Method Post -Uri "$URL/paso" -Headers @{ "x-api-key" = $API_KEY } -ContentType "application/json" -Body '{"sobrevivienteId":"S-0001","nodoActual":"N-0001","turno":1}'
```

Las llaves nunca se copian al código ni al README: se leen de Secrets Manager cuando hacen falta.

## 5. Lo que la nube espera del motor y del simulador

A y B pueden cambiar todo el código de `src/motor` y `src/simulador` mientras mantengan esto:

- **Compilación:** `npm run build` dentro del servicio deja todo en un solo archivo, `dist/index.cjs` (hoy con esbuild). La imagen copia **solo** `dist/`, así que las dependencias (Fastify, AWS SDK) tienen que ir dentro del bundle y deben ser JavaScript puro, sin módulos nativos. El mapa base no va en el bundle: `npm run build` lo copia a `dist/mapa.json` con `scripts/copiar-mapa.mjs` (usa `data/manta.json` si existe y, si no, `data/prueba.json`), así que también queda dentro de la imagen.
- **Puerto:** escuchar en `PUERTO` (8080).
- **Salud:** `GET /salud` responde 200 en menos de 2 s. El ALB lo consulta cada 5 s y saca de servicio a la tarea que falla 2 veces seguidas.
- **Disco de solo lectura:** no escribir archivos; los logs van a la salida estándar (CloudWatch Logs los guarda 7 días).
- **Keep-alive:** `keepAliveTimeout` de Node mayor que 60 s (los esqueletos usan 65 s). Si Node corta antes que el ALB, aparecen errores 502.
- **Variables que ya llegan:**

  | Variable | Motor | Simulador |
  |---|---|---|
  | `PUERTO` | ✓ | ✓ |
  | `AWS_REGION` | ✓ | ✓ |
  | `TABLA_MUNDO` | ✓ (solo `GetItem`) | ✓ (`GetItem` y `PutItem`) |
  | `API_KEY` (desde Secrets Manager) | ✓ | ✓ |
  | `ADMIN_KEY` (desde Secrets Manager) | — | ✓ |
  | `URL_MOTOR` (la URL pública de CloudFront) | — | ✓ |

- **Métrica de latencia (simulador):** publicar una vez por turno las latencias de `/paso` con `PutMetricData` (`@aws-sdk/client-cloudwatch`), namespace `MantaZombie`, métrica `LatenciaPaso`, unidad `Milliseconds`, **sin dimensiones**, mandando los valores crudos en `Values` y `Counts` para que CloudWatch pueda calcular el p95. El rol del simulador solo puede escribir en ese namespace. El panel ya tiene el gráfico.
- **Un solo simulador:** el servicio nunca corre dos a la vez, ni siquiera durante un despliegue, porque habría dos dueños del juego.
- **Permisos nuevos:** si alguien necesita otra acción de AWS (por ejemplo `dynamodb:Query`), se agrega en `infra/lib/manta-stack.ts` solo para el rol que la usa.

## 6. Operación

| Tarea | Cómo |
|---|---|
| Actualizar después de un cambio | `npm run desplegar`. El motor se actualiza sin cortes (las tareas viejas atienden hasta que las nuevas están sanas). Si las nuevas no arrancan, ECS vuelve solo a la versión anterior |
| Ver logs en vivo | `aws logs describe-log-groups --log-group-name-prefix MantaZombie --query "logGroups[].logGroupName"` y después `aws logs tail NOMBRE_DEL_GRUPO --follow` |
| Calentar antes de la demo | `npm run desplegar -- -c motorMinimo=3` unos 10 minutos antes |
| Ver cuánto se gastó | Cost Explorer con el filtro `proyecto = manta-zombie` (ver [costos](costos.md)) |
| **Apagar todo** (después del pitch) | `npm run destruir`. Borra el sistema, incluidos la tabla, los secretos y el bucket |
| Borrar el presupuesto | Consola → *Budgets* → `manta-zombie-mensual` → *Delete* (conviene dejarlo hasta fin de mes) |

`npm run destruir` no borra el stack `CDKToolkit` que creó `cdk bootstrap`: su bucket y su repositorio ECR guardan las imágenes subidas. Cuestan centavos; si quieren dejar la cuenta en cero, vacíen el repositorio ECR `cdk-…-container-assets-…` y borren el stack `CDKToolkit` desde CloudFormation.

## 7. Si algo falla

| Síntoma | Causa probable y solución |
|---|---|
| `Unable to resolve AWS account to use` | La sesión de SSO caducó o falta `AWS_PROFILE`: `aws sso login --profile manta` |
| `Falta src/motor/dist/index.cjs` | Se ejecutó `cdk` sin compilar: usar `npm run desplegar` o `npm run build` primero |
| `Cannot connect to the Docker daemon` | Abrir Docker Desktop y esperar a que diga *Engine running* |
| Falla la imagen ARM64 | Desplegar con `-c arquitectura=x86` |
| El despliegue se queda en `ServicioMotor` y termina en *rollback* | Las tareas no pasan el chequeo de `/salud`: revisar los logs del servicio (paso 6) |
| CloudFront responde 502 o 504 | No hay tareas sanas detrás del ALB: consola de EC2 → *Target groups* → estado de los destinos |
| `Acceso solo por CloudFront` (403) | El pedido llegó al ALB sin pasar por CloudFront: usar siempre la `Url` del despliegue |
