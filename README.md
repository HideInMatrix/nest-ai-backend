# nest-ai-backend

一个基于 NestJS + LangChain + OpenAI 兼容模型接口的 AI 后端服务，提供同步生成与 SSE 流式生成能力，并支持文本、图片、PDF、Word、Excel、CSV 等附件输入。

## 功能特性

- 提供同步生成接口：`POST /ai/generate`
- 提供流式生成接口：`POST /ai/stream`（Server-Sent Events）
- 支持 `system`、`temperature`、`maxOutputTokens` 等常见模型参数
- 支持 `outputMode` 和 `outputSchema`，可让模型返回结构化 JSON
- 支持两种附件输入方式
  - `multipart/form-data` 上传文件
  - 请求体内通过 `attachments` 传入 `url` / `fileId` / Base64 数据
- 自动提取文档内容并拼接进提示词上下文
  - 文本类：`txt`、`md`、`csv`
  - 文档类：`pdf`、`doc`、`docx`、`docm`
  - 表格类：`xls`、`xlsx`、`xlsm`
- 图片类附件会作为多模态输入直接传给模型
- 默认开启 CORS

## 技术栈

- NestJS 11
- LangChain / LangGraph 生态包
- OpenAI 兼容聊天模型接口
- TypeScript

## 项目结构

```text
src/
  app.module.ts
  main.ts
  ai/
    ai.controller.ts
    ai.module.ts
    ai.service.ts
    dto/
      generate-text.dto.ts
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

按需修改 `.env`：

```env
# 可选，当前代码中未直接使用，作为网关场景预留
AI_GATEWAY_API_KEY=

# 可选，OpenAI 兼容接口地址，例如 https://api.openai.com/v1
AI_BASE_URL=

# 必填
AI_API_KEY=
AI_MODEL=

# 可选，默认 system prompt
AI_SYSTEM_PROMPT=

# 可选，服务端口，默认 3000
PORT=3000
```

### 3. 启动项目

开发模式：

```bash
pnpm start:dev
```

生产构建：

```bash
pnpm build
pnpm start:prod
```

服务默认启动在：

```text
http://localhost:3000
```

## 环境变量说明

| 变量名 | 是否必填 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 是 | 模型服务的 API Key |
| `AI_MODEL` | 是 | 使用的模型名称 |
| `AI_BASE_URL` | 否 | OpenAI 兼容接口地址；不填时走 SDK 默认地址 |
| `AI_SYSTEM_PROMPT` | 否 | 默认系统提示词，请求未传 `system` 时生效 |
| `PORT` | 否 | 服务监听端口，默认 `3000` |
| `AI_GATEWAY_API_KEY` | 否 | 预留字段，当前代码未直接读取 |

## 接口说明

### `POST /ai/generate`

同步调用模型并一次性返回结果。

支持两种请求方式：

- `application/json`
- `multipart/form-data`

#### 请求参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | `string` | 是 | 用户提示词 |
| `system` | `string` | 否 | 本次请求的 system prompt，会覆盖默认环境变量 |
| `temperature` | `number \| string` | 否 | 采样温度 |
| `maxOutputTokens` | `number \| string` | 否 | 最大输出 token 数 |
| `maxTokens` | `number \| string` | 否 | `maxOutputTokens` 的兼容字段 |
| `outputMode` | `string` | 否 | 可选值：`json`、`object`、`json_object` |
| `outputSchema` | `object \| string` | 否 | 结构化输出 schema，可传对象或 JSON 字符串 |
| `attachments` | `array \| object \| string` | 否 | 附件描述，支持对象、数组或 JSON 字符串 |
| `files` | `File[]` | 否 | 表单上传文件字段名，最多 10 个 |

#### 返回示例

```json
{
  "text": "你好，我可以帮你总结这份文档。",
  "object": null,
  "finishReason": "stop",
  "usage": {
    "input_tokens": 120,
    "output_tokens": 36,
    "total_tokens": 156
  },
  "responseMetadata": {
    "finish_reason": "stop"
  }
}
```

#### 基础调用示例

```bash
curl -X POST http://localhost:3000/ai/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "用一句话介绍 NestJS",
    "temperature": 0.3
  }'
```

#### 结构化输出示例

```bash
curl -X POST http://localhost:3000/ai/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "从下面文本中提取标题和摘要：NestJS is a progressive Node.js framework.",
    "outputSchema": {
      "name": "summary_response",
      "schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "summary": { "type": "string" }
        },
        "required": ["title", "summary"],
        "additionalProperties": false
      }
    }
  }'
```

返回中：

- `text` 是模型原始文本输出
- `object` 是后端解析后的 JSON 对象

#### 文件上传示例

```bash
curl -X POST http://localhost:3000/ai/generate \
  -F 'prompt=请总结上传文件的核心内容' \
  -F 'system=你是一个严谨的分析助手' \
  -F 'files=@./example.pdf' \
  -F 'files=@./report.xlsx'
```

#### 通过 `attachments` 传附件示例

```bash
curl -X POST http://localhost:3000/ai/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "请识别图片中的主要内容",
    "attachments": [
      {
        "filename": "demo.png",
        "mimeType": "image/png",
        "base64Data": "iVBORw0KGgoAAAANSUhEUgAA..."
      }
    ]
  }'
```

### `POST /ai/stream`

以 SSE 方式流式返回模型输出。

响应头：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

#### SSE 事件

| 事件名 | 说明 |
| --- | --- |
| `ready` | SSE 连接建立成功 |
| `token` | 普通文本流式输出片段 |
| `partial-object` | 结构化输出模式下的部分 JSON 解析结果 |
| `done` | 流结束，包含完整结果 |
| `error` | 流式过程中发生错误 |

#### 流式调用示例

```bash
curl -N -X POST http://localhost:3000/ai/stream \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "分三点介绍这个项目",
    "temperature": 0.2
  }'
```

返回格式类似：

```text
event: ready
data: {"message":"AI stream connected"}

event: token
data: {"text":"第一点，"}

event: token
data: {"text":"它基于 NestJS。"}

event: done
data: {"text":"第一点，它基于 NestJS。...","object":null,"finishReason":"stop","usage":null,"responseMetadata":{"finish_reason":"stop"}}
```

如果开启了 `outputSchema` 或 `outputMode`，流中通常会返回 `partial-object`，最终在 `done` 中拿到完整结构化结果。

## 附件支持说明

### 上传限制

- 单次最多上传 `10` 个文件
- 单个文件最大 `20MB`

### 支持的文件类型

- 图片：`jpg`、`jpeg`、`png`、`gif`、`webp`、`bmp`、`tif`、`tiff`
- 文档：`pdf`、`doc`、`docx`、`docm`
- 表格：`csv`、`xls`、`xlsx`、`xlsm`
- 文本：`txt`、`md`

### 后端处理规则

- 图片附件：直接作为多模态内容发送给模型
- 文本/文档/表格附件：优先提取文本内容，并作为上下文拼接到用户提示词中
- 提取出的文本超过 `40,000` 字符时，后端会自动截断

### `attachments` 字段支持格式

每个附件对象支持以下字段中的一部分：

| 字段 | 说明 |
| --- | --- |
| `filename` / `name` / `title` | 文件名 |
| `mimeType` / `mediaType` / `contentType` | MIME 类型 |
| `url` | 远程文件地址 |
| `fileId` | 已上传文件的标识 |
| `data` | 文件内容，文本或 Base64 |
| `base64Data` | Base64 文件内容 |

说明：

- `multipart/form-data` 下，`attachments` 和 `outputSchema` 建议传 JSON 字符串
- `data` 如果是 `data:*;base64,...` 格式，后端会自动解码
- 文本 MIME 类型会按 UTF-8 读取，其余二进制内容按 Base64 处理

## NPM Scripts

```bash
pnpm start
pnpm start:dev
pnpm start:debug
pnpm build
pnpm start:prod
pnpm lint
pnpm test
pnpm test:e2e
```

## 开发说明

- 当前项目核心逻辑集中在 `src/ai/ai.service.ts` 与 `src/ai/ai.controller.ts`
- 项目已启用全局环境变量模块：`@nestjs/config`
- 当前通过 `src/main.ts` 开启了宽松 CORS 配置：`origin: true`、`credentials: true`

## License

MIT
