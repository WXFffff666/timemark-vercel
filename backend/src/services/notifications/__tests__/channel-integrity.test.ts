import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DISPATCHABLE_CHANNELS,
  FALLBACK_DISPATCHABLE_CHANNELS,
  channelToAccountType,
} from '../index.js';
import { getSupportedChannelTemplates, type ChannelTemplate } from '../channels.config.js';
import { UNSUPPORTED_CHANNEL_IDS } from '../supported-channels.js';

/**
 * Checkbox 27 guard: no dead channel code may ship.
 *
 * For every id from getSupportedChannelTemplates():
 *   (a) it is registered in channelToAccountType (account resolution),
 *   (b) it has a dispatch branch in BOTH index.ts chains (DISPATCHABLE_CHANNELS /
 *       FALLBACK_DISPATCHABLE_CHANNELS — runtime sets exported by index.ts),
 *   (c) it has a provider-specific case in test-connection.ts,
 *   (d) UNSUPPORTED_CHANNEL_IDS and the templates list never intersect.
 *
 * The scratch-copy proofs use env overrides so the guard can be shown to fail on
 * deliberately broken wiring without mutating the real tree:
 *   TM_INTEGRITY_INDEX_SOURCE   -> alternative index.ts (e.g. ./.scratch/index.ts)
 *   TM_CHANNELS_CONFIG_SOURCE   -> alternative channels.config.ts
 *   TM_TEST_CONNECTION_SOURCE   -> alternative test-connection.ts
 */
const NOTIF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_CONNECTION_PATH = process.env.TM_TEST_CONNECTION_SOURCE
  ? path.resolve(NOTIF_DIR, process.env.TM_TEST_CONNECTION_SOURCE)
  : path.resolve(NOTIF_DIR, 'test-connection.ts');

type IndexModule = {
  DISPATCHABLE_CHANNELS: Set<string>;
  FALLBACK_DISPATCHABLE_CHANNELS: Set<string>;
  channelToAccountType: Record<string, string>;
};

type ConfigModule = {
  getSupportedChannelTemplates: () => ChannelTemplate[];
};

async function importScratch<T>(envVar: string, fallback: T): Promise<T> {
  const override = process.env[envVar];
  if (!override) return fallback;
  const absolute = path.isAbsolute(override) ? override : path.resolve(NOTIF_DIR, override);
  return (await import(/* @vite-ignore */ pathToFileURL(absolute).href)) as T;
}

async function loadIndexModule(): Promise<IndexModule> {
  return importScratch<IndexModule>('TM_INTEGRITY_INDEX_SOURCE', {
    DISPATCHABLE_CHANNELS,
    FALLBACK_DISPATCHABLE_CHANNELS,
    channelToAccountType,
  });
}

async function loadSupportedTemplates(): Promise<ChannelTemplate[]> {
  const mod = await importScratch<ConfigModule>('TM_CHANNELS_CONFIG_SOURCE', {
    getSupportedChannelTemplates,
  });
  return mod.getSupportedChannelTemplates();
}

function extractCaseIds(source: string, functionName: string): Set<string> {
  const marker = `function ${functionName}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`test-connection.ts 中未找到 ${functionName}`);
  }
  const body = source.slice(start);
  const next = body.slice(1).search(/\n(?:export )?(?:async )?function /);
  const scope = next === -1 ? body : body.slice(0, next + 1);
  const ids = new Set<string>();
  for (const match of scope.matchAll(/case '([A-Za-z0-9_]+)':/g)) {
    ids.add(match[1]);
  }
  return ids;
}

describe('channel integrity: supported channels are fully wired (checkbox 27)', () => {
  it('(a) every supported channel has an entry in channelToAccountType', async () => {
    const indexModule = await loadIndexModule();
    const supported = await loadSupportedTemplates();
    const missing = supported
      .map((c) => c.id)
      .filter((id) => !(id in indexModule.channelToAccountType));
    expect(missing, 'channels missing from channelToAccountType').toEqual([]);
  });

  it('(b) every supported channel has a dispatch branch in BOTH index.ts dispatch chains', async () => {
    const indexModule = await loadIndexModule();
    const supported = await loadSupportedTemplates();
    const ids = supported.map((c) => c.id);
    const missingMain = ids.filter((id) => !indexModule.DISPATCHABLE_CHANNELS.has(id));
    const missingFallback = ids.filter((id) => !indexModule.FALLBACK_DISPATCHABLE_CHANNELS.has(id));
    expect(missingMain, 'channels missing from the main dispatch chain').toEqual([]);
    expect(missingFallback, 'channels missing from the fallback dispatch chain').toEqual([]);
  });

  it('(c) every supported channel has a provider-specific test-connection case', async () => {
    const supported = await loadSupportedTemplates();
    const source = fs.readFileSync(TEST_CONNECTION_PATH, 'utf8');
    const webhookCases = extractCaseIds(source, 'testWebhookChannel');
    const tokenCases = extractCaseIds(source, 'testTokenChannel');
    const pluginCases = extractCaseIds(source, 'testPluginChannel');

    const missing: string[] = [];
    for (const channel of supported) {
      const cases =
        channel.configMethod === 'webhook'
          ? webhookCases
          : channel.configMethod === 'token'
            ? tokenCases
            : pluginCases;
      if (!cases.has(channel.id)) {
        missing.push(`${channel.id} (${channel.configMethod})`);
      }
    }
    expect(missing, 'channels missing a test-connection case').toEqual([]);
  });

  it('(d) UNSUPPORTED_CHANNEL_IDS and the supported templates never intersect', async () => {
    const supported = await loadSupportedTemplates();
    const overlap = supported.map((c) => c.id).filter((id) => UNSUPPORTED_CHANNEL_IDS.has(id));
    expect(overlap, 'blocked channel ids must never be advertised as supported').toEqual([]);
  });

  it('(e) the two dispatch registries stay in sync with each other', async () => {
    const indexModule = await loadIndexModule();
    const onlyMain = [...indexModule.DISPATCHABLE_CHANNELS].filter(
      (id) => !indexModule.FALLBACK_DISPATCHABLE_CHANNELS.has(id),
    );
    const onlyFallback = [...indexModule.FALLBACK_DISPATCHABLE_CHANNELS].filter(
      (id) => !indexModule.DISPATCHABLE_CHANNELS.has(id),
    );
    expect({ onlyMain, onlyFallback }).toEqual({ onlyMain: [], onlyFallback: [] });
  });

  it('(f) the supported catalogue and the blocklist still have their authoritative sizes', async () => {
    const supported = await loadSupportedTemplates();
    expect(supported.length, 'supported channel count').toBe(46);
    expect(UNSUPPORTED_CHANNEL_IDS.size, 'blocked channel count').toBe(8);
  });
});
