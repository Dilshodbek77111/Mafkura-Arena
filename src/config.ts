
export const CONFIG = Symbol('CONFIG');

export interface RateRule {
  limit: number;
  windowSec: number;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  codeSecret: string;
  fileUrlSecret: string;
  storageDir: string;
  publicBaseUrl: string;
  corsOrigins: string[];
  adminTelegramLinks: string[];
  secureCookies: boolean;
  trustProxy: boolean;
  tosVersion: string;
  privacyVersion: string;
  smtp: SmtpConfig | null;
  rateLimits: {
    register: RateRule;
    verifyEmail: RateRule;
    resendCode: RateRule;
    upload: RateRule;
  };
}

const need = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];

  if (!v) {
    throw new Error(`Missing required env var ${k}`);
  }

  return v;
};

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const prod = env.NODE_ENV === 'production';

  const codeSecret = need(env, 'CODE_SECRET');
  const fileUrlSecret = need(env, 'FILE_URL_SECRET');

  if (codeSecret.length < 32 || fileUrlSecret.length < 32) {
    throw new Error(
      'CODE_SECRET and FILE_URL_SECRET must be at least 32 characters',
    );
  }

  const smtpValues = [
    env.SMTP_HOST,
    env.SMTP_USER,
    env.SMTP_PASS,
    env.EMAIL_FROM,
  ];

  const hasAnySmtp = smtpValues.some((value) => Boolean(value));
  const hasAllSmtp = smtpValues.every((value) => Boolean(value));

  if (prod && !hasAllSmtp) {
    throw new Error('SMTP configuration is required in production');
  }

  if (hasAnySmtp && !hasAllSmtp) {
    throw new Error('SMTP configuration is incomplete');
  }

  const smtpPort = Number(env.SMTP_PORT ?? 587);

  if (
    !Number.isInteger(smtpPort) ||
    smtpPort < 1 ||
    smtpPort > 65535
  ) {
    throw new Error('SMTP_PORT must be a valid port');
  }

  const smtp: SmtpConfig | null = hasAllSmtp
    ? {
        host: env.SMTP_HOST!,
        port: smtpPort,
        secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER!,
        pass: env.SMTP_PASS!,
        from: env.EMAIL_FROM!,
      }
    : null;

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3001),
    databaseUrl: need(env, 'DATABASE_URL'),
    codeSecret,
    fileUrlSecret,
    storageDir: need(env, 'STORAGE_DIR'),
    publicBaseUrl: (
      env.API_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3001}`
    ).replace(/\/$/, ''),
    corsOrigins: list(env.CORS_ORIGIN),
    adminTelegramLinks: list(env.ADMIN_TELEGRAM_LINKS),
    secureCookies: prod,
    trustProxy: env.TRUST_PROXY === 'true',
    tosVersion: env.TOS_VERSION ?? 'tos-1',
    privacyVersion: env.PRIVACY_VERSION ?? 'privacy-1',
    smtp,
    rateLimits: {
      register: { limit: 10, windowSec: 3600 },
      verifyEmail: { limit: 20, windowSec: 900 },
      resendCode: { limit: 3, windowSec: 900 },
      upload: { limit: 10, windowSec: 3600 },
    },
  };
}
