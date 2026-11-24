import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AuthError } from '../auth/auth.service';
import { ReadOnlyError } from '../domain/maintenance';
import { ForbiddenError } from '../rbac/rbac';
import { QuizError } from '../quiz/quiz.service';
import { VerificationError } from '../verification/verification.service';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}

const STATUS: Record<string, number> = {
  VALIDATION: 400, INVALID_CODE: 400, CODE_EXPIRED: 400, REASON_REQUIRED: 400,
  INVALID_CREDENTIALS: 401, UNAUTHENTICATED: 401,
  EMAIL_NOT_VERIFIED: 403, ACCOUNT_BLOCKED: 403, NOT_ALLOWED_STATE: 403, NO_ATTEMPTS_LEFT: 403,
  ATTEMPT_NOT_FOUND: 404, DOCUMENT_NOT_FOUND: 404, USER_NOT_FOUND: 404,
  EMAIL_TAKEN: 409, PHONE_TAKEN: 409, PENDING_EXISTS: 409, ALREADY_DECIDED: 409, NOT_BLOCKED: 409,
  PACK_NOT_FOUND: 404, QUESTION_NOT_FOUND: 404, NO_OPEN_QUESTION: 409, QUESTION_OPEN: 409, PACK_PUBLISHED: 409, PACK_INVALID: 400,
  FILE_TOO_LARGE: 413, FILE_TYPE_INVALID: 415, TOO_MANY_ATTEMPTS: 429,
};

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500, code = 'INTERNAL', details: Record<string, unknown> | undefined;

    if (e instanceof ApiError) { status = e.status; code = e.code; details = e.details; }
    else if (e instanceof AuthError || e instanceof VerificationError || e instanceof QuizError) {
      code = e.code; status = STATUS[code] ?? 400; details = e instanceof VerificationError ? undefined : e.details;
    } else if (e instanceof ForbiddenError) { status = 403; code = 'FORBIDDEN'; }
    else if (e instanceof ReadOnlyError) { status = 503; code = 'READ_ONLY'; details = { reopensAt: e.reopensAt.toISOString() }; }
    else if (e instanceof HttpException) { status = e.getStatus(); code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : status === 413 ? 'FILE_TOO_LARGE' : 'HTTP_ERROR'; }
    else if ((e as { type?: string })?.type === 'entity.too.large') { status = 413; code = 'FILE_TOO_LARGE'; }
    else if ((e as { type?: string })?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; }
    else this.log.error(e instanceof Error ? e.stack ?? e.message : String(e)); // ichki xato tafsilotlari mijozga chiqmaydi

    if (status === 429 && typeof details?.retryAfterSec === 'number') res.setHeader('Retry-After', String(details.retryAfterSec));
    res.status(status).json({ error: { code, ...(details ? { details } : {}) } });
  }
}
