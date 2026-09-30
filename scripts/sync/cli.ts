import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { remoteAdapters } from './adapters';
import { syncVault } from './engine';
import { parseVault } from './parser';
import { inspectSnapshot } from './inspect';

function usage(): never {
  console.log('Usage: npm run sync -- --vault <fragmentbox directory> [--inspect | --apply] [--allow-empty] [--max-articles <count>] [--gc]');
  process.exit(0);
}

function args() {
  let vault: string | undefined;
  let apply = false;
  let allowEmpty = false;
  let gc = false;
  let inspect = false;
  let maxArticles: number | undefined;
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === '--help') usage();
    if (arg === '--apply') apply = true;
    else if (arg === '--inspect') inspect = true;
    else if (arg === '--allow-empty') allowEmpty = true;
    else if (arg === '--gc') gc = true;
    else if (arg === '--vault') vault = process.argv[++index];
    else if (arg === '--max-articles') maxArticles = Number(process.argv[++index]);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!vault) throw new Error('--vault is required');
  if (inspect && (apply || gc)) throw new Error('--inspect cannot be combined with --apply or --gc');
  if (maxArticles !== undefined && (!Number.isSafeInteger(maxArticles) || maxArticles < 1)) {
    throw new Error('--max-articles must be a positive integer');
  }
  return { vault: resolve(vault), apply, allowEmpty, maxArticles, gc, inspect };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function currentCommit(vault: string): string {
  return execFileSync('git', ['-C', vault, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function assertCleanVault(vault: string): void {
  const status = execFileSync('git', ['-C', vault, 'status', '--porcelain', '--untracked-files=all', '--', '.'],
    { encoding: 'utf8' });
  if (status.trim()) throw new Error('vault contains changes not represented by the target Git commit');
}

async function isAncestor(vault: string, previous: string, target: string): Promise<boolean> {
  const result = spawnSync('git', ['-C', vault, 'merge-base', '--is-ancestor', previous, target]);
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('cannot check Git commit ancestry');
}

async function main() {
  const options = args();
  const commitSha = currentCommit(options.vault);
  assertCleanVault(options.vault);
  const snapshot = await parseVault(options.vault);
  if (commitSha !== currentCommit(options.vault)) throw new Error('target Git commit changed during vault parsing');
  assertCleanVault(options.vault);
  if (options.inspect) {
    console.log(JSON.stringify({ mode: 'local-inspect', ...inspectSnapshot(snapshot) }, null, 2));
    return;
  }
  const adapters = remoteAdapters({
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    databaseId: required('D1_DATABASE_ID'),
    apiToken: required('CLOUDFLARE_API_TOKEN'),
    bucketName: required('R2_BUCKET_NAME'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
  });
  const summary = await syncVault(snapshot, {
    ...adapters,
    isAncestor: (previous, target) => isAncestor(options.vault, previous, target),
  }, { commitSha, apply: options.apply, allowEmpty: options.allowEmpty, maxArticles: options.maxArticles, gc: options.gc });
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', ...summary }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'sync failed');
  process.exitCode = 1;
});
