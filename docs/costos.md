# Declaración de costos

Región **us-east-1**. Los precios de lista de esta tabla son una estimación escrita el 26 de octubre de 2026 y todavía no están verificados: antes de entregar, confirmar cada línea con la [calculadora de AWS](https://calculator.aws/) y llenar la sección «Gasto real» con lo que muestre Cost Explorer.

## Lo que se despliega

Todo sale de [`infra/lib/manta-stack.ts`](../infra/lib/manta-stack.ts):

- 3 tareas de ECS Fargate ARM64 de 0,25 vCPU y 0,5 GB: 2 del motor (hasta 6 con autoescalado) y 1 del simulador.
- 1 Application Load Balancer en 2 zonas.
- 1 distribución de CloudFront y 1 bucket de S3 para el mapa.
- 1 tabla de DynamoDB bajo demanda.
- 3 secretos en Secrets Manager.
- 2 grupos de logs (7 días), 1 métrica propia, 2 alarmas, 1 panel y 1 tema de SNS.
- VPC con 2 subredes públicas y **sin NAT Gateway**.

## Costo mensual si queda encendido las 24 horas

| Concepto | Cálculo | USD/mes |
|---|---|---:|
| Fargate, motor ×2 | 2 × (0,25 vCPU × 0,03238 + 0,5 GB × 0,00356) × 730 h | 14,42 |
| Fargate, simulador ×1 | 1 × 0,009875 × 730 h | 7,21 |
| ALB, por hora | 0,0225 × 730 h | 16,43 |
| ALB, LCU | ~0,008 × ~1 LCU en las horas con tráfico | ~1,00 |
| IPv4 públicas | 5 direcciones (2 del ALB, 3 de las tareas) × 0,005 × 730 h | 18,25 |
| Secrets Manager | 3 secretos × 0,40 | 1,20 |
| CloudWatch | 1 GB de logs (0,50) + 1 métrica propia (0,30) + 2 alarmas (0,20); el panel entra en los 3 gratuitos | 1,00 |
| DynamoDB bajo demanda | 1 escritura de ~20 WRU cada 2 s, solo mientras hay partidas | < 0,10 |
| CloudFront, S3, ECR y SNS | Dentro de la capa gratuita (CloudFront: 1 TB y 10 millones de pedidos al mes) | < 0,50 |
| Lambdas auxiliares de CDK | Solo corren al desplegar (lista de prefijos, subida del mapa, vaciado del bucket) | 0,00 |
| **Total** | | **≈ 60** |

Equivale a **≈ USD 2 por día**. Lo que más pesa es fijo (ALB e IPv4 públicas); un pedido más a `/paso` cuesta prácticamente cero. Si el motor escala a 6 tareas durante una ronda de 5 minutos, el extra es de menos de un centavo.

### Qué se eligió para gastar menos

| Decisión | Ahorro aproximado |
|---|---|
| Subredes públicas sin NAT Gateway | USD 33/mes (un NAT cuesta 0,045 por hora más el tráfico) |
| Fargate ARM64 (Graviton) en vez de x86 | ~20 % del cómputo, unos USD 5/mes con 3 tareas |
| DynamoDB bajo demanda en vez de ElastiCache | USD 12/mes del nodo más pequeño de Redis |
| CloudFront en vez de comprar dominio y certificado | El HTTPS sale gratis |

## Gasto esperado del evento

| Escenario | Días encendido | USD |
|---|---:|---:|
| Desplegado el martes 27, apagado después de la entrega del miércoles 28 | 2 | ≈ 4 |
| Desplegado el martes 27, apagado después del pitch del viernes 30 | 4 | ≈ 8 |

Las cuentas nuevas reciben hasta USD 200 en créditos, así que el gasto del evento queda cubierto. El AWS Budget (`manta-zombie-mensual`, USD 25, creado en la consola) avisa por correo si el gasto real o el pronosticado supera el monto.

## Gasto real

Se llena el día de la entrega con Cost Explorer: *Billing and Cost Management* → *Cost Explorer* → rango del evento → agrupar por servicio, con el filtro de etiqueta `proyecto = manta-zombie`. Los créditos aparecen como una línea negativa aparte; anotar el costo **antes** de créditos.

| Fecha | Costo antes de créditos (USD) | Captura |
|---|---:|---|
| _(llenar)_ | | `docs/costo-real.png` |
