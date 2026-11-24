import { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import * as express from 'express';
import { AppConfig } from './config';
import { AppExceptionFilter } from './http/errors';
import { securityMiddleware } from './http/security';

const DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** main.ts va e2e testlar uchun umumiy sozlash. */
export function configureApp(app: INestApplication, cfg: AppConfig): void {
  const http = app.getHttpAdapter().getInstance() as express.Express;
  if (cfg.trustProxy) http.set('trust proxy', 1);
  http.disable('x-powered-by');
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: cfg.corsOrigins, credentials: true });
  app.use('/api/v1/verification/documents', express.raw({ type: DOC_TYPES, limit: '5mb' }));
  app.use((req: Request, res: Response, next: NextFunction) => securityMiddleware(cfg)(req, res, next));
  app.useGlobalFilters(new AppExceptionFilter());
}
