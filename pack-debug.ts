// pack-debug.ts — read a real git packfile and print what readPack sees, so a
// mis-parsed stream shows up object by object instead of as "bad object".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'packdbg-'));
execFileSync('git', ['init', '-q', dir]);
const env = { ...process.env, GIT_DIR: join(dir, '.git') };
writeFileSync(join(dir, 'a.txt'), 'hello\n');
writeFileSync(join(dir, 'b.txt'), 'second file\n');
execFileSync('git', ['-C', dir, 'add', '-A'], { env });
execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e.x',
  'commit', '-qm', 'c1'], { env });
const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
const pack = execFileSync('git', ['-C', dir, 'pack-objects', '--stdout', '--revs', '-q'], {
  input: head + '\n',
  maxBuffer: 64 * 1024 * 1024,
});
console.log('pack bytes', pack.length, 'head', head.slice(0, 8));

const count = pack.readUInt32BE(8);
console.log('objects declared:', count);
let offset = 12;
for (let i = 0; i < count; i += 1) {
  const start = offset;
  let byte = pack[offset++];
  const typeNum = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = pack[offset++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  const headerEnd = offset;
  // Exact end via a trial: inflate grows until it succeeds at `size`.
  let data: Buffer | null = null;
  let window = Math.min(64, pack.length - offset);
  let used = 0;
  while (window <= pack.length - offset) {
    try {
      const out = inflateRawSync(pack.subarray(offset, offset + window));
      if (out.length === size) {
        data = out;
        used = window;
        // shrink
        let lo = 1, hi = window, best = window;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          try {
            const o2 = inflateRawSync(pack.subarray(offset, offset + mid));
            if (o2.equals(out)) { best = mid; hi = mid - 1; } else { lo = mid + 1; }
          } catch { lo = mid + 1; }
        }
        used = best;
        break;
      }
    } catch { /* grow */ }
    if (window === pack.length - offset) break;
    window = Math.min(pack.length - offset, window * 2);
  }
  console.log(`#${i} start=${start} type=${typeNum} size=${size} header=${headerEnd - start}B`
    + ` data=${data ? data.length : 'FAIL'} used=${used} next=${offset + used}`);
  if (!data) break;
  offset += used;
}
console.log('consumed', offset, 'of', pack.length, '(trailer 20 bytes expected)');
