export interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  requestId?: string;
}

export function createError(message: string, code?: string): ErrorResponse {
  return { success: false, error: message, code };
}

export const ErrorCodes = {
  AUTH_001: 'Invalid credentials',
  AUTH_002: 'Account locked',
  AUTH_003: 'Token expired',
  AUTH_004: 'Unauthorized',
  EVENT_001: 'Event not found',
  EVENT_002: 'Invalid event data',
  CONFIG_001: 'Invalid configuration',
  NOTIFY_001: 'Notification send failed',
  NOTIFY_002: 'Channel not configured',
  SYSTEM_001: 'Internal server error',
} as const;
