import { DynamicModule, Module } from '@nestjs/common';
import { AdminController } from './api/admin.controller';
import { AuthController } from './api/auth.controller';
import { FilesController } from './api/files.controller';
import { AdminGuard, FullAccessGuard, UserGuard } from './api/guards';
import { VerificationController } from './api/verification.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AuthService, DEFAULT_AUTH_CONFIG } from './auth/auth.service';
import { AppConfig, CONFIG } from './config';
import { createDb, Db } from './db/db';
import { PgAdminRepo, PgAdminSessionRepo } from './db/pg-admin-repos';
import { PgCodeRepo, PgEmailOutbox, PgSessionRepo, PgThrottleRepo, PgUserRepo } from './db/pg-auth-repos';
import { PgAuditWriter, PgUserNotifier, PgVerificationRepo } from './db/pg-verification-repo';
import { HealthController } from './health/health.controller';
import { RateLimiter } from './http/rate-limiter';
import { LocalFsStorage } from './storage/local-fs-storage';
import { AdminQuizController } from './api/admin-quiz.controller';
import { QuizController } from './api/quiz.controller';
import { AdminQuizService } from './quiz/admin-quiz.service';
import { QuizService } from './quiz/quiz.service';
import { DEFAULT_VERIFICATION_CONFIG, VerificationService } from './verification/verification.service';

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig, opts: { now?: () => Date } = {}): DynamicModule {
    const now = opts.now ?? (() => new Date());
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, VerificationController, AdminController, FilesController, QuizController, AdminQuizController],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: Db, useFactory: () => createDb(cfg.databaseUrl) },
        { provide: RateLimiter, useFactory: (db: Db) => new RateLimiter(db), inject: [Db] },
        { provide: LocalFsStorage, useFactory: () => new LocalFsStorage(cfg.storageDir, cfg.fileUrlSecret, cfg.publicBaseUrl) },
        {
          provide: AuthService, inject: [Db],
          useFactory: (db: Db) => new AuthService({
            users: new PgUserRepo(db), codes: new PgCodeRepo(db), sessions: new PgSessionRepo(db), throttle: new PgThrottleRepo(db),
            outbox: new PgEmailOutbox(db), now,
            config: { ...DEFAULT_AUTH_CONFIG, codeSecret: cfg.codeSecret, tosVersion: cfg.tosVersion, privacyVersion: cfg.privacyVersion, adminTelegramLinks: cfg.adminTelegramLinks },
          }),
        },
        {
          provide: AdminAuthService, inject: [Db],
          useFactory: (db: Db) => new AdminAuthService({ admins: new PgAdminRepo(db), sessions: new PgAdminSessionRepo(db), throttle: new PgThrottleRepo(db), now }),
        },
        {
          provide: VerificationService, inject: [Db, LocalFsStorage],
          useFactory: (db: Db, storage: LocalFsStorage) => new VerificationService({
            repo: new PgVerificationRepo(db), storage, audit: new PgAuditWriter(db), notifier: new PgUserNotifier(db),
            config: DEFAULT_VERIFICATION_CONFIG, now,
          }),
        },
        { provide: QuizService, inject: [Db], useFactory: (db: Db) => new QuizService(db, now) },
        { provide: AdminQuizService, inject: [Db], useFactory: (db: Db) => new AdminQuizService(db, new PgAuditWriter(db)) },
        UserGuard, FullAccessGuard, AdminGuard,
      ],
    };
  }
}
