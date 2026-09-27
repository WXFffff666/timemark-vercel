import { z } from 'zod';
import type { ZodError } from 'zod';

type FlattenedZodError = {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
};

/** Format Zod validation errors for API responses (Chinese-friendly). */
export function formatZodError(error: ZodError): string {
  // Zod 4 types `fieldErrors` as a mapped type over `keyof T`; for a generic `ZodError`
  // (T = unknown) that collapses to `{}`. The runtime shape is always a string-keyed
  // record of message arrays, so narrow it here (semantics unchanged from Zod 3).
  const flat = z.flattenError(error) as FlattenedZodError;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (messages?.length) parts.push(`${field}: ${messages.join(', ')}`);
  }
  if (flat.formErrors.length) parts.push(...flat.formErrors);
  return parts.join('；') || '请求参数无效';
}
