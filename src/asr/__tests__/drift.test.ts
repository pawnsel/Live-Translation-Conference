import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ASR_REPO = process.env.ASR_REPO_PATH ?? join(process.cwd(), '..', 'thai-realtime-asr-mt');
const hasSourceRepo = existsSync(ASR_REPO);

// These copies are generated in the Python repo. If the backend regenerates
// them and this repo does not re-copy, the client silently speaks an older
// dialect than the server — which is exactly the failure a version-tolerant
// protocol will NOT report at runtime.
describe.skipIf(!hasSourceRepo)('protocol artifacts match the backend', () => {
  it('protocol.ts is byte-identical to the generated source', () => {
    const ours = readFileSync(join(process.cwd(), 'src/asr/protocol.ts'), 'utf8');
    const theirs = readFileSync(join(ASR_REPO, 'frontend/src/protocol.ts'), 'utf8');
    expect(ours).toBe(theirs);
  });

  it('every golden frame is present and identical', () => {
    const dir = join(ASR_REPO, 'tests/golden/protocol');
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const ours = readFileSync(join(process.cwd(), 'src/asr/__fixtures__/protocol', name), 'utf8');
      expect(readFileSync(join(dir, name), 'utf8'), name).toBe(ours);
    }
  });
});
