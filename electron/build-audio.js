const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Compila win-audio.cs em win-audio.exe antes de `npm run app` e `npm run dist`.
// O processo principal usa esse executável para capturar o áudio da janela escolhida.
const source = path.join(__dirname, 'win-audio.cs');
const exe = path.join(__dirname, 'win-audio.exe');

// Pula a compilação quando o .exe já existe e não está mais velho que o .cs.
if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) {
    process.exit(0);
}

// Compilador C# do .NET Framework que já vem no Windows (não exige o SDK).
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// x64, com otimização, referenciando só System.dll. A saída do compilador vai para o terminal.
const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/r:System.dll', `/out:${exe}`, source], { stdio: 'inherit' });

// Repassa o código de saída do csc. Se o processo nem chegou a rodar, sai com 1.
process.exit(result.status ?? 1);
