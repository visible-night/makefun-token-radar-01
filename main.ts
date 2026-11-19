// Token Radar v2 — the entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, builds the radar with lib/model.ts, and writes
// the graded output: board.json, the dashboard's data.js, the dashboard and
// its screenshots, and dossier.json from the vendored make.fun library.
// Deterministic: the same snapshot always writes the same bytes, so the
// grader's two runs agree.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll, checkBoard, dataScript, modelCardScript, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** A `--flag value` or `--flag=value` argument, else the fallback. */
function flagValue(argv: string[], flag: string, fallback: string): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${flag}` && i + 1 < argv.length) return argv[i + 1]!;
    if (a.startsWith(`--${flag}=`)) return a.slice(flag.length + 3);
  }
  return fallback;
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

/** The regular files of one flat directory, copied into `dest`, dotfiles skipped. */
function copyFlat(from: string, dest: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(dest, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(dest, name));
    names.push(name);
  }
  return names;
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputArg = flagValue(argv, 'input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
  }
  const out = flagValue(argv, 'output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = readSnapshot(readFileSync(inputFile, 'utf8'));
  const built = buildAll(snapshot);
  const issue = checkBoard(built.board, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: built.board })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(built.data));

  const pageFiles = copyFlat(join(repoRoot, 'dashboard'), join(out, 'dashboard'));
  writeFileSync(join(out, 'dashboard', 'model.js'), modelCardScript(built.modelCard));
  const shots = copyFlat(join(repoRoot, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3 or 4, the board, a detail view and a filtered view`);
  }
  const badName = shots.find((n) => !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(n));
  if (badName !== undefined) fail(`screenshots/${badName}: a name is letters, digits and . _ -, 1 to 128 characters`);

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  const dossier = buildDossier(out, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  });
  writeFileSync(join(out, 'dossier.json'), dossier);

  const v = built.validation;
  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${built.board.length} rows ranked\n` +
      `token radar: curve on ${v.comps} comps, leave-one-out ${v.looModel.toFixed(2)}x vs flat ${v.looFlat.toFixed(2)}x, walk-forward ${v.wfModel.toFixed(2)}x vs flat ${v.wfFlat.toFixed(2)}x\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${pageFiles.length + 1} files), ${join(out, 'screenshots')} (${shots.length} images), ${join(out, 'dossier.json')} (${dossier.length} bytes)\n`,
  );
}

main();
