// Lee el estado del turno que escribe el simulador: un solo ítem con partida = "actual".
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { EstadoTurno } from '../../compartido/src/tipos.js';
import type { FuenteEstado } from './planes.js';

export function fuenteDynamo(tabla: string, opciones: { region?: string; endpoint?: string } = {}): FuenteEstado {
  const cliente = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: opciones.region,
      endpoint: opciones.endpoint, // DynamoDB Local en docker-compose
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 300, requestTimeout: 300 },
    }),
  );
  return {
    async leer() {
      // Lectura fuerte: así se ve lo último que escribió el simulador antes de llamar a /paso
      const { Item } = await cliente.send(
        new GetCommand({ TableName: tabla, Key: { partida: 'actual' }, ConsistentRead: true }),
      );
      return (Item as EstadoTurno | undefined) ?? null;
    },
  };
}
