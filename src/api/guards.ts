import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService, AdminPrincipal } from '../auth/admin-auth.service';
import { AccessLevel, AuthError, AuthService } from '../auth/auth.service';
import { UserRecord } from '../auth/ports';
import { parseCookies } from '../http/security';

export interface AuthedRequest extends Request {
  auth?: { user: UserRecord; access: AccessLevel };
  admin?: AdminPrincipal;
}

/** Oddiy foydalanuvchi sessiyasi (httpOnly `sid` cookie). Bloklanganlar AuthService.authenticate da rad etiladi. */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) throw new AuthError('UNAUTHENTICATED');
    req.auth = await this.auth.authenticate(token);
    return true;
  }
}

/** Faqat to'liq huquqli (ACTIVE) foydalanuvchilar — Phase 3+ viktorina endpointlari uchun. */
@Injectable()
export class FullAccessGuard extends UserGuard {
  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.auth!.access !== 'FULL') throw new AuthError('ACCOUNT_BLOCKED', { reason: 'VERIFICATION_REQUIRED' });
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly admins: AdminAuthService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = parseCookies(req.headers.cookie).asid;
    if (!token) throw new AuthError('UNAUTHENTICATED');
    req.admin = await this.admins.authenticate(token);
    return true;
  }
}
