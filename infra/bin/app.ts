// App de CDK con todo el sistema. Región fija: us-east-1.
// El AWS Budget se creó a mano en la consola (docs/aws.md, sección 2).
//
//   npm run desplegar -- -c correoAlertas=equipo@correo.com
import * as cdk from 'aws-cdk-lib';
import { join } from 'node:path';
import { MantaStack } from '../lib/manta-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

const correoAlertas = app.node.tryGetContext('correoAlertas') as string | undefined;
const arquitectura = app.node.tryGetContext('arquitectura') === 'x86' ? 'x86' : 'arm64';
const motorMinimo = Number(app.node.tryGetContext('motorMinimo') ?? 2);
if (!Number.isInteger(motorMinimo) || motorMinimo < 1) throw new Error('motorMinimo debe ser un entero mayor o igual a 1');

if (!correoAlertas) {
  console.warn('Sin -c correoAlertas=...: las alarmas de CloudWatch no mandan correo.');
}

new MantaStack(app, 'MantaZombie', {
  env,
  raiz: join(__dirname, '..', '..'),
  arquitectura,
  motorMinimo,
  correoAlertas,
});

// Permite filtrar el gasto del proyecto en Cost Explorer (activar la etiqueta en Billing)
cdk.Tags.of(app).add('proyecto', 'manta-zombie');
