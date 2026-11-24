import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(cfg));
  configureApp(app, cfg);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
  console.log(`API listening on :${cfg.port}`);
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
