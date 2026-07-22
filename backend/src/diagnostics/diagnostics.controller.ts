import { Controller, Get, Param, Res, StreamableFile, NotFoundException, Query } from '@nestjs/common';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import type { Response } from 'express';

@Controller('diagnostics')
export class DiagnosticsController {
  private readonly dir = path.join(process.cwd(), 'logs', 'diagnostics');

  @Get()
  async listDiagnostics(@Query('prefix') prefix?: string) {
    try {
      const files = await fs.readdir(this.dir);
      const stats = await Promise.all(
        files
          .filter(file => !prefix || file.startsWith(prefix))
          .map(async (file) => {
            const stat = await fs.stat(path.join(this.dir, file));
            return {
              name: file,
              size: stat.size,
              createdAt: stat.birthtime,
            };
          }),
      );

      // Sort by newest first
      return stats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
  }

  @Get(':filename')
  async getDiagnosticFile(
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // Basic path traversal prevention
    const sanitizedFilename = path.basename(filename);
    const filePath = path.join(this.dir, sanitizedFilename);

    try {
      await fs.access(filePath);
    } catch (e) {
      throw new NotFoundException('File not found');
    }

    if (sanitizedFilename.endsWith('.png')) {
      res.set({ 'Content-Type': 'image/png' });
    } else if (sanitizedFilename.endsWith('.html')) {
      res.set({ 'Content-Type': 'text/html' });
    } else {
      res.set({ 'Content-Type': 'application/octet-stream' });
    }

    const file = createReadStream(filePath);
    return new StreamableFile(file);
  }
}
