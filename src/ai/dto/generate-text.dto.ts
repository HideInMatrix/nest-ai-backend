export class GenerateTextAttachmentDto {
  name?: string;
  filename?: string;
  title?: string;
  url?: string;
  fileId?: string;
  mimeType?: string;
  mediaType?: string;
  contentType?: string;
  data?: string;
  base64Data?: string;
}

export class GenerateTextDto {
  prompt!: string;
  system?: string;
  temperature?: number | string;
  maxOutputTokens?: number | string;
  maxTokens?: number | string;
  outputSchema?: string | Record<string, unknown>;
  outputMode?: string;
  stream?: boolean | string;
  attachments?: string | GenerateTextAttachmentDto[];
}
