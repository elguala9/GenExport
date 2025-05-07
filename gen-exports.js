#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

function printUsage() {
  console.error(`Usage: gen-exports.js <buildDir> [-i <name1,name2,...>]`);
  process.exit(1);
}

// Parse CLI arguments
const args = process.argv.slice(2);
if (args.length < 1) printUsage();

const buildDirArg = args[0];
let excludeNames = [];
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '-i' || arg === '--exclude') && args[i + 1]) {
    excludeNames = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
    i++;
  } else {
    console.error(`Unknown argument: ${arg}`);
    printUsage();
  }
}

const projectRoot = process.cwd();
const distDir     = path.resolve(projectRoot, buildDirArg);
const pkgPath     = path.join(projectRoot, 'package.json');

if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
  console.error(`Error: build directory not found or not a directory: ${distDir}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

(async () => {
  // Scan all .js files under dist (including nested dirs)
  const jsFiles = await fg('**/*.js', { cwd: distDir });

  // Build per-file exports, stripping "src/" prefix, skipping excludes
  const exportsMap = jsFiles.reduce((out, jsFile) => {
    const subpath = jsFile.replace(/\.js$/, ''); // e.g. "src/Serialization"
    const baseName = path.basename(subpath);
    if (excludeNames.includes(baseName)) {
      return out;
    }
    const key    = `./${subpath}`;
    const jsPath = `./${buildDirArg}/${jsFile}`;
    const dtsFile = jsFile.replace(/\.js$/, '.d.ts');
    const typesPath = path.join(distDir, dtsFile);

    out[key] = {
      import: jsPath,
      require: jsPath,
      ...(fs.existsSync(typesPath)
        ? { types: `./${buildDirArg}/${dtsFile}` }
        : {})
    };
    return out;
  }, {});

  // Replace exports in package.json
  pkg.exports = exportsMap;

  // Write back
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('✅ package.json exports updated:', Object.keys(pkg.exports).join(', '));
})();
