// Dónde se guarda el estado de cada turno para que lo lea el motor.
// En AWS es DynamoDB; en local puede ser un archivo (el motor lo lee con ESTADO_ARCHIVO).
import { rename, writeFile } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { EstadoTurno } from '../../compartido/src/tipos.js';

/** El ítem se borra solo una hora después de la última escritura (TTL de la tabla). */
const VIDA_SEGUNDOS = 3600;

export interface DestinoEstado {
  guardar(estado: EstadoTurno): Promise<void>;
}

export function destinoDynamo(tabla: string, opciones: { region?: string; endpoint?: string } = {}): DestinoEstado {
  const cliente = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: opciones.region,
      endpoint: opciones.endpoint,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 500, requestTimeout: 800 },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return {
    async guardar(estado) {
      await cliente.send(
        new PutCommand({ TableName: tabla, Item: { ...estado, expira: Math.floor(Date.now() / 1000) + VIDA_SEGUNDOS } }),
      );
    },
  };
}

export function destinoArchivo(ruta: string): DestinoEstado {
  return {
    async guardar(estado) {
      // Se escribe aparte y se renombra: el motor nunca lee un archivo a medias
      const temporal = `${ruta}.${process.pid}.tmp`;
      await writeFile(temporal, JSON.stringify(estado));
      await rename(temporal, ruta);
    },
  };
}
