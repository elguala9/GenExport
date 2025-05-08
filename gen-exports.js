#!/usr/bin/env node

const fs   = require('fs');
const path = require('path');
const fg   = require('fast-glob');

function printUsage() {
  console.error(
    `Usage: gen-exports.js <buildDir> [-i e1,name2,...] [-p path/to/package.json]`
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) printUsage();

// first positional is the build output directory, relative to your package
const buildDirArg = args[0];

let excludeNames = [];
let pkgPathArg;

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '-i' || arg === '--exclude') && args[i + 1]) {
    excludeNames = args[++i]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  } else if ((arg === '-p' || arg === '--pkg') && args[i + 1]) {
    pkgPathArg = args[++i];
  } else {
    console.error(`Unknown argument: ${arg}`);
    printUsage();
  }
}

// resolve where the package.json lives
const cwd            = process.cwd();
const defaultPkgPath = path.join(cwd, 'package.json');
const pkgPath        = pkgPathArg
  ? path.resolve(cwd, pkgPathArg)
  : defaultPkgPath;

if (!fs.existsSync(pkgPath)) {
  console.error(`Error: package.json not found at ${pkgPath}`);
  process.exit(1);
}

const pkgDir  = path.dirname(pkgPath);
const distDir = path.resolve(pkgDir, buildDirArg);

if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
  console.error(`Error: build directory not found or not a directory: ${distDir}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

(async () => {
  // find all .js in your dist
  const jsFiles = await fg('**/*.js', { cwd: distDir });

  const exportsMap = jsFiles.reduce((out, jsFile) => {
    const subpath = jsFile.replace(/\.js$/, '');
    const name    = path.basename(subpath);
    if (excludeNames.includes(name)) return out;

    // key is ./<subpath>
    const key = `./${subpath}`;

    // compute import/require path *relative to pkgDir*
    const absJs    = path.join(distDir, jsFile);
    const relJs    = path.relative(pkgDir, absJs).replace(/\\/g, '/');
    const jsPath   = `./${relJs}`;

    // if there's a .d.ts alongside, include types
    const dtsFile = jsFile.replace(/\.js$/, '.d.ts');
    const absDts  = path.join(distDir, dtsFile);
    const types   = fs.existsSync(absDts)
      ? { types: `./${path.relative(pkgDir, absDts).replace(/\\/g, '/')}` }
      : {};

    out[key] = {
      import:  jsPath,
      require: jsPath,
      ...types
    };

    return out;
  }, {});

  // write back
  pkg.exports = exportsMap;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log(
    '✅ Updated exports in', pkgPath,
    '\nKeys:', Object.keys(exportsMap).join(', ')
  );
})();
