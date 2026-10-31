/**
 * v2.41 R21：/api/v1 公共 REST API 的 OpenAPI 3.1 规范（手工精选）。
 *
 * 为什么手写而不是 hono-openapi 自动生成：全仓 868 个端点改造成
 * OpenAPIHono/zod-openapi 路由不现实（调研结论见 docs/v2.41-ITERATION.md），
 * 而对外承诺的公共面只有这 6 个端点——手工 spec 精确且零新依赖。
 *
 * 同步纪律：端点增删/参数变更必须同步本文件（文件头即路由注释的事实清单）。
 * 消费方：GET /api/v1/openapi.json（公开，spec 本身无敏感数据）+ ApiPortal 展示。
 */

/** 统一错误响应体 schema */
const ERROR_BODY = {
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { const: false },
          error: { type: 'string' },
        },
      },
    },
  },
} as const;

/** 统一错误响应（401/403/429/500）——四个端点族共用（必须在 openApiSpec 之前声明） */
const ERROR_RESPONSES = {
  '401': { description: 'missing_token / token_revoked / token_expired / invalid_token', ...ERROR_BODY },
  '403': { description: 'insufficient_scope', ...ERROR_BODY },
  '429': { description: 'rate_limited（含 Retry-After 头）', ...ERROR_BODY },
  '500': { description: 'internal_error', ...ERROR_BODY },
} as const;

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'TimeMark Public API',
    version: '1.0.0',
    description:
      '对外 REST API（/api/v1/*）。鉴权：`Authorization: Bearer tmt_...`（在「API 门户」创建 Token，read/write scope 分离）。' +
      '所有响应为 `{ success, data | error }` 形状；逐调用限流 120 次/分钟，超限返回 429 + Retry-After。',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ BearerAuth: [] }],
  tags: [
    { name: 'events', description: '事件' },
    { name: 'expiry', description: '到期中心' },
    { name: 'habits', description: '习惯' },
    { name: 'stats', description: '统计' },
  ],
  paths: {
    '/events': {
      get: {
        tags: ['events'],
        summary: '事件列表（日期升序）',
        operationId: 'listEvents',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: '起始日期（YYYY-MM-DD，含）' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: '结束日期（YYYY-MM-DD，含）' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          '200': {
            description: '事件数组（日期升序，limit 上限 100）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['success', 'data'],
                  properties: {
                    success: { const: true },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/EventListItem' },
                    },
                  },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
      post: {
        tags: ['events'],
        summary: '新建事件（需要 write scope）',
        operationId: 'createEvent',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateEventInput' },
            },
          },
        },
        responses: {
          '201': {
            description: '已创建',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { const: true },
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'integer' },
                        name: { type: 'string' },
                        date: { type: 'string', format: 'date' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'validation_failed（请求体不符合 CreateEventInput）', ...ERROR_BODY },
          ...ERROR_RESPONSES,
        },
      },
    },
    '/events/{id}': {
      get: {
        tags: ['events'],
        summary: '单事件详情',
        operationId: 'getEvent',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': {
            description: '事件详情（含 reminder_config）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { const: true },
                    data: { $ref: '#/components/schemas/EventDetail' },
                  },
                },
              },
            },
          },
          '400': { description: 'invalid_id', ...ERROR_BODY },
          '404': { description: 'not_found', ...ERROR_BODY },
          ...ERROR_RESPONSES,
        },
      },
    },
    '/expiry': {
      get: {
        tags: ['expiry'],
        summary: '到期中心条目（分页）',
        operationId: 'listExpiry',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          {
            name: 'kind',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['subscription', 'bill', 'insurance', 'domain', 'warranty', 'other'],
            },
          },
        ],
        responses: {
          '200': {
            description: '分页结果',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { const: true },
                    data: {
                      type: 'object',
                      properties: {
                        items: { type: 'array', items: { $ref: '#/components/schemas/ExpiryItem' } },
                        total: { type: 'integer' },
                        page: { type: 'integer' },
                        limit: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    '/habits': {
      get: {
        tags: ['habits'],
        summary: '习惯列表 + 连击',
        operationId: 'listHabits',
        parameters: [
          { name: 'active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: '缺省 = 全部' },
        ],
        responses: {
          '200': {
            description: '习惯公开视图数组',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { const: true },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/HabitView' },
                    },
                  },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    '/stats/daily': {
      get: {
        tags: ['stats'],
        summary: '日统计（事件数/提醒发送与失败）',
        operationId: 'dailyStats',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          '200': {
            description: '按天倒序的统计行',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { const: true },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DailyStat' },
                    },
                  },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API 门户签发的 Token，以 tmt_ 开头；read 只读、write 可写。',
      },
    },
    schemas: {
      EventListItem: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          type: { type: 'string' },
          date: { type: 'string', format: 'date' },
          calendar_type: { type: 'string' },
          lunar_date: {},
          person_name: { type: ['string', 'null'] },
          reminder_times: { type: 'array', items: { type: 'string' } },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      EventDetail: {
        allOf: [{ $ref: '#/components/schemas/EventListItem' }, {
          type: 'object',
          properties: { reminder_config: { type: 'object' } },
        }],
      },
      CreateEventInput: {
        type: 'object',
        required: ['name', 'date'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          date: { type: 'string', format: 'date' },
          type: { type: 'string', description: '事件类型（与站内一致，如 birthday/anniversary/custom）' },
          calendar_type: { type: 'string', enum: ['gregorian', 'lunar'] },
          person_name: { type: 'string' },
        },
      },
      ExpiryItem: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          kind: { type: 'string' },
          expires_at: { type: 'string', format: 'date' },
        },
      },
      HabitView: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          isActive: { type: 'boolean' },
          streak: { type: 'integer' },
          longestStreak: { type: 'integer' },
          targetPerPeriod: { type: ['integer', 'null'] },
          period: { type: 'string' },
        },
      },
      DailyStat: {
        type: 'object',
        properties: {
          day: { type: 'string', format: 'date' },
          events_count: { type: 'integer' },
          reminders_sent: { type: 'integer' },
          reminders_failed: { type: 'integer' },
        },
      },
    },
  },
} as const;

