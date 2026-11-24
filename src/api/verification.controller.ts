import { Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { VerificationError, VerificationService } from '../verification/verification.service';
import { CONFIG, AppConfig } from '../config';
import { RateLimiter } from '../http/rate-limiter';
import { AuthedRequest, UserGuard } from './guards';

@Controller('verification')
@UseGuards(UserGuard)
export class VerificationController {
  constructor(private readonly ver: VerificationService, private readonly limiter: RateLimiter, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Get('status')
  async status(@Req() req: AuthedRequest) {
    const s = await this.ver.status(req.auth!.user.id);
    return { ...s, ...(req.auth!.user.status === 'BLOCKED' ? { adminTelegramLinks: this.cfg.adminTelegramLinks } : {}) };
  }

  /** Xom fayl tanasi (Content-Type: image/jpeg | image/png | image/webp | application/pdf), maks 5 MB. */
  @Post('documents') @HttpCode(201)
  async upload(@Req() req: AuthedRequest) {
    await this.limiter.hit(`upload:${req.auth!.user.id}`, this.cfg.rateLimits.upload);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new VerificationError('FILE_TYPE_INVALID');
    const declaredMime = (req.headers['content-type'] ?? '').split(';')[0].trim();
    return this.ver.submit(req.auth!.user.id, { data: new Uint8Array(req.body), declaredMime });
  }
}
