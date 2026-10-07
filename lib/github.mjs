// Stato delle release del repo, con la CLI gh (nel workflow: GH_TOKEN e GH_REPO).

import { spawnSync } from 'node:child_process';

/** Tag della release di un dump. */
export function releaseTag(dump) {
  return `pack-${dump}`;
}

/**
 * Stato della release con quel tag: `published`, `draft` (resto di un giro fallito, il
 * workflow la toglie prima di ricrearla) o `absent`. Ogni altro errore di gh ferma tutto:
 * meglio non costruire che ricostruire un pacchetto già pubblicato.
 * @param {string} tag
 * @param {{ run?: typeof spawnSync }} [opzioni] `run` sostituibile nei test
 * @returns {'published' | 'draft' | 'absent'}
 */
export function releaseState(tag, { run = spawnSync } = {}) {
  const r = run('gh', ['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft'], { encoding: 'utf8' });
  if (r.error) throw new Error(`gh: ${r.error.message}`);
  if (r.status === 0) return r.stdout.trim() === 'true' ? 'draft' : 'published';
  if (/release not found/i.test(r.stderr ?? '')) return 'absent';
  throw new Error(`gh release view ${tag} failed: ${String(r.stderr ?? '').trim()}`);
}
