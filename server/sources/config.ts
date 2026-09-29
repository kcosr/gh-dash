// The configured sources besides github.com, from config.json's `sources` and (headless) the GitLab env variables.
// Credentials stay out of the database (design §1.6): the method and its reference (token file, env variable) live
// here, written only by the owner (headless) or by the desktop app's main process, never over HTTP.

import { isAbsolute } from 'node:path';
import type { ConfigSource, TokenChoice } from '../../shared/api';
import { DESKTOP_ENV } from '../../shared/desktop';
import { CONFIG_ENV, type ConfigFile, GITLAB_ENV, type LoadedConfigFile, type SourceConfigEntry, sourceUrl } from '../config-file';
import { envKey } from '../credentials/cli';
import { GITLAB_TOKEN_ENV } from '../gitlab/credentials';

/** One GitLab source as this instance runs it: identity, URL, and how its token is found. */
export interface SourceConfig {
  kind: 'gitlab';
  /** Identity: the URL's lower-case host name, without the port. Also the prefix of its repo keys. */
  host: string;
  /** The instance URL, relative root included, without a trailing slash (normalizeBaseUrl). */
  baseUrl: string;
  /**
   * The chosen method: glab, file or app; `auto` (the headless default) is the token file when one is set, else "not
   * configured" (never glab); null = not chosen yet (the desktop default).
   */
  tokenChoice: TokenChoice | null;
  /** Absolute path of a file holding just the token; null when none. */
  tokenFile: string | null;
  /**
   * The variable that, when set, is the token and locks the method: the entry's own tokenEnv, else GITLAB_TOKEN when
   * this is the only GitLab source or the one GH_DASH_GITLAB_URL names; null = none.
   */
  tokenEnv: string | null;
  /** config.json, or the environment when GH_DASH_GITLAB_URL declares or overrides it. */
  from: Exclude<ConfigSource, 'default'>;
}

/** Everything the source registry is built from; re-read on the desktop app's `reload-sources`. */
export interface SourcesConfig {
  /** GH_DASH_GLAB_PATH / glabPath: the glab executable, when it isn't on PATH or in a standard location. */
  glabPath: string | null;
  sources: SourceConfig[];
}

export interface LoadedSources extends SourcesConfig {
  /** Where glabPath and the source list came from (the list: env when the environment declared or changed one). */
  from: { glabPath: ConfigSource; sources: ConfigSource };
  warnings: string[];
}

const ENV_CHOICES: readonly TokenChoice[] = ['glab', 'file'];

/**
 * The sources from config.json (`file`, already validated by its schema) and, on a headless server, the environment:
 * GH_DASH_GITLAB_URL declares a source, or overrides the config.json one on the same host; GITLAB_TOKEN_FILE and
 * GH_DASH_GITLAB_TOKEN_SOURCE apply to that source, or to the only one config.json has. The desktop app ignores those
 * variables: its sources are what main wrote to config.json. A set but empty variable means the default, as
 * elsewhere. Reads no files.
 */
export function loadSources(env: NodeJS.ProcessEnv, file: LoadedConfigFile | null, platform: NodeJS.Platform = process.platform): LoadedSources {
  const desktop = env[DESKTOP_ENV.desktop] === '1';
  const data: ConfigFile = file?.data ?? {};
  const where = (what: string) => (file ? `${what} in ${file.path}` : what);
  const warnings: string[] = [];

  // glabPath: env (even empty) beats config.json, as every other setting.
  const rawGlab = env[CONFIG_ENV.glabPath];
  const glabFrom: ConfigSource = rawGlab !== undefined ? 'env' : data.glabPath !== undefined ? 'file' : 'default';
  const glabPath = (rawGlab !== undefined ? rawGlab.trim() : data.glabPath?.trim()) || null;
  if (glabPath && desktop && !isAbsolute(glabPath)) {
    throw new Error(`${glabFrom === 'env' ? CONFIG_ENV.glabPath : where('glabPath')} must be an absolute path: ${glabPath}`);
  }

  interface Draft extends SourceConfigEntry {
    baseUrl: string;
    host: string;
    from: 'file' | 'env';
  }
  const drafts: Draft[] = (data.sources ?? []).map((entry) => ({ ...entry, ...sourceUrl(entry.url), from: 'file' }));

  // The environment's source (headless only).
  let envSource: Draft | null = null;
  if (!desktop) {
    const url = env[GITLAB_ENV.url]?.trim();
    const tokenFile = env[GITLAB_ENV.tokenFile];
    const tokenSource = env[GITLAB_ENV.tokenSource];
    if (url) {
      let parsed: { baseUrl: string; host: string };
      try {
        parsed = sourceUrl(url);
      } catch (err) {
        throw new Error(`Invalid ${GITLAB_ENV.url}: ${(err as Error).message}`);
      }
      if (parsed.host === 'github.com') throw new Error(`Invalid ${GITLAB_ENV.url}: github.com is built in; configure it with ${CONFIG_ENV.tokenSource}`);
      envSource = drafts.find((d) => d.host === parsed.host) ?? null;
      if (!envSource) {
        envSource = { kind: 'gitlab', url, ...parsed, from: 'env' };
        drafts.push(envSource);
      } else {
        Object.assign(envSource, { url, ...parsed, from: 'env' });
      }
    } else if (tokenFile !== undefined || tokenSource !== undefined) {
      const name = tokenFile !== undefined ? GITLAB_ENV.tokenFile : GITLAB_ENV.tokenSource;
      if (drafts.length === 1) envSource = drafts[0]!;
      else if (drafts.length === 0) warnings.push(`${name} is ignored: no GitLab source is configured (set ${GITLAB_ENV.url})`);
      else throw new Error(`${name} applies to one GitLab source, and ${drafts.length} are configured: set ${GITLAB_ENV.url} to say which`);
    }
    if (envSource) {
      if (tokenFile !== undefined) {
        const path = tokenFile.trim();
        if (path && !isAbsolute(path)) throw new Error(`${GITLAB_ENV.tokenFile} must be an absolute path: ${path}`);
        envSource.tokenFile = path || null;
        envSource.from = 'env';
      }
      if (tokenSource !== undefined) {
        const value = tokenSource.trim().toLowerCase();
        if (value && !(ENV_CHOICES as readonly string[]).includes(value)) {
          throw new Error(`Invalid ${GITLAB_ENV.tokenSource}: ${tokenSource} (expected ${ENV_CHOICES.join(', ')})`);
        }
        // Empty: the default, as if config.json named none.
        envSource.tokenSource = value ? (value as 'glab' | 'file') : undefined;
        envSource.from = 'env';
      }
    }
  }

  const sources = drafts.map((d): SourceConfig => {
    const own = d.tokenEnv?.trim() || null;
    // GITLAB_TOKEN is the only source's, or the one GH_DASH_GITLAB_URL named: nothing else says which it is for.
    const tokenEnv = own ?? (drafts.length === 1 || (d === envSource && env[GITLAB_ENV.url]?.trim()) ? GITLAB_TOKEN_ENV : null);
    return {
      kind: 'gitlab',
      host: d.host,
      baseUrl: d.baseUrl,
      tokenChoice: d.tokenSource === undefined ? (desktop ? null : 'auto') : d.tokenSource,
      tokenFile: d.tokenFile ?? null,
      tokenEnv,
      from: d.from,
    };
  });
  // After the environment's source: GITLAB_TOKEN may now lock one, and on Windows gitlab_token is the same variable.
  const locks = new Map<string, SourceConfig>();
  for (const s of sources) {
    if (!s.tokenEnv) continue;
    const other = locks.get(envKey(s.tokenEnv, platform));
    if (other) {
      const same = other.tokenEnv === s.tokenEnv ? '' : ` (the same variable as ${other.tokenEnv} on Windows)`;
      throw new Error(`${s.tokenEnv}${same} would lock both ${other.host} and ${s.host}: give one of them its own tokenEnv`);
    }
    locks.set(envKey(s.tokenEnv, platform), s);
  }
  for (const s of sources) {
    if (s.tokenChoice === 'file' && !s.tokenFile) warnings.push(`GitLab source ${s.host} uses a token file, but none is set (tokenFile or ${GITLAB_ENV.tokenFile})`);
  }

  const listFrom: ConfigSource = sources.some((s) => s.from === 'env') ? 'env' : data.sources !== undefined ? 'file' : 'default';
  return { glabPath, sources, from: { glabPath: glabFrom, sources: listFrom }, warnings };
}
