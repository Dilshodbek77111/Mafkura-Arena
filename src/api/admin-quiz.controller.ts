import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminQuizService, parseQuestionInput, QuestionInput } from '../quiz/admin-quiz.service';
import { QuizError } from '../quiz/quiz.service';
import { AdminGuard, AuthedRequest } from './guards';
import { posInt, str } from './input';

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminQuizController {
  constructor(private readonly svc: AdminQuizService) {}

  @Get('questions') list(@Req() req: AuthedRequest) { return this.svc.listQuestions(req.admin!); }
  @Post('questions') @HttpCode(201)
  create(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest) { return this.svc.createQuestion(req.admin!, parseQuestionInput(b) as QuestionInput); }
  @Patch('questions/:id') @HttpCode(200)
  async update(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    const patch = { ...parseQuestionInput(b, true), ...(typeof b?.active === 'boolean' ? { active: b.active } : {}) };
    await this.svc.updateQuestion(req.admin!, posInt(id), patch);
    return { ok: true };
  }
  @Delete('questions/:id') @HttpCode(204) async remove(@Param('id') id: string, @Req() req: AuthedRequest) { await this.svc.deleteQuestion(req.admin!, posInt(id)); }

  @Get('packs') packs(@Req() req: AuthedRequest) { return this.svc.listPacks(req.admin!); }
  @Post('packs') @HttpCode(201)
  createPack(@Body() b: Record<string, unknown>, @Req() req: AuthedRequest) {
    const date = b?.packDate === undefined ? undefined : str(b, 'packDate', 10);
    if (date !== undefined && !isRealDate(date)) throw new QuizError('VALIDATION', { fields: { packDate: 'INVALID' } });
    const title = str(b, 'title', 200).trim();
    if (!title) throw new QuizError('VALIDATION', { fields: { title: 'INVALID' } });
    return this.svc.createPack(req.admin!, { title, packDate: date, questionIds: b?.questionIds as number[] });
  }
  @Post('packs/:id/publish') @HttpCode(200)
  async publish(@Param('id') id: string, @Req() req: AuthedRequest) { await this.svc.publishPack(req.admin!, posInt(id)); return { ok: true }; }
}
