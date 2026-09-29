import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_TOOLS,
  AGENT_TOOLS_BY_NAME,
  AGENT_TOOL_SCOPES,
  CONFIRMATION_REQUIRED_AGENT_TOOLS,
  DESTRUCTIVE_AGENT_TOOLS,
  DOCUMENTED_AGENT_TOOL_NAMES,
  getAgentTool,
} from '@timemark/shared/agent-tools';

/**
 * Checkbox 100 acceptance: `shared/src/agent-tools.ts` is THE single source of truth for
 * the 22 agent tools consumed by the assistant (101), the tool API (102) and the MCP
 * server (103).
 *
 * What this file locks down:
 *   1. registry == documented list (22 names, exact set);
 *   2. unique names — the failure message NAMES EVERY OFFENDING ENTRY;
 *   3. every description is non-empty and states WHEN to call the tool;
 *   4. every inputSchema is a strict Zod object that REJECTS `{}`;
 *   5. no schema declares a free-form `sql` / `exec` / `command` / `url` / `query` field,
 *      at ANY depth (anti-omnibus-tool rule);
 *   6. least-privilege scopes, boolean flags, and the documented destructive set
 *      (`delete_event` only).
 */

/**
 * Field names that would turn a narrow tool into a free-form escape hatch. `sql` / `exec`
 * / `command` / `url` are the MCP anti-pattern; `query` is banned too so `search` can only
 * ever expose a bounded `text` search, never an arbitrary query surface.
 */
const BANNED_FIELD_NAMES = ['sql', 'exec', 'command', 'url', 'query'] as const;

interface FieldVisit {
  path: string;
  schema: z.ZodType;
}

/**
 * Walk every declared field of a schema at any depth (objects, arrays, optional/nullable/
 * default wrappers and unions). The registry schemas are flat by design, but the walker is
 * recursive so a future nested field cannot sneak a banned name past the guard — and the
 * self-test below proves the walker really descends.
 */
function walkInputFields(
  schema: z.ZodType,
  prefix: string,
  visit: (field: FieldVisit) => void,
): void {
  if (schema instanceof z.ZodObject) {
    for (const [key, value] of Object.entries(schema.shape)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const field = value as z.ZodType;
      visit({ path, schema: field });
      walkInputFields(field, path, visit);
    }
    return;
  }
  if (schema instanceof z.ZodArray) {
    walkInputFields(schema.element as z.ZodType, `${prefix}[]`, visit);
    return;
  }
  if (schema instanceof z.ZodOptional) {
    walkInputFields(schema.unwrap() as z.ZodType, prefix, visit);
    return;
  }
  if (schema instanceof z.ZodNullable) {
    walkInputFields(schema.unwrap() as z.ZodType, prefix, visit);
    return;
  }
  if (schema instanceof z.ZodDefault) {
    walkInputFields(schema.unwrap() as z.ZodType, prefix, visit);
    return;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options as readonly z.ZodType[]) {
      walkInputFields(option, prefix, visit);
    }
    return;
  }
}

/** Field-name segments of a path that are on the banned list (`steps[].sql` -> sql). */
function bannedSegments(path: string): string[] {
  return path
    .split('.')
    .map((segment) => segment.replace(/\[\]$/, '').toLowerCase())
    .filter((segment) => (BANNED_FIELD_NAMES as readonly string[]).includes(segment));
}

/** Human-readable entry description used by the duplicate-name failure message. */
function describeEntry(index: number): string {
  const tool = AGENT_TOOLS[index];
  return `#${index} name=${tool.name} handler=${tool.handler}`;
}

describe('agent tool registry (checkbox 100)', () => {
  it('documents exactly 22 tools and the registry matches the documented list', () => {
    expect(DOCUMENTED_AGENT_TOOL_NAMES.length).toBe(22);

    const registryNames = AGENT_TOOLS.map((tool) => tool.name);
    expect(registryNames, 'registry count must equal the documented tool count').toHaveLength(
      DOCUMENTED_AGENT_TOOL_NAMES.length,
    );

    for (const expected of DOCUMENTED_AGENT_TOOL_NAMES) {
      expect(registryNames, `missing documented tool: ${expected}`).toContain(expected);
    }
    for (const actual of registryNames) {
      expect(
        DOCUMENTED_AGENT_TOOL_NAMES as readonly string[],
        `registry exposes an undocumented tool: ${actual}`,
      ).toContain(actual);
    }
  });

  it('gives every tool a UNIQUE name and names every offending entry on failure', () => {
    const indexesByName = new Map<string, number[]>();
    AGENT_TOOLS.forEach((tool, index) => {
      const indexes = indexesByName.get(tool.name) ?? [];
      indexes.push(index);
      indexesByName.set(tool.name, indexes);
    });

    const duplicates = [...indexesByName.entries()]
      .filter(([, indexes]) => indexes.length > 1)
      .map(
        ([name, indexes]) =>
          `"${name}" used by entries: ${indexes.map((index) => describeEntry(index)).join(' | ')}`,
      );

    expect(duplicates, `duplicate tool names: ${duplicates.join('; ')}`).toEqual([]);
  });

  it('describes every tool with a non-empty description that states WHEN to call it', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.trim().length, `${tool.name}: description is empty`).toBeGreaterThan(0);
      expect(
        tool.description.length,
        `${tool.name}: description is too thin to guide tool selection`,
      ).toBeGreaterThanOrEqual(40);
      expect(tool.description, `${tool.name}: description must state when to call it`).toMatch(
        /(call|use)[^.]{0,30}when/i,
      );
    }
  });

  it('gives every tool a strict Zod object schema that REJECTS an empty object', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema, `${tool.name}: inputSchema must be a Zod object`).toBeInstanceOf(
        z.ZodObject,
      );
      const parsed = tool.inputSchema.safeParse({});
      expect(
        parsed.success,
        `${tool.name}: inputSchema accepted {} - every tool needs at least one required field`,
      ).toBe(false);
    }
  });

  it('declares no free-form sql/exec/command/url/query field at any depth', () => {
    for (const tool of AGENT_TOOLS) {
      const paths: string[] = [];
      walkInputFields(tool.inputSchema, '', (field) => paths.push(field.path));

      const offenders = paths.filter((path) => bannedSegments(path).length > 0);
      expect(
        offenders,
        `${tool.name}: free-form field(s) not allowed: ${offenders.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('detects a banned field nested at depth (walker self-test)', () => {
    const synthetic = z.strictObject({
      nested: z.strictObject({ url: z.string() }),
      steps: z.array(z.strictObject({ command: z.string() })),
      wrapped: z.array(z.strictObject({ sql: z.string() })).optional(),
    });

    const offenders: string[] = [];
    walkInputFields(synthetic, '', (field) => {
      if (bannedSegments(field.path).length > 0) offenders.push(field.path);
    });

    expect(offenders.sort()).toEqual(['nested.url', 'steps[].command', 'wrapped[].sql']);
  });

  it('never types a field as any/unknown', () => {
    for (const tool of AGENT_TOOLS) {
      walkInputFields(tool.inputSchema, '', (field) => {
        let inner: z.ZodType = field.schema;
        while (
          inner instanceof z.ZodOptional ||
          inner instanceof z.ZodNullable ||
          inner instanceof z.ZodDefault
        ) {
          inner = inner.unwrap() as z.ZodType;
        }
        const loose = inner instanceof z.ZodAny || inner instanceof z.ZodUnknown;
        expect(loose, `${tool.name}: field ${field.path} is any/unknown`).toBe(false);
      });
    }
  });

  it('assigns a non-empty least-privilege scope from the canonical scope set', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.requiredScope.length, `${tool.name}: requiredScope is empty`).toBeGreaterThan(0);
      expect(
        AGENT_TOOL_SCOPES as readonly string[],
        `${tool.name}: unknown scope "${tool.requiredScope}"`,
      ).toContain(tool.requiredScope);
    }
  });

  it('declares boolean destructive/requiresConfirmation flags with the documented destructive set', () => {
    for (const tool of AGENT_TOOLS) {
      expect(typeof tool.destructive, `${tool.name}: destructive must be boolean`).toBe('boolean');
      expect(
        typeof tool.requiresConfirmation,
        `${tool.name}: requiresConfirmation must be boolean`,
      ).toBe('boolean');
    }

    expect(
      AGENT_TOOLS.filter((tool) => tool.destructive).map((tool) => tool.name),
      'destructive tools must be exactly the documented set',
    ).toEqual(['delete_event']);
    expect(DESTRUCTIVE_AGENT_TOOLS).toEqual(['delete_event']);

    const deleteTool = getAgentTool('delete_event');
    expect(deleteTool.requiredScope, 'delete_event must carry the most restrictive scope').toBe(
      'events:delete',
    );
    expect(deleteTool.requiresConfirmation).toBe(true);
    expect(
      AGENT_TOOLS.filter((tool) => tool.requiredScope.endsWith(':delete')),
      'only delete_event may use a *:delete scope',
    ).toHaveLength(1);

    const sendDigest = getAgentTool('send_digest');
    expect(sendDigest.requiresConfirmation, 'send_digest sends outward and must confirm').toBe(true);
    expect(sendDigest.destructive, 'send_digest is outward, not destructive').toBe(false);
    expect(CONFIRMATION_REQUIRED_AGENT_TOOLS).toContain('send_digest');
  });

  it('binds every tool to a non-empty dotted handler reference', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.handler.trim().length, `${tool.name}: handler is empty`).toBeGreaterThan(0);
      expect(tool.handler, `${tool.name}: handler must be <module>.<function>`).toMatch(
        /^[a-z][\w-]*(\.[\w]+)+$/,
      );
    }
  });

  it('exposes a by-name lookup that agrees with the registry', () => {
    expect(AGENT_TOOLS_BY_NAME.size).toBe(AGENT_TOOLS.length);
    for (const tool of AGENT_TOOLS) {
      expect(getAgentTool(tool.name)).toBe(tool);
    }
  });
});
