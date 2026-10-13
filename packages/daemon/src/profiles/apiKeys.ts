/** The key a profile pays by (docs/profiles-v0.md §3.6): kept as a ciphertext of the gate's, sealed for the address it
 *  is sent to, and handed to the agent of a terminal under that profile when it asks — Claude Code through its
 *  `apiKeyHelper`, Codex through its provider's `auth` command (terminals/launch.ts, terminals/hookClient.ts `key`). It
 *  is in no file and in no environment: the plaintext is in this process for the moment the gate hands it over, and in
 *  the agent that sends it.
 *
 *  A terminal is not behind the credential gate (§8): the agent holds this key as it would one typed into its own
 *  settings. What the gate adds is that the key at rest is a ciphertext, and that it opens for one address only. */

import { apiSite, type Profile, type ProfileAgent, type ProfileApi, type ProfileKind } from "./store.js";

/** The gate's answer for a ciphertext it may open for one of `sites` (browser/fill.ts `FillResolver`, as the service
 *  wires it). */
export type KeyResolver = (token: string, sites: readonly string[]) => Promise<{ readonly value: string }>;
/** A ciphertext of the gate's, as it is written. */
const CIPHERTEXT = /^enc:v1:[A-Za-z0-9_=-]{16,}$/;

/** The part of the profile store this needs. */
export type ApiKeyStore = {
  apiOf(agent: ProfileAgent, id: string): ProfileApi | null;
  setApi(agent: ProfileAgent, id: string, api: ProfileApi): void;
  create(agent: ProfileAgent, name: string, kind: ProfileKind, api?: ProfileApi): Profile;
};

export class ApiKeyError extends Error {}

/** What a key looks like at the least: one word, not a handful of characters. Vendors' and relays' keys differ. */
const KEY = /^\S{8,400}$/;

export type ApiKeysOptions = {
  readonly store: ApiKeyStore;
  /** The gate's answer for a ciphertext; absent without the gate: no key can be kept or handed over. */
  readonly resolve?: KeyResolver | undefined;
};

export class ApiKeys {
  constructor(private readonly o: ApiKeysOptions) {}

  /** A new profile that pays by `api.key`, a ciphertext sealed for where the key is sent. Refused before anything is
   *  made when the gate will not open it for that address. */
  async create(agent: ProfileAgent, name: string, api: ProfileApi): Promise<Profile> {
    await this.open(agent, api.key, api.baseUrl);
    return this.o.store.create(agent, name, "api", api);
  }

  /** `id`'s address and model from now on, and its key when one is given (`key` null: the one it has — which opens
   *  only while the address is on the site it was sealed for). */
  async set(agent: ProfileAgent, id: string, next: { readonly key: string | null; readonly baseUrl?: string | undefined; readonly model?: string | undefined }): Promise<void> {
    const kept = this.o.store.apiOf(agent, id);
    const key = next.key ?? kept?.key;
    if (!key) throw new ApiKeyError("这个配置还没有 API key。");
    if (!next.key && apiSite(agent, next.baseUrl) !== apiSite(agent, kept?.baseUrl)) throw new ApiKeyError("地址换到了另一个站点，原来的 API key 是为原站点加密的，请一并填入新的。");
    await this.open(agent, key, next.baseUrl);
    this.o.store.setApi(agent, id, { key, baseUrl: next.baseUrl, model: next.model });
  }

  /** The key itself, for the agent of a terminal under `id` to send. */
  async plain(agent: ProfileAgent, id: string): Promise<string> {
    const kept = this.o.store.apiOf(agent, id);
    if (!kept) throw new ApiKeyError("这个配置没有 API key。");
    return this.open(agent, kept.key, kept.baseUrl);
  }

  private async open(agent: ProfileAgent, sealed: string, baseUrl: string | undefined): Promise<string> {
    if (!CIPHERTEXT.test(sealed)) throw new ApiKeyError("API key 请以密文（enc:v1:）提供。");
    if (!this.o.resolve) throw new ApiKeyError("凭据网关不可用，无法使用 API key。");
    let site: string;
    try { site = apiSite(agent, baseUrl?.trim() || undefined); } catch { throw new ApiKeyError("地址不是一个 http(s) 地址。"); }
    let value: string;
    try { value = (await this.o.resolve(sealed, [site])).value.trim(); }
    catch { throw new ApiKeyError(`凭据网关没有给出这个 API key（它须是为 ${new URL(site).host} 加密的）。`); }
    if (!KEY.test(value)) throw new ApiKeyError("这不像一个 API key。");
    return value;
  }
}
