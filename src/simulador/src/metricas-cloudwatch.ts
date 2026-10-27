// Publica en CloudWatch la latencia de POST /paso medida en cada turno (sección 5 de docs/aws.md):
// namespace MantaZombie, métrica LatenciaPaso, en milisegundos y sin dimensiones. Se mandan los
// valores crudos con Values y Counts para que CloudWatch pueda calcular el p95.
import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';

/** CloudWatch acepta hasta 150 valores distintos por dato. */
const VALORES_POR_DATO = 150;

export type PublicarLatencias = (milisegundos: readonly number[]) => Promise<void>;

export function publicadorCloudWatch(region?: string): PublicarLatencias {
  const cliente = new CloudWatchClient({ region, maxAttempts: 2 });
  return async (milisegundos) => {
    if (milisegundos.length === 0) return;
    const cuenta = new Map<number, number>();
    for (const ms of milisegundos) {
      const valor = Math.round(ms);
      cuenta.set(valor, (cuenta.get(valor) ?? 0) + 1);
    }
    const valores = [...cuenta.entries()];
    const datos: MetricDatum[] = [];
    for (let k = 0; k < valores.length; k += VALORES_POR_DATO) {
      const bloque = valores.slice(k, k + VALORES_POR_DATO);
      datos.push({
        MetricName: 'LatenciaPaso',
        Unit: 'Milliseconds',
        Timestamp: new Date(),
        Values: bloque.map(([valor]) => valor),
        Counts: bloque.map(([, veces]) => veces),
      });
    }
    await cliente.send(new PutMetricDataCommand({ Namespace: 'MantaZombie', MetricData: datos }));
  };
}
