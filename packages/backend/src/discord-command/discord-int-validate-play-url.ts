/** Validate Stage F test audio URL against media URL policy (no network fetch of Discord). */
import { validateUrl } from '../utils/url-validator.js';

async function main(): Promise<void> {
  const url = process.argv[2] || 'http://127.0.0.1:18080/stage-f-test-tone.wav';
  const result = await validateUrl(url);
  console.log(JSON.stringify({ url, valid: result.valid, error: result.error ?? null }));
  if (!result.valid) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
