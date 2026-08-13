import { build } from 'esbuild';

const entries = [
  ['src/lark/knowledge-service.ts', 'scripts/lark-contract-knowledge-validator.js'],
  ['src/lark/meeting-service.ts', 'scripts/lark-contract-meeting-validator.js'],
  ['src/lark/runner.ts', 'scripts/lark-contract-runner-validator.js'],
];

for (const [entryPoint, outfile] of entries) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    legalComments: 'none',
    banner: { js: '// Generated from the owning production service. Do not edit.' },
  });
}
