import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import {
  AIMessageChunk,
  ContentBlock,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import {
  parseJsonMarkdown,
  parsePartialJson,
} from '@langchain/core/output_parsers';
import { concat } from '@langchain/core/utils/stream';
import { ChatOpenAI, type ChatOpenAICallOptions } from '@langchain/openai';
import { extname } from 'node:path';
import * as XLSX from 'xlsx';
import {
  GenerateTextAttachmentDto,
  GenerateTextDto,
} from './dto/generate-text.dto';

export interface UploadedAiFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

interface ParsedOutputSchema {
  name: string;
  description?: string;
  strict?: boolean;
  schema?: Record<string, unknown>;
  jsonObjectMode?: boolean;
}

interface PreparedInvocation {
  model: ChatOpenAI;
  messages: BaseMessage[];
  options: ChatOpenAICallOptions;
  structuredOutput: boolean;
}

interface NormalizedAttachmentSource {
  filename: string;
  mimeType: string;
  buffer?: Buffer;
  url?: string;
  fileId?: string;
}

export interface GenerateAiResponse {
  text: string;
  object: unknown;
  finishReason: string | null;
  usage: UsageMetadata | null;
  responseMetadata: Record<string, unknown> | null;
}

export type AiStreamEvent =
  | {
      event: 'token';
      data: { text: string };
    }
  | {
      event: 'partial-object';
      data: { object: unknown };
    }
  | {
      event: 'done';
      data: GenerateAiResponse;
    };

const EXTENSION_MIME_TYPES = new Map<string, string>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.pdf', 'application/pdf'],
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  [
    '.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['.docm', 'application/vnd.ms-word.document.macroEnabled.12'],
  ['.xls', 'application/vnd.ms-excel'],
  [
    '.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
]);

const SUPPORTED_MIME_TYPES = new Set<string>(EXTENSION_MIME_TYPES.values());
const MAX_EXTRACTED_TEXT_CHARS = 40_000;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly configService: ConfigService) {}

  async generate(
    dto: GenerateTextDto,
    files: UploadedAiFile[] = [],
  ): Promise<GenerateAiResponse> {
    try {
      const { model, messages, options, structuredOutput } =
        await this.prepareInvocation(dto, files);
      const message = await model.invoke(messages, options);
      const text = message.text ?? '';

      return {
        text,
        object: structuredOutput ? this.parseStructuredOutput(text) : null,
        finishReason: this.extractFinishReason(message.response_metadata),
        usage: message.usage_metadata ?? null,
        responseMetadata: this.normalizeRecord(message.response_metadata),
      };
    } catch (error) {
      throw this.normalizeError(error, 'AI request failed');
    }
  }

  async *stream(
    dto: GenerateTextDto,
    files: UploadedAiFile[] = [],
    signal?: AbortSignal,
  ): AsyncGenerator<AiStreamEvent, void, unknown> {
    const { model, messages, options, structuredOutput } =
      await this.prepareInvocation(dto, files);

    try {
      const stream = await model.stream(messages, {
        ...options,
        signal,
      });

      let fullMessage: AIMessageChunk | undefined;
      let aggregatedText = '';
      let lastPartialSnapshot: string | null = null;

      for await (const chunk of stream) {
        fullMessage = fullMessage ? concat(fullMessage, chunk) : chunk;

        const delta = chunk.text ?? '';
        if (!delta) {
          continue;
        }

        aggregatedText += delta;

        if (!structuredOutput) {
          yield {
            event: 'token',
            data: { text: delta },
          };
          continue;
        }

        const partialObject: unknown = parsePartialJson(aggregatedText);
        if (partialObject === null) {
          continue;
        }

        const nextSnapshot = this.safeStringify(partialObject);
        if (nextSnapshot === lastPartialSnapshot) {
          continue;
        }

        lastPartialSnapshot = nextSnapshot;
        yield {
          event: 'partial-object',
          data: { object: partialObject },
        };
      }

      const finalText = fullMessage?.text ?? aggregatedText;
      yield {
        event: 'done',
        data: {
          text: finalText,
          object: structuredOutput
            ? this.parseStructuredOutput(finalText, true)
            : null,
          finishReason: this.extractFinishReason(
            fullMessage?.response_metadata,
          ),
          usage: fullMessage?.usage_metadata ?? null,
          responseMetadata: this.normalizeRecord(
            fullMessage?.response_metadata,
          ),
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        return;
      }

      throw this.normalizeError(error, 'Failed to start AI stream');
    }
  }

  private async prepareInvocation(
    dto: GenerateTextDto,
    files: UploadedAiFile[],
  ): Promise<PreparedInvocation> {
    const prompt = dto.prompt?.trim();
    if (!prompt) {
      throw new BadRequestException('prompt is required');
    }

    const messages = await this.buildMessages(dto, files, prompt);
    const outputSchema = this.parseOutputSchema(
      dto.outputSchema,
      dto.outputMode,
    );
    const options: ChatOpenAICallOptions = {};
    const temperature = this.parseOptionalNumber(dto.temperature);
    const maxTokens =
      this.parseOptionalInt(dto.maxOutputTokens) ??
      this.parseOptionalInt(dto.maxTokens);

    if (outputSchema?.schema) {
      options.response_format = {
        type: 'json_schema',
        json_schema: {
          name: outputSchema.name,
          description: outputSchema.description,
          strict: outputSchema.strict ?? true,
          schema: outputSchema.schema,
        },
      };
    } else if (outputSchema?.jsonObjectMode) {
      options.response_format = {
        type: 'json_object',
      };
    }

    return {
      model: this.createModel({
        temperature,
        maxTokens,
      }),
      messages,
      options,
      structuredOutput: Boolean(options.response_format),
    };
  }

  private createModel({
    temperature,
    maxTokens,
  }: {
    temperature?: number;
    maxTokens?: number;
  }): ChatOpenAI {
    const model = this.configService.get<string>('AI_MODEL');
    const apiKey = this.configService.get<string>('AI_API_KEY');
    const baseURL = this.configService.get<string>('AI_BASE_URL');

    if (!model || !apiKey) {
      throw new InternalServerErrorException(
        'Missing AI_MODEL or AI_API_KEY environment configuration',
      );
    }

    return new ChatOpenAI({
      model,
      apiKey,
      temperature,
      maxTokens,
      useResponsesApi: false,
      configuration: baseURL
        ? {
            baseURL,
          }
        : undefined,
    });
  }

  private async buildMessages(
    dto: GenerateTextDto,
    files: UploadedAiFile[],
    prompt: string,
  ): Promise<BaseMessage[]> {
    const messages: BaseMessage[] = [];
    const systemPrompt =
      dto.system?.trim() || this.configService.get<string>('AI_SYSTEM_PROMPT');

    if (systemPrompt?.trim()) {
      messages.push(new SystemMessage(systemPrompt.trim()));
    }

    const contentBlocks = await this.buildHumanContent(
      prompt,
      files,
      dto.attachments,
    );

    if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
      messages.push(new HumanMessage(prompt));
    } else {
      messages.push(
        new HumanMessage({
          content: contentBlocks,
        }),
      );
    }

    return messages;
  }

  private async buildHumanContent(
    prompt: string,
    files: UploadedAiFile[],
    attachmentsInput?: string | GenerateTextAttachmentDto[],
  ): Promise<ContentBlock.Standard[]> {
    const content: ContentBlock.Standard[] = [
      {
        type: 'text',
        text: prompt,
      },
    ];

    for (const file of files) {
      const mimeType = this.normalizeMimeType(file.originalname, file.mimetype);
      const filename =
        file.originalname || `upload${this.extensionFromMime(mimeType)}`;

      content.push(
        ...(await this.createContentBlocksFromSource({
          filename,
          mimeType,
          buffer: file.buffer,
        })),
      );
    }

    for (const attachment of this.parseAttachments(attachmentsInput)) {
      const attachmentBlocks = await this.createAttachmentBlocks(attachment);
      content.push(...attachmentBlocks);
    }

    return content;
  }

  private async createAttachmentBlocks(
    attachment: GenerateTextAttachmentDto,
  ): Promise<ContentBlock.Standard[]> {
    if (!this.hasAttachmentPayload(attachment)) {
      return [];
    }

    const filename =
      attachment.filename ||
      attachment.name ||
      attachment.title ||
      'attachment';
    const providedMimeType =
      attachment.mimeType || attachment.mediaType || attachment.contentType;
    const mimeType = this.normalizeMimeType(filename, providedMimeType);
    const buffer = this.extractAttachmentData(attachment, mimeType);

    return this.createContentBlocksFromSource({
      filename,
      mimeType,
      buffer,
      url: attachment.url,
      fileId: attachment.fileId,
    });
  }

  private hasAttachmentPayload(attachment: GenerateTextAttachmentDto): boolean {
    return Boolean(
      attachment.url ||
      attachment.fileId ||
      attachment.data ||
      attachment.base64Data,
    );
  }

  private async createContentBlocksFromSource(
    source: NormalizedAttachmentSource,
  ): Promise<ContentBlock.Standard[]> {
    if (source.buffer) {
      const extractedText = await this.extractFileText(source);
      if (extractedText) {
        return [
          {
            type: 'text',
            text: this.buildExtractedFilePrompt(
              source.filename,
              source.mimeType,
              extractedText,
            ),
          },
        ];
      }
    }

    return [
      this.createMultimodalBlock({
        filename: source.filename,
        mimeType: source.mimeType,
        data: source.buffer,
        url: source.url,
        fileId: source.fileId,
      }),
    ];
  }

  private buildExtractedFilePrompt(
    filename: string,
    mimeType: string,
    extractedText: string,
  ): string {
    return [
      `Attached file: ${filename}`,
      `MIME type: ${mimeType}`,
      'Use the following extracted file content as part of the user context:',
      extractedText,
    ].join('\n');
  }

  private async extractFileText(
    source: NormalizedAttachmentSource,
  ): Promise<string | null> {
    if (!source.buffer || source.mimeType.startsWith('image/')) {
      return null;
    }

    try {
      const rawText = await this.loadFileText(source);
      if (!rawText?.trim()) {
        return null;
      }

      return this.truncateExtractedText(rawText);
    } catch (error) {
      this.logger.warn(
        error instanceof Error
          ? `Failed to extract text from ${source.filename}: ${error.message}`
          : `Failed to extract text from ${source.filename}`,
      );
      return null;
    }
  }

  private async loadFileText(
    source: NormalizedAttachmentSource,
  ): Promise<string | null> {
    if (!source.buffer) {
      return null;
    }

    if (
      source.mimeType === 'text/plain' ||
      source.mimeType === 'text/markdown'
    ) {
      return source.buffer.toString('utf8');
    }

    if (source.mimeType === 'text/csv') {
      const loader = new CSVLoader(this.toBlob(source.buffer, source.mimeType));
      const docs = await loader.load();
      return docs.map((doc) => doc.pageContent).join('\n\n');
    }

    if (source.mimeType === 'application/pdf') {
      const loader = new PDFLoader(
        this.toBlob(source.buffer, source.mimeType),
        {
          splitPages: false,
        },
      );
      const docs = await loader.load();
      return docs.map((doc) => doc.pageContent).join('\n\n');
    }

    if (this.isWordMimeType(source.mimeType)) {
      const loader = new DocxLoader(
        this.toBlob(source.buffer, source.mimeType),
        {
          type: this.resolveWordLoaderType(source.filename),
        },
      );
      const docs = await loader.load();
      return docs.map((doc) => doc.pageContent).join('\n\n');
    }

    if (this.isExcelMimeType(source.mimeType)) {
      return this.extractWorkbookText(source.buffer);
    }

    return null;
  }

  private extractWorkbookText(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sections = workbook.SheetNames.map((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils
        .sheet_to_csv(worksheet, { blankrows: false })
        .trim();
      return csv ? `Sheet: ${sheetName}\n${csv}` : '';
    }).filter(Boolean);

    return sections.join('\n\n');
  }

  private truncateExtractedText(text: string): string {
    if (text.length <= MAX_EXTRACTED_TEXT_CHARS) {
      return text;
    }

    return `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[Content truncated by backend for model input size limits.]`;
  }

  private isWordMimeType(mimeType: string): boolean {
    return (
      mimeType === 'application/msword' ||
      mimeType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/vnd.ms-word.document.macroEnabled.12'
    );
  }

  private isExcelMimeType(mimeType: string): boolean {
    return (
      mimeType === 'application/vnd.ms-excel' ||
      mimeType ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel.sheet.macroEnabled.12'
    );
  }

  private resolveWordLoaderType(filename: string): 'doc' | 'docx' {
    return extname(filename).toLowerCase() === '.doc' ? 'doc' : 'docx';
  }

  private toBlob(buffer: Buffer, mimeType: string): Blob {
    return new Blob([new Uint8Array(buffer)], {
      type: mimeType,
    });
  }

  private createMultimodalBlock({
    filename,
    mimeType,
    data,
    url,
    fileId,
  }: {
    filename: string;
    mimeType: string;
    data?: Buffer | string;
    url?: string;
    fileId?: string;
  }): ContentBlock.Standard {
    const metadata = {
      filename,
      name: filename,
      title: filename,
    };

    if (mimeType.startsWith('image/')) {
      if (data) {
        return {
          type: 'image',
          data,
          mimeType,
          metadata,
        };
      }

      if (url) {
        return {
          type: 'image',
          url,
          mimeType,
          metadata,
        };
      }
    }

    if (data) {
      return {
        type: 'file',
        data,
        mimeType,
        metadata,
      };
    }

    if (url) {
      return {
        type: 'file',
        url,
        mimeType,
        metadata,
      };
    }

    return {
      type: 'file',
      fileId: fileId!,
      mimeType,
      metadata,
    };
  }

  private parseAttachments(
    attachmentsInput?: string | GenerateTextAttachmentDto[],
  ): GenerateTextAttachmentDto[] {
    if (!attachmentsInput) {
      return [];
    }

    if (Array.isArray(attachmentsInput)) {
      return attachmentsInput;
    }

    try {
      const parsed = JSON.parse(attachmentsInput) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as GenerateTextAttachmentDto[];
      }

      if (this.isRecord(parsed)) {
        return [parsed as GenerateTextAttachmentDto];
      }

      throw new Error('attachments must be a JSON array or object');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? `attachments parse failed: ${error.message}`
          : 'attachments parse failed',
      );
    }
  }

  private parseOutputSchema(
    outputSchemaInput?: string | Record<string, unknown>,
    outputMode?: string,
  ): ParsedOutputSchema | null {
    const normalizedMode = outputMode?.trim().toLowerCase();

    if (!outputSchemaInput) {
      if (
        normalizedMode === 'json' ||
        normalizedMode === 'object' ||
        normalizedMode === 'json_object'
      ) {
        return {
          name: 'response',
          jsonObjectMode: true,
        };
      }

      return null;
    }

    const parsed =
      typeof outputSchemaInput === 'string'
        ? this.parseJsonObject(outputSchemaInput, 'outputSchema')
        : outputSchemaInput;

    if (!this.isRecord(parsed)) {
      throw new BadRequestException('outputSchema must be a JSON object');
    }

    if (this.isRecord(parsed.schema)) {
      return {
        name:
          typeof parsed.name === 'string' && parsed.name.trim()
            ? parsed.name.trim()
            : 'response',
        description:
          typeof parsed.description === 'string'
            ? parsed.description
            : undefined,
        strict: typeof parsed.strict === 'boolean' ? parsed.strict : true,
        schema: parsed.schema,
      };
    }

    return {
      name: 'response',
      strict: true,
      schema: parsed,
    };
  }

  private parseStructuredOutput(text: string, swallowErrors = false): unknown {
    if (!text.trim()) {
      return null;
    }

    try {
      return parseJsonMarkdown(text, parsePartialJson);
    } catch (error) {
      if (swallowErrors) {
        this.logger.warn(
          error instanceof Error
            ? `Failed to parse structured output: ${error.message}`
            : 'Failed to parse structured output',
        );
        return null;
      }

      throw new BadRequestException('Model did not return valid JSON output');
    }
  }

  private parseJsonObject(
    value: string,
    fieldName: string,
  ): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!this.isRecord(parsed)) {
        throw new Error(`${fieldName} must be a JSON object`);
      }
      return parsed;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? `${fieldName} parse failed: ${error.message}`
          : `${fieldName} parse failed`,
      );
    }
  }

  private extractAttachmentData(
    attachment: GenerateTextAttachmentDto,
    mimeType: string,
  ): Buffer | undefined {
    if (attachment.base64Data) {
      return this.decodeBase64Payload(attachment.base64Data);
    }

    if (!attachment.data) {
      return undefined;
    }

    if (/^data:[^;]+;base64,/.test(attachment.data)) {
      return this.decodeBase64Payload(attachment.data);
    }

    if (mimeType.startsWith('text/')) {
      return Buffer.from(attachment.data, 'utf8');
    }

    return Buffer.from(attachment.data, 'base64');
  }

  private decodeBase64Payload(value: string): Buffer {
    const [, base64Payload] = value.match(/^data:[^;]+;base64,(.+)$/) ?? [];
    return Buffer.from(base64Payload || value, 'base64');
  }

  private normalizeMimeType(
    filename: string,
    providedMimeType?: string,
  ): string {
    const extension = extname(filename || '').toLowerCase();
    const extensionMimeType = EXTENSION_MIME_TYPES.get(extension);
    const normalizedProvidedMimeType = providedMimeType?.trim().toLowerCase();

    if (
      normalizedProvidedMimeType &&
      normalizedProvidedMimeType !== 'application/octet-stream' &&
      this.isSupportedMimeType(normalizedProvidedMimeType)
    ) {
      return normalizedProvidedMimeType;
    }

    if (extensionMimeType) {
      return extensionMimeType;
    }

    if (
      normalizedProvidedMimeType &&
      this.isSupportedMimeType(normalizedProvidedMimeType)
    ) {
      return normalizedProvidedMimeType;
    }

    throw new BadRequestException(
      `Unsupported file type: ${filename || providedMimeType || 'unknown file'}`,
    );
  }

  private isSupportedMimeType(mimeType: string): boolean {
    if (SUPPORTED_MIME_TYPES.has(mimeType)) {
      return true;
    }

    return mimeType.startsWith('image/');
  }

  private extensionFromMime(mimeType: string): string {
    for (const [
      extension,
      candidateMimeType,
    ] of EXTENSION_MIME_TYPES.entries()) {
      if (candidateMimeType === mimeType) {
        return extension;
      }
    }

    return '';
  }

  private extractFinishReason(
    responseMetadata?: Record<string, unknown>,
  ): string | null {
    const finishReason = responseMetadata?.finish_reason;
    if (typeof finishReason === 'string') {
      return finishReason;
    }

    const status = responseMetadata?.status;
    if (typeof status === 'string') {
      return status;
    }

    return null;
  }

  private parseOptionalNumber(value?: number | string): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed =
      typeof value === 'number' ? value : Number.parseFloat(value.trim());
    if (Number.isNaN(parsed)) {
      throw new BadRequestException(`Invalid numeric value: ${value}`);
    }

    return parsed;
  }

  private parseOptionalInt(value?: number | string): number | undefined {
    const parsed = this.parseOptionalNumber(value);
    if (parsed === undefined) {
      return undefined;
    }

    return Math.trunc(parsed);
  }

  private normalizeRecord(
    value?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    return value ? value : null;
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private normalizeError(
    error: unknown,
    fallbackMessage: string,
  ): BadRequestException | InternalServerErrorException {
    if (error instanceof BadRequestException) {
      return error;
    }

    const message =
      error instanceof Error && error.message ? error.message : fallbackMessage;
    this.logger.error(
      message,
      error instanceof Error ? error.stack : undefined,
    );

    return new InternalServerErrorException(message);
  }
}
