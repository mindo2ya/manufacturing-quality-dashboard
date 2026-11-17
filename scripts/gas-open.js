const { execFileSync, spawn } = require('node:child_process');

let webAppUrl = process.env.GAS_WEBAPP_URL;
if (!webAppUrl) {
  try {
    webAppUrl = execFileSync(
      process.execPath,
      ['--env-file-if-exists=.env', '-e', 'process.stdout.write(process.env.GAS_WEBAPP_URL || "")'],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
  } catch {
    webAppUrl = '';
  }
}

if (!webAppUrl) {
  console.log('.env에 웹앱 주소가 없습니다. 먼저 npm.cmd run gas:deploy를 실행하세요.');
  process.exit(1);
}

const separator = webAppUrl.includes('?') ? '&' : '?';
const url = `${webAppUrl}${separator}authuser=0`;
const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
const child = spawn(opener, args, { detached: true, stdio: 'ignore', windowsHide: true });
child.on('error', () => {
  console.log('브라우저를 열지 못했습니다. 기본 브라우저를 확인하세요.');
  process.exitCode = 1;
});
child.unref();