import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { initSentry } from './observability/sentry';
import { resolveTrustProxyHops } from './common/trust-proxy';
import { assertSeparateHotKeys } from './common/facilitator-signer';
import { assertNetworkReady } from './common/stellar-network';
import { buildCorsMiddleware } from './common/cors';

async function bootstrap() {
  // Refuse to start if the facilitator, deployer, and fee keys overlap.
  assertSeparateHotKeys();
  assertNetworkReady();
  initSentry();
  // bufferLogs holds anything logged before the pino logger takes over
  // (below) and replays it through pino instead of dropping it or falling
  // back to Nest's plain console logger for just those first few lines.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.use(helmet());
  app.use(compression());
  app.use(buildCorsMiddleware());
  // Express auto-generates ETags for every response by default, which lets
  // a browser skip re-fetching via a conditional request — a second,
  // independent caching path beyond Cache-Control that would reproduce the
  // exact same "fix didn't take" symptom on its own.
  app.getHttpAdapter().getInstance().set('etag', false);
  // Rate limits key on req.ip, so this must match the real proxy chain.
  app.getHttpAdapter().getInstance().set('trust proxy', resolveTrustProxyHops());
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`konfirm-backend listening on :${port}`);
}
bootstrap();
