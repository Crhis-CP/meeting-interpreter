// Stands in for powershell.exe in tests: answers the speech host's lines like the real script.
const fs = require('node:fs');
const { encode } = (() => {
  const encode = (seconds) => {
    const n = Math.round(22050 * seconds);
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24);
    b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(1000, 44 + i * 2);
    return b;
  };
  return { encode };
})();
if (process.argv[2] === 'silent') setInterval(() => {}, 1000);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (process.argv[2] === 'silent') continue;
    if (line.includes("WriteLine('MI_READY')")) { process.stdout.write('MI_READY\r\n'); continue; }
    const id = (line.match(/MI_DONE (\d+)/) || [])[1];
    const p = JSON.parse(line.match(/ConvertFrom-Json '((?:[^']|'')*)'/)[1].replace(/''/g, "'"));
    if (p.voice === 'none') { process.stdout.write(`MI_NO_VOICE ${id}\r\n`); continue; }
    fs.writeFileSync(p.out, encode(0.5));
    process.stdout.write(`MI_DONE ${id}\r\n`);
  }
});
