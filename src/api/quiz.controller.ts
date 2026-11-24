import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { QuizService } from '../quiz/quiz.service';
import { FullAccessGuard, AuthedRequest } from './guards';
import { posInt, str } from './input';

/** Faqat ACTIVE (hujjati tasdiqlangan) foydalanuvchilar. Yozuvchi amallar 01:00–11:00 da 503 READ_ONLY. */
@Controller('quiz')
@UseGuards(FullAccessGuard)
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  @Get('packs') packs(@Req() req: AuthedRequest) { return this.quiz.listPacks(req.auth!.user.id); }
  @Post('packs/:id/start') @HttpCode(200) start(@Param('id') id: string, @Req() req: AuthedRequest) { return this.quiz.start(req.auth!.user.id, posInt(id)); }
  @Get('attempts/:id') state(@Param('id') id: string, @Req() req: AuthedRequest) { return this.quiz.state(req.auth!.user.id, posInt(id)); }
  @Post('attempts/:id/answer') @HttpCode(200)
  answer(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthedRequest) { return this.quiz.answer(req.auth!.user.id, posInt(id), str(b, 'text', 500)); }
  @Post('attempts/:id/next') @HttpCode(200) next(@Param('id') id: string, @Req() req: AuthedRequest) { return this.quiz.next(req.auth!.user.id, posInt(id)); }
}
