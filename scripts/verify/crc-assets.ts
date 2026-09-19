import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Violation = { case: string; rule: string; detail: string };

const ROOT = resolve(import.meta.dirname, '..', '..');
const ACK = resolve(ROOT, 'service', 'acknowledge');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assetPath(folder: string, stem: string, suffix: string): string {
  return resolve(ACK, folder, `${stem}.${suffix}.json`);
}

export function verifyCrcAssets(): Violation[] {
  const violations: Violation[] = [];
  const catalogPath = resolve(ACK, 'study_catalog.json');
  if (!existsSync(catalogPath)) {
    return [{ case: 'catalog', rule: 'missing', detail: catalogPath }];
  }

  let catalog: unknown;
  try {
    catalog = readJson(catalogPath);
  } catch (error) {
    return [{ case: 'catalog', rule: 'invalid-json', detail: String(error) }];
  }

  const studies = (
    catalog && typeof catalog === 'object' && Array.isArray((catalog as { studies?: unknown }).studies)
      ? (catalog as { studies: unknown[] }).studies
      : []
  );
  if (studies.length === 0) {
    violations.push({ case: 'catalog', rule: 'empty', detail: 'study_catalog.json has no studies' });
    return violations;
  }

  const seen = new Set<string>();
  for (const entry of studies) {
    const stem = entry && typeof entry === 'object'
      ? String((entry as { stem?: unknown }).stem ?? '').trim()
      : '';
    if (!stem) {
      violations.push({ case: 'catalog', rule: 'missing-stem', detail: JSON.stringify(entry) });
      continue;
    }
    if (seen.has(stem)) {
      violations.push({ case: stem, rule: 'duplicate-stem', detail: 'catalog stem must be unique' });
      continue;
    }
    seen.add(stem);

    const assets = [
      { folder: 'relative_experiment', suffix: 'background', shape: 'object' },
      { folder: 'questions_pool', suffix: 'concerns', shape: 'array' },
      { folder: 'opening_state', suffix: 'opening', shape: 'object' },
    ] as const;

    for (const asset of assets) {
      const path = assetPath(asset.folder, stem, asset.suffix);
      if (!existsSync(path)) {
        violations.push({ case: stem, rule: `missing-${asset.suffix}`, detail: path });
        continue;
      }
      try {
        const value = readJson(path);
        const valid = asset.shape === 'array'
          ? Array.isArray(value) && value.length > 0
          : Boolean(value && typeof value === 'object' && !Array.isArray(value));
        if (!valid) {
          violations.push({
            case: stem,
            rule: `invalid-${asset.suffix}`,
            detail: `expected non-empty ${asset.shape}`,
          });
        }
      } catch (error) {
        violations.push({ case: stem, rule: `invalid-${asset.suffix}-json`, detail: String(error) });
      }
    }
  }
  return violations;
}
