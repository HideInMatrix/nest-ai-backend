import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { extname } from 'node:path';
import { AiService, type UploadedAiFile } from './ai.service';
import { GenerateTextDto } from './dto/generate-text.dto';

const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.pdf',
  '.csv',
  '.doc',
  '.docx',
  '.docm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.txt',
  '.md',
]);

const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'application/pdf',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'text/plain',
  'text/markdown',
]);

const uploadInterceptor = FilesInterceptor('files', MAX_FILES, {
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
  fileFilter: (_req, file, callback) => {
    const extension = extname(file.originalname || '').toLowerCase();
    const mimeType = file.mimetype?.trim().toLowerCase();
    const isSupported =
      SUPPORTED_UPLOAD_EXTENSIONS.has(extension) ||
      (Boolean(mimeType) &&
        (SUPPORTED_UPLOAD_MIME_TYPES.has(mimeType) ||
          mimeType.startsWith('image/')));

    if (isSupported) {
      callback(null, true);
      return;
    }

    callback(
      new BadRequestException(`Unsupported file type: ${file.originalname}`),
      false,
    );
  },
});

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('generate')
  @HttpCode(200)
  @UseInterceptors(uploadInterceptor)
  async generate(
    @Body() body: GenerateTextDto,
    @UploadedFiles() files: UploadedAiFile[] = [],
  ) {
    return this.aiService.generate(body, files);
  }

  @Post('stream')
  @HttpCode(200)
  @UseInterceptors(uploadInterceptor)
  async stream(
    @Body() body: GenerateTextDto,
    @UploadedFiles() files: UploadedAiFile[] = [],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abortController = new AbortController();
    req.on('close', () => {
      abortController.abort();
    });

    this.writeSseEvent(res, 'ready', {
      message: 'AI stream connected',
    });

    try {
      for await (const chunk of this.aiService.stream(
        body,
        files,
        abortController.signal,
      )) {
        this.writeSseEvent(res, chunk.event, chunk.data);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message =
          error instanceof Error ? error.message : 'AI stream failed';
        this.writeSseEvent(res, 'error', {
          message,
        });
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private writeSseEvent(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
