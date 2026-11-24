import { Controller, Get } from '@nestjs/common';
import { isActiveWindow } from '../domain/time';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    const now = new Date();
    return { status: 'ok', time: now.toISOString(), mode: isActiveWindow(now) ? 'active' : 'read-only' };
  }
}
