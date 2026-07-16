/** Smoke-test the tarball-installed binary (tmp-install) against the mock API. */
import { spawn } from 'node:child_process';
import { createMockServer } from './mock-server.mjs';

const mock = createMockServer();
const port = await mock.listen();

const out = await new Promise((resolve, reject) => {
  const child = spawn(
    'tmp-install\\node_modules\\.bin\\grokscope.cmd',
    ['ask', 'bun vs node in 2026'],
    {
      env: { ...process.env, GROK_API_KEY: 'test', GROK_BASE_URL: 'http://127.0.0.1:' + port + '/v1' },
      shell: true,
    },
  );
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', () => {});
  child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error('exit ' + code + '\n' + stdout))));
});

console.log(out);
await mock.close();
if (!/x\.com\/\w+\/status\/\d+/.test(out) || !out.includes('Community Verdict')) {
  console.error('SMOKE FAIL');
  process.exit(1);
}
console.log('SMOKE PASS: installed binary works end-to-end');
