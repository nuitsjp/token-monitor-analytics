import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function run(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`)));
    });
}
// npm.cmd は cmd.exe を要する。引数はすべて本リポジトリのスクリプトが固定した値であり、shell: true と引数配列の併用（DEP0190）は避ける。
export const npm = (...args) => process.platform === 'win32'
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`])
    : run('npm', args);
