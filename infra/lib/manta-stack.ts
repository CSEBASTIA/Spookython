import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MantaProps extends cdk.StackProps {
  /** Raíz del repositorio: de ahí salen src/motor, src/simulador y src/mapa. */
  raiz: string;
  arquitectura: 'arm64' | 'x86';
  /** Tareas del motor siempre encendidas; subirlo a 3 antes de la demo. */
  motorMinimo: number;
  correoAlertas?: string;
}

const PUERTO = 8080;
const MINUTO = cdk.Duration.minutes(1);
const NAMESPACE_METRICAS = 'MantaZombie';
// Proyecto de hackatón: `cdk destroy` debe dejar la cuenta limpia
const TEMPORAL = cdk.RemovalPolicy.DESTROY;

/**
 * Todo el sistema (sección 3 del plan):
 * CloudFront → S3 (mapa) y → ALB → Fargate (motor ×2–6, simulador ×1) → DynamoDB.
 */
export class MantaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MantaProps) {
    super(scope, id, props);

    const { raiz } = props;
    for (const servicio of ['motor', 'simulador']) {
      if (!existsSync(join(raiz, 'src', servicio, 'dist', 'index.cjs'))) {
        throw new Error(`Falta src/${servicio}/dist/index.cjs: ejecuta "npm run build" antes de usar cdk.`);
      }
    }
    const arm = props.arquitectura === 'arm64';

    // ── Red: solo subredes públicas y sin NAT (ahorra unos USD 33 al mes) ──
    const vpc = new ec2.Vpc(this, 'Red', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'publica', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // ── Estado del mundo: un ítem por partida, compartido por todas las tareas ──
    const tabla = new dynamodb.Table(this, 'Mundo', {
      partitionKey: { name: 'partida', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expira',
      removalPolicy: TEMPORAL,
    });

    // ── Llaves: las genera AWS, nunca están en el código ──
    const nuevaLlave = (id: string, description: string) =>
      new secretsmanager.Secret(this, id, {
        description,
        generateSecretString: { passwordLength: 48, excludePunctuation: true },
        removalPolicy: TEMPORAL,
      });
    const apiKey = nuevaLlave('ApiKey', 'Manta Zombie: x-api-key de POST /paso y POST /rutas');
    const adminKey = nuevaLlave('AdminKey', 'Manta Zombie: x-admin-key de /admin/* del simulador');
    const secretoOrigen = nuevaLlave('SecretoOrigen', 'Manta Zombie: encabezado x-origen de CloudFront al ALB');
    // Referencia dinámica: CloudFormation lee el valor al desplegar y no queda en la plantilla
    const valorOrigen = secretoOrigen.secretValue.unsafeUnwrap();

    // ── Grupos de seguridad: internet → CloudFront → ALB → tareas ──
    const sgAlb = new ec2.SecurityGroup(this, 'SgAlb', {
      vpc,
      allowAllOutbound: false,
      description: 'ALB de Manta Zombie: solo recibe de CloudFront',
    });
    const sgTareas = new ec2.SecurityGroup(this, 'SgTareas', {
      vpc,
      allowAllOutbound: true, // ECR, DynamoDB, Secrets Manager y la URL pública del motor
      description: 'Tareas de Manta Zombie: solo reciben del ALB',
    });
    sgAlb.connections.allowTo(sgTareas, ec2.Port.tcp(PUERTO), 'ALB hacia las tareas');

    // El id de la lista de prefijos de CloudFront cambia por región: se consulta al desplegar
    const listaCloudFront = new cr.AwsCustomResource(this, 'ListaCloudFront', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }],
        },
        physicalResourceId: cr.PhysicalResourceId.of('lista-cloudfront-origen'),
        outputPaths: ['PrefixLists.0.PrefixListId'],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      installLatestAwsSdk: false,
    });
    sgAlb.addIngressRule(
      ec2.Peer.prefixList(listaCloudFront.getResponseField('PrefixLists.0.PrefixListId')),
      ec2.Port.tcp(80),
      'Solo los servidores de origen de CloudFront',
    );

    // ── ALB: sin el encabezado secreto responde 403 ──
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sgAlb,
      idleTimeout: cdk.Duration.seconds(60),
      dropInvalidHeaderFields: true,
    });
    const oyente = alb.addListener('Http', {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Acceso solo por CloudFront',
      }),
    });

    // ── CloudFront: única URL pública, para el mapa (S3) y la API (ALB) ──
    const sitio = new s3.Bucket(this, 'Sitio', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: TEMPORAL,
      autoDeleteObjects: true,
    });
    const origenApi = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { 'x-origen': valorOrigen },
      connectionTimeout: cdk.Duration.seconds(2),
      readTimeout: cdk.Duration.seconds(10),
      keepaliveTimeout: cdk.Duration.seconds(60), // reusar conexiones al ALB baja la latencia
    });
    const api: cloudfront.BehaviorOptions = {
      origin: origenApi,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Pasa todos los encabezados del cliente (incluida x-api-key) menos Host
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    const distribucion = new cloudfront.Distribution(this, 'Distribucion', {
      comment: 'Escape de Manta Zombie',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(sitio),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: { '/paso': api, '/rutas': api, '/estado': api, '/admin/*': api },
    });
    const urlPublica = `https://${distribucion.distributionDomainName}`;

    // Sube el mapa de C si ya existe; si no, una página provisional que consulta /estado
    const carpetaMapa = existsSync(join(raiz, 'src', 'mapa', 'dist', 'index.html'))
      ? join(raiz, 'src', 'mapa', 'dist')
      : join(raiz, 'infra', 'sitio-provisional');
    new s3deploy.BucketDeployment(this, 'SubirMapa', {
      sources: [s3deploy.Source.asset(carpetaMapa)],
      destinationBucket: sitio,
      distribution: distribucion,
      distributionPaths: ['/*'],
    });

    // ── ECS Fargate ──
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const crearTarea = (nombre: 'motor' | 'simulador', entorno: Record<string, string>, secretos: Record<string, ecs.Secret>) => {
      const tarea = new ecs.FargateTaskDefinition(this, `Tarea-${nombre}`, {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: arm ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      tarea.addContainer(nombre, {
        image: ecs.ContainerImage.fromAsset(join(raiz, 'src', nombre), {
          platform: arm ? Platform.LINUX_ARM64 : Platform.LINUX_AMD64,
        }),
        portMappings: [{ containerPort: PUERTO }],
        environment: {
          PUERTO: String(PUERTO),
          AWS_REGION: this.region,
          TABLA_MUNDO: tabla.tableName,
          ...entorno,
        },
        secrets: secretos,
        readonlyRootFilesystem: true,
        stopTimeout: cdk.Duration.seconds(10),
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: nombre,
          logGroup: new logs.LogGroup(this, `Logs-${nombre}`, {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: TEMPORAL,
          }),
        }),
      });
      return tarea;
    };

    // Mínimo privilegio: el motor solo lee el estado del turno
    const tareaMotor = crearTarea('motor', {}, { API_KEY: ecs.Secret.fromSecretsManager(apiKey) });
    tareaMotor.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [tabla.tableArn],
    }));

    // El simulador escribe el turno y llama al motor por la URL pública, como el jurado
    const tareaSimulador = crearTarea('simulador', { URL_MOTOR: urlPublica }, {
      API_KEY: ecs.Secret.fromSecretsManager(apiKey),
      ADMIN_KEY: ecs.Secret.fromSecretsManager(adminKey),
    });
    tareaSimulador.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [tabla.tableArn],
    }));
    // PutMetricData no admite ARN de recurso: se limita al namespace del proyecto
    tareaSimulador.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': NAMESPACE_METRICAS } },
    }));

    const enRedPublica = {
      cluster,
      assignPublicIp: true, // sin NAT, la IP pública es la salida a ECR y a los servicios de AWS
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [sgTareas],
      circuitBreaker: { rollback: true },
    };
    const servicioMotor = new ecs.FargateService(this, 'ServicioMotor', {
      ...enRedPublica,
      taskDefinition: tareaMotor,
      desiredCount: props.motorMinimo,
      minHealthyPercent: 100, // al actualizar, las tareas viejas atienden hasta que las nuevas están sanas
      maxHealthyPercent: 200,
    });
    const maximoMotor = Math.max(6, props.motorMinimo);
    servicioMotor.autoScaleTaskCount({ minCapacity: props.motorMinimo, maxCapacity: maximoMotor }).scaleOnCpuUtilization('CpuMotor', {
      targetUtilizationPercent: 50,
      scaleOutCooldown: cdk.Duration.seconds(30),
      scaleInCooldown: cdk.Duration.minutes(2),
    });
    const servicioSimulador = new ecs.FargateService(this, 'ServicioSimulador', {
      ...enRedPublica,
      taskDefinition: tareaSimulador,
      desiredCount: 1,
      minHealthyPercent: 0, // nunca dos simuladores a la vez: habría dos dueños del juego
      maxHealthyPercent: 100,
    });

    // ── Rutas del ALB: solo con el encabezado secreto de CloudFront ──
    const crearGrupo = (id: string, servicio: ecs.FargateService) =>
      new elbv2.ApplicationTargetGroup(this, id, {
        vpc,
        port: PUERTO,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        targets: [servicio],
        deregistrationDelay: cdk.Duration.seconds(5),
        healthCheck: {
          path: '/salud',
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 2,
        },
      });
    const grupoMotor = crearGrupo('GrupoMotor', servicioMotor);
    const grupoSimulador = crearGrupo('GrupoSimulador', servicioSimulador);
    const desdeCloudFront = elbv2.ListenerCondition.httpHeader('x-origen', [valorOrigen]);
    oyente.addAction('AlMotor', {
      priority: 10,
      conditions: [desdeCloudFront, elbv2.ListenerCondition.pathPatterns(['/paso', '/rutas'])],
      action: elbv2.ListenerAction.forward([grupoMotor]),
    });
    oyente.addAction('AlSimulador', {
      priority: 20,
      conditions: [desdeCloudFront, elbv2.ListenerCondition.pathPatterns(['/estado', '/admin/*'])],
      action: elbv2.ListenerAction.forward([grupoSimulador]),
    });

    // ── Monitoreo ──
    const latenciaMotor = grupoMotor.metrics.targetResponseTime({ statistic: 'p95', period: MINUTO });
    const errores5xx = grupoMotor.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
      statistic: 'Sum',
      period: MINUTO,
    });
    // La publica el simulador con PutMetricData: namespace MantaZombie, sin dimensiones, en ms
    const latenciaSimulador = new cloudwatch.Metric({
      namespace: NAMESPACE_METRICAS,
      metricName: 'LatenciaPaso',
      statistic: 'p95',
      period: MINUTO,
    });

    const alarmas = [
      new cloudwatch.Alarm(this, 'AlarmaLatencia', {
        alarmDescription: 'p95 de POST /paso dentro de AWS sobre 300 ms',
        metric: latenciaMotor,
        threshold: 0.3,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'AlarmaErrores', {
        alarmDescription: 'Más de 10 respuestas 5xx del motor en un minuto',
        metric: errores5xx,
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    if (props.correoAlertas) {
      const tema = new sns.Topic(this, 'Alertas', { displayName: 'Manta Zombie', enforceSSL: true });
      tema.addSubscription(new subs.EmailSubscription(props.correoAlertas));
      for (const alarma of alarmas) alarma.addAlarmAction(new cwActions.SnsAction(tema));
    }

    const nombrePanel = 'manta-zombie';
    new cloudwatch.Dashboard(this, 'Panel', {
      dashboardName: nombrePanel,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'p95 de /paso medido por el simulador (ms)',
            left: [latenciaSimulador],
            leftAnnotations: [{ value: 150, label: 'nota 10' }, { value: 300, label: 'nota 7' }],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'p95 de /paso dentro de AWS (s)',
            left: [latenciaMotor],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Pedidos al motor y errores 5xx por minuto',
            left: [grupoMotor.metrics.requestCount({ statistic: 'Sum', period: MINUTO })],
            right: [errores5xx],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'CPU de las tareas (%)',
            left: [
              servicioMotor.metricCpuUtilization({ period: MINUTO, label: 'motor' }),
              servicioSimulador.metricCpuUtilization({ period: MINUTO, label: 'simulador' }),
            ],
            width: 12,
          }),
        ],
        [new cloudwatch.AlarmStatusWidget({ title: 'Alarmas', alarms: alarmas, width: 24 })],
      ],
    });

    // ── Salidas: lo que va al README ──
    new cdk.CfnOutput(this, 'Url', { value: urlPublica, description: 'URL pública: mapa en vivo y API' });
    new cdk.CfnOutput(this, 'UrlPaso', { value: `${urlPublica}/paso`, description: 'Endpoint POST /paso' });
    new cdk.CfnOutput(this, 'SecretoApiKey', {
      value: apiKey.secretArn,
      description: 'x-api-key: aws secretsmanager get-secret-value --secret-id <este valor>',
    });
    new cdk.CfnOutput(this, 'SecretoAdminKey', {
      value: adminKey.secretArn,
      description: 'x-admin-key: aws secretsmanager get-secret-value --secret-id <este valor>',
    });
    new cdk.CfnOutput(this, 'TablaMundo', { value: tabla.tableName, description: 'Tabla de DynamoDB con el estado' });
    new cdk.CfnOutput(this, 'UrlPanel', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${nombrePanel}`,
      description: 'Panel de CloudWatch',
    });
  }
}
