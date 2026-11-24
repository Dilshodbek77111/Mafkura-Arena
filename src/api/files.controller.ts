import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sniffMime } from '../verification/file-type';
import { LocalFsStorage } from '../storage/local-fs-storage';
import { ApiError } from '../http/errors';

@Controller('files')
export class FilesController {
  constructor(private readonly storage: LocalFsStorage) {}

  /** Imzolangan qisqa muddatli havola. Imzo yoki muddat noto'g'ri bo'lsa — 403 (fayl mavjudligi oshkor bo'lmaydi). */
  @Get('doc')
  async doc(@Query('k') k: string, @Query('e') e: string, @Query('s') s: string, @Res() res: Response) {
    const data = await this.storage.readSigned(String(k ?? ''), Number(e), String(s ?? ''));
    if (!data) throw new ApiError(403, 'LINK_INVALID');
    res.setHeader('Content-Type', sniffMime(data) ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.send(data);
  }
}
