import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { CONFIG, AppConfig } from '../config';
import { RateLimiter } from '../http/rate-limiter';
import { cookie } from '../http/security';
import { AuthedRequest, UserGuard } from './guards';
import { str } from './input';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly limiter: RateLimiter, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  /** Mijoz birinchi navbatda shuni chaqiradi: csrf cookie olinadi va token qaytariladi. */
  @Get('csrf')
  csrf(@Req() req: AuthedRequest & { csrfToken?: string }) { return { csrfToken: req.csrfToken }; }

  @Post('auth/register') @HttpCode(201)
  async register(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    await this.limiter.hit(`register:${req.ip}`, this.cfg.rateLimits.register);
    await this.auth.register({
      firstName: str(b, 'firstName', 100), lastName: str(b, 'lastName', 100), email: str(b, 'email', 254), phone: str(b, 'phone', 30),
      password: str(b, 'password', 200), birthDate: str(b, 'birthDate', 10), acceptTos: b?.acceptTos === true, acceptPrivacy: b?.acceptPrivacy === true,
    });
    return { ok: true };
  }

  @Post('auth/verify-email') @HttpCode(200)
  async verifyEmail(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    await this.limiter.hit(`verify:${req.ip}`, this.cfg.rateLimits.verifyEmail);
    await this.auth.verifyEmail(str(b, 'email', 254), str(b, 'code', 10));
    return { ok: true };
  }

  @Post('auth/resend-code') @HttpCode(202)
  async resend(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    const email = str(b, 'email', 254).trim().toLowerCase();
    await this.limiter.hit(`resend:${req.ip}`, this.cfg.rateLimits.resendCode);
    await this.limiter.hit(`resend:${email}`, this.cfg.rateLimits.resendCode);
    await this.auth.resendEmailCode(email);
    return { ok: true }; // mavjudlik oshkor bo'lmaydi
  }

  @Post('auth/login') @HttpCode(200)
  async login(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(str(b, 'email', 254), str(b, 'password', 200), { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.append('Set-Cookie', cookie('sid', r.token, { httpOnly: true, secure: this.cfg.secureCookies, maxAgeSec: Math.floor((r.expiresAt.getTime() - Date.now()) / 1000) }));
    const { user, access } = await this.auth.authenticate(r.token);
    return { access, user: { publicId: user.publicId, firstName: user.firstName, lastName: user.lastName, status: user.status } };
  }

  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid) await this.auth.logout(decodeURIComponent(sid));
    res.append('Set-Cookie', cookie('sid', '', { httpOnly: true, secure: this.cfg.secureCookies, maxAgeSec: 0 }));
  }

  @Get('auth/me') @UseGuards(UserGuard)
  me(@Req() req: AuthedRequest) {
    const { user, access } = req.auth!;
    return { access, user: { publicId: user.publicId, firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone, status: user.status },
      ...(access === 'VERIFICATION_ONLY' ? {} : {}) };
  }
}
