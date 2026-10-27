// App de CDK: un stack con el presupuesto (se despliega primero, el reto lo pide
// desde el día 1) y otro con todo el sistema. Región fija: us-east-1.
//
//   npm run presupuesto -- -c correoAlertas=equipo@correo.com
//   npm run desplegar   -- -c correoAlertas=equipo@correo.com
import * as cdk from 'aws-cdk-lib';
import { join } from 'node:path';
import { MantaStack } from '../lib/manta-stack';
import { PresupuestoStack } from '../lib/presupuesto-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

const correoAlertas = app.node.tryGetContext('correoAlertas') as string | undefined;
const limiteUsd = Number(app.node.tryGetContext('limiteUsd') ?? 25);
const arquitectura = app.node.tryGetContext('arquitectura') === 'x86' ? 'x86' : 'arm64';
const motorMinimo = Number(app.node.tryGetContext('motorMinimo') ?? 2);
if (!Number.isInteger(motorMinimo) || motorMinimo < 1) throw new Error('motorMinimo debe ser un entero mayor o igual a 1');

if (correoAlertas) {
  new PresupuestoStack(app, 'MantaZombie-Presupuesto', { env, correo: correoAlertas, limiteUsd });
} else {
  console.warn('Sin -c correoAlertas=...: el stack MantaZombie-Presupuesto no se genera y las alarmas no mandan correo.');
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
