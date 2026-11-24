import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminAuthService } from '../auth/admin-auth.service';
import { VerificationService } from '../verification/verification.service';
import { CONFIG, AppConfig } from '../config';
import { cookie, parseCookies } from '../http/security';
import { AdminGuard, AuthedRequest } from './guards';
import { optStr, posInt, str } from './input';
import { AuthError } from '../auth/auth.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admins: AdminAuthService, private readonly ver: VerificationService, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Post('auth/login') @HttpCode(200)
  async login(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const r = await this.admins.login(str(b, 'email', 254), str(b, 'password', 200), { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.append('Set-Cookie', cookie('asid', r.token, { httpOnly: true, secure: this.cfg.secureCookies, maxAgeSec: Math.floor((r.expiresAt.getTime() - Date.now()) / 1000) }));
    return { admin: await this.admins.authenticate(r.token) };
  }

  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const t = parseCookies(req.headers.cookie).asid;
    if (t) await this.admins.logout(t);
    res.append('Set-Cookie', cookie('asid', '', { httpOnly: true, secure: this.cfg.secureCookies, maxAgeSec: 0 }));
  }

  @Get('auth/me') @UseGuards(AdminGuard)
  me(@Req() req: AuthedRequest) { return { admin: req.admin }; }

  @Get('verifications/pending') @UseGuards(AdminGuard)
  pending(@Req() req: AuthedRequest) { return this.ver.listPending(req.admin!); }

  @Post('verifications/:id/review') @HttpCode(200) @UseGuards(AdminGuard)
  async review(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    if (typeof b?.approve !== 'boolean') throw new AuthError('VALIDATION', { fields: { approve: 'INVALID' } });
    return this.ver.review(req.admin!, posInt(id), b.approve ? { approve: true } : { approve: false, reason: optStr(b, 'reason', 1000) ?? '' });
  }

  @Get('documents/:id/url') @UseGuards(AdminGuard)
  async documentUrl(@Param('id') id: string, @Req() req: AuthedRequest) { return { url: await this.ver.viewDocument(req.admin!, posInt(id)) }; }

  @Post('users/:id/extra-attempt') @HttpCode(200) @UseGuards(AdminGuard)
  async extraAttempt(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    await this.ver.grantExtraAttempt(req.admin!, posInt(id), str(b, 'reason', 1000));
    return { ok: true };
  }
}
