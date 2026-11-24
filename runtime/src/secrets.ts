// Provider API keys at rest.
//
// - `env:NAME` stores a reference instead of the key: the runtime reads process.env.NAME when it
//   calls the provider. Good for VMs, where the key can come from a systemd EnvironmentFile or a
//   container secret and never touches config.json.
// - When CREW_SECRET_KEY (32 bytes, base64) is set, literal keys are encrypted with AES-256-GCM in
//   config.json and decrypted in memory. The desktop app sets it from a key kept in the OS keychain
//   (Electron safeStorage), so a copied config.json alone doesn't reveal the keys.
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function masterKey(): Buffer | null {
  const raw = process.env.CREW_SECRET_KEY;
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('CREW_SECRET_KEY must be 32 bytes, base64-encoded');
  return k;
}

export const encryptionEnabled = () => masterKey() !== null;
export const isEnvRef = (v?: string) => !!v && /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(v);

/** For writing config.json: encrypt a literal key if a master key is available. */
export function sealKey(v: string | undefined): string | undefined {
  const k = masterKey();
  if (!v || !k || isEnvRef(v) || v.startsWith(PREFIX)) return v;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

/** For reading config.json. Returns '' (and warns) when the key can't be decrypted. */
export function openKey(v: string | undefined, label: string): string | undefined {
  if (!v?.startsWith(PREFIX)) return v;
  const k = masterKey();
  try {
    if (!k) throw new Error('CREW_SECRET_KEY is not set');
    const [iv, tag, ct] = v.slice(PREFIX.length).split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e: any) {
    console.warn(`Could not decrypt the API key for ${label} (${e.message}); enter it again in Settings.`);
    return '';
  }
}

/** The key to send to the provider: resolves `env:NAME` references. */
export function resolveKey(v: string | undefined): string {
  if (!v) return '';
  if (isEnvRef(v)) return process.env[v.slice(4)] ?? '';
  return v;
}
