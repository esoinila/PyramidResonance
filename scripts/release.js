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

// Nothing is written until every constant has been found, so a failure leaves all files as they were.
const files = {};
function lineOf(file, name) {
    if (!files[file]) files[file] = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    const pattern = new RegExp('^(\\s*const ' + name + " = ')([^']*)(';.*)$");   // the whole line must be the declaration
    const hits = files[file].map((line, i) => (pattern.test(line) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) throw new Error(file + ': expected one line declaring ' + name + ', found ' + hits.length);
    return { i: hits[0], pattern, value: files[file][hits[0]].match(pattern)[2] };
}
const plan = [['app.js', 'BUILD', version], ['sw.js', 'VERSION', version], ['app.js', 'RELEASED', released], ['sw.js', 'RELEASED', released]]
    .map(([file, name, value]) => Object.assign({ file, value }, { at: lineOf(file, name) }));
// The cache is named after the version: publishing the same number again would rebuild the cache
// that is in use, and a failed download would then leave the phone with nothing offline.
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
for (const step of plan.slice(0, 2)) {
    if (!newer(version, step.at.value)) { console.error(step.file + ' is already version ' + step.at.value + ': the new version must be higher.'); process.exit(2); }
}
for (const step of plan) files[step.file][step.at.i] = files[step.file][step.at.i].replace(step.at.pattern, '$1' + step.value + '$3');
for (const file of Object.keys(files)) fs.writeFileSync(path.join(root, file), files[file].join('\n'));
function run(cmd, args) {
    console.log('\n> ' + cmd + ' ' + args.join(' '));
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) { console.error('\nFAILED: ' + cmd + ' ' + args.join(' ') + '. Do not publish.'); process.exit(1); }
}

console.log('Stamped ' + version + ', ' + released);
if (args.includes('--stamp-only')) process.exit(0);
// the tests run after the stamp, on exactly the files that will be published
run('node', ['--check', 'app.js']);
run('node', ['--check', 'sw.js']);
run('node', ['--test', 'test/modes.test.js']);
if (!args.includes('--no-browser')) run('python3', ['test/smoke.py']);
console.log('\nRelease ' + version + ' is ready to commit and publish.');
