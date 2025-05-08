#!/usr/bin/env node

const fs   = require('fs');
const path = require('path');
const fg   = require('fast-glob');

/**
 * Print usage instructions and exit.
 */
function printUsage() {
  console.error(
    `Usage: gen-exports.js <buildDir> [-i e1,name2,...] [-p path/to/package.json]`
  );
  process.exit(1);
}

/**
 * Parse CLI arguments into structured options.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ buildDirArg: string, excludeNames: string[], pkgPathArg?: string }}
 */
function parseCliArgs(argv) {
  if (argv.length < 1) printUsage();

  const buildDirArg = argv[0];
  let excludeNames  = [];
  let pkgPathArg;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '-i' || arg === '--exclude') && argv[i + 1]) {
      excludeNames = argv[++i]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else if ((arg === '-p' || arg === '--pkg') && argv[i + 1]) {
      pkgPathArg = argv[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
    }
  }

  return { buildDirArg, excludeNames, pkgPathArg };
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
    // stop if we've reached the specified root or filesystem root
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
  const cwd            = process.cwd();
  const buildPath      = path.resolve(cwd, buildDirArg);
  const rootPkgPath    = path.join(cwd, 'package.json');

  // ensure our build folder actually exists
  if (!fs.existsSync(buildPath) || !fs.statSync(buildPath).isDirectory()) {
    console.error(`Error: build directory not found or not a directory: ${buildPath}`);
    process.exit(1);
  }

  // choose package.json
  let pkgPath;
  if (pkgPathArg) {
    // explicit override
    pkgPath = path.resolve(cwd, pkgPathArg);
    if (!fs.existsSync(pkgPath)) {
      console.error(`Error: package.json not found at override path: ${pkgPath}`);
      process.exit(1);
    }
  } else {
    // auto-detect nearest package.json above build folder
    const found = findNearestPackageJson(buildPath, cwd);
    pkgPath = found || rootPkgPath;
    if (!fs.existsSync(pkgPath)) {
      console.error(`Error: could not locate any package.json (tried ${buildPath} → ${cwd})`);
      process.exit(1);
    }
  }

  const pkgDir  = path.dirname(pkgPath);
  const distDir = buildPath;  // we always glob inside the explicit build path

  return { pkgPath, pkgDir, distDir };
}

/**
 * Read and parse a JSON file.
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Write JSON back to disk with 2-space formatting + newline.
 * @param {string} filePath
 * @param {any}     obj
 */
function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Asynchronously list all .js files under distDir.
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
 * Build the "exports" map for package.json given JS files.
 * @param {string[]}    jsFiles       - paths *inside* distDir
 * @param {{ distDir: string, pkgDir: string, excludeNames: string[] }} opts
 * @returns {Record<string,object>}
 */
function buildExportsMap(jsFiles, { distDir, pkgDir, excludeNames }) {
  return jsFiles.reduce((out, jsFile) => {
    const subpath = jsFile.replace(/\.js$/, '');      // e.g. "index" or "lib/foo"
    const name    = path.basename(subpath);           // e.g. "index" or "foo"
    if (excludeNames.includes(name)) return out;      // skip if excluded

    const key   = `./${subpath}`;                     // export key
    const absJs = path.join(distDir, jsFile);         // e.g. /.../packages/iermes/dist/index.js
    const relJs = makeRelativePath(pkgDir, absJs);    // e.g. dist/index.js
    const jsPath= `./${relJs}`;                       // "./dist/index.js"

    // look for accompanying .d.ts
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
 * Main entrypoint: tie everything together.
 */
async function main() {
  const { buildDirArg, excludeNames, pkgPathArg } = parseCliArgs(process.argv.slice(2));

  // pick/build folder and package root
  const { pkgPath, pkgDir, distDir } = resolvePaths(buildDirArg, pkgPathArg);

  // load package.json
  const pkg = readJson(pkgPath);

  // find built JS files
  const jsFiles = await getJsFiles(distDir);

  // construct exports and write back
  pkg.exports = buildExportsMap(jsFiles, { distDir, pkgDir, excludeNames });
  writeJson(pkgPath, pkg);

  console.log(
    `✅ Updated exports in ${pkgPath}\n` +
    `Keys: ${Object.keys(pkg.exports).join(', ')}`
  );
}

// run, catching any uncaught errors
main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
