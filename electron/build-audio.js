const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, 'win-audio.cs');
const exe = path.join(__dirname, 'win-audio.exe');
if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) {
    process.exit(0);
}

const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/r:System.dll', `/out:${exe}`, source], { stdio: 'inherit' });
process.exit(result.status ?? 1);
