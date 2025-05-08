#!/usr/bin/env node

const fs   = require('fs');
const path = require('path');
const fg   = require('fast-glob');

/**
 * Print usage instructions and exit.
 */
function printUsage() {
  console.error(
    `Usage: gen-exports.js <buildDir> [-i e1,name2,...] [-p path/to/package.json] [-e placeholder]`
  );
  process.exit(1);
}

/**
 * Parse CLI arguments into structured options.
 */
function parseCliArgs(argv) {
  if (argv.length < 1) printUsage();

  const buildDirArg = argv[0];
  let excludeNames  = [];
  let pkgPathArg;
  let placeholder   = '$RESERVED$';  // default placeholder

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '-i' || arg === '--exclude') && argv[i + 1]) {
      excludeNames = argv[++i]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else if ((arg === '-p' || arg === '--pkg') && argv[i + 1]) {
      pkgPathArg = argv[++i];
    } else if ((arg === '-e' || arg === '--exclude-placeholder') && argv[i + 1]) {
      placeholder = argv[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
    }
  }

  return { buildDirArg, excludeNames, pkgPathArg, placeholder };
}

/**
 * Find nearest package.json above a folder.
 */
function findNearestPackageJson(startDir, rootDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === rootDir || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolve buildDir, package.json path & its directory.
 */
function resolvePaths(buildDirArg, pkgPathArg) {
  const cwd         = process.cwd();
  const buildPath   = path.resolve(cwd, buildDirArg);
  const rootPkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(buildPath) || !fs.statSync(buildPath).isDirectory()) {
    console.error(`Error: build directory not found or not a directory: ${buildPath}`);
    process.exit(1);
  }

  let pkgPath;
  if (pkgPathArg) {
    pkgPath = path.resolve(cwd, pkgPathArg);
    if (!fs.existsSync(pkgPath)) {
      console.error(`Error: package.json not found at override path: ${pkgPath}`);
      process.exit(1);
    }
  } else {
    const found = findNearestPackageJson(buildPath, cwd);
    pkgPath = found || rootPkgPath;
    if (!fs.existsSync(pkgPath)) {
      console.error(`Error: could not locate any package.json (tried ${buildPath} → ${cwd})`);
      process.exit(1);
    }
  }

  return { pkgPath, pkgDir: path.dirname(pkgPath), distDir: buildPath };
}

/**
 * Read+parse JSON from disk.
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Write object as JSON (2-space + newline).
 */
function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * List all .js and .d.ts files under distDir.
 */
async function getDistFiles(distDir) {
  return fg(['**/*.js', '**/*.d.ts'], { cwd: distDir });
}

/**
 * Normalize an absolute path to a ./relative/from/pkgDir.
 */
function makeRelativePath(pkgDir, absolutePath) {
  return path.relative(pkgDir, absolutePath).replace(/\\/g, '/');
}

/**
 * Build exports map, grouping .js + .d.ts by base name.
 *
 * - Skips any base if the chosen file (js if present, else d.ts)
 *   contains the placeholder.
 * - Emits import/require only if .js exists.
 * - Emits types if .d.ts exists.
 */
function buildExportsMap(files, { distDir, pkgDir, excludeNames, placeholder }) {
  // 1) Group by base name
  const grouped = files.reduce((acc, file) => {
    let base, ext;
    if (file.endsWith('.js')) {
      base = file.slice(0, -3);
      ext  = 'js';
    } else if (file.endsWith('.d.ts')) {
      base = file.slice(0, -5);
      ext  = 'dts';
    } else {
      return acc;
    }
    acc[base] = acc[base] || {};
    acc[base][ext] = file;
    return acc;
  }, {});

  // 2) Build the exports entries
  const exportsMap = {};
  for (const base in grouped) {
    const name  = path.basename(base);
    if (excludeNames.includes(name)) continue;

    const { js: jsFile, dts: dtsFile } = grouped[base] || {};

    // i could have only js or only .d.ts
    if (jsFile !== undefined && checkReserved(jsFile, distDir, placeholder)) 
      continue;
    if (dtsFile !== undefined && checkReserved(dtsFile, distDir, placeholder)) 
      continue;

    const key   = `./${base}`;
    const entry = {};

    // import/require only when we have a .js
    if (jsFile) {
      const absJs = path.join(distDir, jsFile);
      const relJs = makeRelativePath(pkgDir, absJs);
      entry.import  = `./${relJs}`;
      entry.require = `./${relJs}`;
    }

    // types whenever we have a .d.ts
    if (dtsFile) {
      const absDts = path.join(distDir, dtsFile);
      const relDts = makeRelativePath(pkgDir, absDts);
      entry.types   = `./${relDts}`;
    }

    exportsMap[key] = entry;
  }

  return exportsMap;
}

function checkReserved(fileToCheck, distDir, placeholder){

    const absToCheck  = path.join(distDir, fileToCheck);
    const content     = fs.readFileSync(absToCheck, 'utf8');

    if (content.includes(placeholder)) {
      console.warn(`⚠️  Skipping ${fileToCheck} (found placeholder "${placeholder}")`);
      return true;
    }
    return false;
}

/**
 * Main entrypoint.
 */
async function main() {
  const { buildDirArg, excludeNames, pkgPathArg, placeholder } =
    parseCliArgs(process.argv.slice(2));

  const { pkgPath, pkgDir, distDir } = resolvePaths(buildDirArg, pkgPathArg);
  const pkg                          = readJson(pkgPath);
  const files                        = await getDistFiles(distDir);

  pkg.exports = buildExportsMap(files, {
    distDir,
    pkgDir,
    excludeNames,
    placeholder
  });

  writeJson(pkgPath, pkg);

  console.log(
    `✅ Updated exports in ${pkgPath}\n` +
    `Keys: ${Object.keys(pkg.exports).join(', ')}`
  );
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
