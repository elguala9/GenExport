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
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{
 *   buildDirArg: string,
 *   excludeNames: string[],
 *   pkgPathArg?: string,
 *   placeholder: string
 * }}
 */
function parseCliArgs(argv) {
  if (argv.length < 1) printUsage();

  const buildDirArg = argv[0];
  let excludeNames  = [];
  let pkgPathArg;
  let placeholder   = '$RESERVED$';  // default

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
 * Walk upwards from `startDir` to `rootDir`, returning the
 * first package.json path found (or null if none).
 * @param {string} startDir
 * @param {string} rootDir
 * @returns {string|null}
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
 * Determine which package.json to use, plus validate build folder.
 * @param {string} buildDirArg
 * @param {string=} pkgPathArg
 * @returns {{ pkgPath: string, pkgDir: string, distDir: string }}
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

  const pkgDir  = path.dirname(pkgPath);
  const distDir = buildPath;

  return { pkgPath, pkgDir, distDir };
}

/**
 * Read and parse JSON from disk.
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Write object as JSON to disk (2-space + newline).
 * @param {string} filePath
 * @param {any} obj
 */
function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Get all .js files under distDir.
 * @param {string} distDir
 * @returns {Promise<string[]>}
 */
async function getJsFiles(distDir) {
  return fg('**/*.js', { cwd: distDir });
}

/**
 * Normalize an absolute path into a ./relative/from/pkgDir.
 * @param {string} pkgDir
 * @param {string} absolutePath
 * @returns {string}
 */
function makeRelativePath(pkgDir, absolutePath) {
  return path.relative(pkgDir, absolutePath).replace(/\\/g, '/');
}

/**
 * Build the "exports" map, skipping any file whose content
 * includes the given placeholder or whose basename is excluded.
 *
 * @param {string[]} jsFiles              - list of paths inside distDir
 * @param {{
 *   distDir: string,
 *   pkgDir: string,
 *   excludeNames: string[],
 *   placeholder: string
 * }} opts
 * @returns {Record<string,object>}
 */
function buildExportsMap(jsFiles, { distDir, pkgDir, excludeNames, placeholder }) {
  return jsFiles.reduce((out, jsFile) => {
    const subpath = jsFile.replace(/\.js$/, '');
    const name    = path.basename(subpath);

    // Skip by name
    if (excludeNames.includes(name)) return out;

    const absJs = path.join(distDir, jsFile);

    // Skip if file contains placeholder
    const content = fs.readFileSync(absJs, 'utf8');
    if (content.includes(placeholder)) {
      console.warn(`⚠️  Skipping ${jsFile} (found placeholder "${placeholder}")`);
      return out;
    }

    // Build entry
    const key    = `./${subpath}`;
    const relJs  = makeRelativePath(pkgDir, absJs);
    const jsPath = `./${relJs}`;

    // Look for .d.ts next to it
    const dtsFile = jsFile.replace(/\.js$/, '.d.ts');
    const absDts  = path.join(distDir, dtsFile);
    const types   = fs.existsSync(absDts)
      ? { types: `./${makeRelativePath(pkgDir, absDts)}` }
      : {};

    out[key] = { import: jsPath, require: jsPath, ...types };
    return out;
  }, {});
}

/**
 * Main entrypoint.
 */
async function main() {
  const { buildDirArg, excludeNames, pkgPathArg, placeholder } =
    parseCliArgs(process.argv.slice(2));

  const { pkgPath, pkgDir, distDir } = resolvePaths(buildDirArg, pkgPathArg);
  const pkg                          = readJson(pkgPath);
  const jsFiles                      = await getJsFiles(distDir);

  pkg.exports = buildExportsMap(jsFiles, {
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
