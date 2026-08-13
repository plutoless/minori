import { execFileSync } from 'node:child_process';

const generated = [
  'scripts/lark-contract-knowledge-validator.js',
  'scripts/lark-contract-meeting-validator.js',
  'scripts/lark-contract-runner-validator.js',
];

const changed = execFileSync('git', ['diff', '--name-only', '--', ...generated], {
  encoding: 'utf8',
}).trim();
if (changed) {
  process.stderr.write('lark_contract_validators_stale\n');
  process.exitCode = 1;
}
