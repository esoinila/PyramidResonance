#!/usr/bin/env node
// Stamps a release: node scripts/release.js 2.3.0
// Sets BUILD in app.js, VERSION in sw.js and RELEASED (now, UTC) in both, each on exactly
// one line that starts with the constant, then runs every test. Publish only if this ends
// with "Release ... is ready". With --no-browser it skips the slow browser test.
'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');   // --root <dir>: stamp a copy somewhere else (used by the tests)
const root = rootAt >= 0 ? path.resolve(args[rootAt + 1]) : path.join(__dirname, '..');
const version = args[0];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('Usage: node scripts/release.js <major.minor.patch> [--no-browser]'); process.exit(2); }
const released = new Date().toISOString().replace(/:\d\d\.\d+Z$/, ':00Z');

function setConstant(file, name, value) {
    const full = path.join(root, file);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    const pattern = new RegExp('^(\\s*const ' + name + " = ')[^']*(';.*)$");   // the whole line must be the declaration
    const hits = lines.map((line, i) => (pattern.test(line) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) throw new Error(file + ': expected one line declaring ' + name + ', found ' + hits.length);
    lines[hits[0]] = lines[hits[0]].replace(pattern, '$1' + value + '$2');
    fs.writeFileSync(full, lines.join('\n'));
}
function run(cmd, args) {
    console.log('\n> ' + cmd + ' ' + args.join(' '));
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) { console.error('\nFAILED: ' + cmd + ' ' + args.join(' ') + '. Do not publish.'); process.exit(1); }
}

setConstant('app.js', 'BUILD', version);
setConstant('sw.js', 'VERSION', version);
setConstant('app.js', 'RELEASED', released);
setConstant('sw.js', 'RELEASED', released);
console.log('Stamped ' + version + ', ' + released);
if (args.includes('--stamp-only')) process.exit(0);
// the tests run after the stamp, on exactly the files that will be published
run('node', ['--check', 'app.js']);
run('node', ['--check', 'sw.js']);
run('node', ['--test', 'test/modes.test.js']);
if (!args.includes('--no-browser')) run('python3', ['test/smoke.py']);
console.log('\nRelease ' + version + ' is ready to commit and publish.');
