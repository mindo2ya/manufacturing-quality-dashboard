const { execFileSync, spawnSync } = require('node:child_process');

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

const result = spawnSync('npx --yes @google/clasp@3.4.1 run setup', {
  shell: true,
  encoding: 'utf8',
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
let response;
try {
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd >= jsonStart) {
    response = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
  }
} catch {
  response = undefined;
}

if (response?.ok === true && response.data?.sheetUrl && response.data?.folderUrl) {
  console.log('시트와 사진 폴더를 준비했습니다.');
  console.log(`시트: ${response.data.sheetUrl}`);
  console.log(`폴더: ${response.data.folderUrl}`);
} else if (response?.ok === false && typeof response.error === 'string') {
  console.log(response.error);
  process.exitCode = 1;
} else {
  console.log('Google에 연결하지 못했습니다. 인터넷 연결과 권한 승인(npm.cmd run gas:open)을 확인하세요.');
  process.exitCode = 1;
}