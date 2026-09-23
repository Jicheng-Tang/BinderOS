import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

// Report filenames only, never the matched credentials. Scan new files as well.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const keyPattern = new RegExp('s' + 'k-' + '[A-Za-z0-9]{16,}');
const assignmentPattern = new RegExp('(?:' + ['DEEPSEEK_API_KEY', 'MODEL_GATEWAY_TOKEN'].join('|') + ')\\s*=\\s*[\x27\x22]?[A-Za-z0-9_-]{16,}');
const suspicious = [...new Set(files)].filter(file => {
  if (file.endsWith('.example') || !statSync(file).isFile()) return false;
  const text = readFileSync(file, 'utf8');
  return keyPattern.test(text) || assignmentPattern.test(text);
});
if (suspicious.length) {
  console.error('Potential credentials found in: ' + suspicious.join(', '));
  process.exit(1);
}
console.log('Credential pattern check passed (not a comprehensive secret audit).');
