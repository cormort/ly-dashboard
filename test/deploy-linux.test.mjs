import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Linux VM 的部署產物（deploy/linux/）。
 *
 * 這裡只驗「不需要 systemd、也不需要 Linux 就能查」的部分：樣板的必要指令、placeholders 有沒有被替換乾淨、
 * 腳本語法。真的 systemd 語法由 CI 的 deploy-linux job 跑 `systemd-analyze verify`（見 .github/workflows/ci.yml），
 * 真的 VM 上的行為則靠 `deploy/linux/verify-vm.sh`。
 *
 * 為什麼要在這裡釘住：這三份 unit 是「搬到 VM 時唯一要改的東西」，改壞了的症狀是服務起不來、
 * 而且只有真的在 VM 上才會發現（這台開發機是 macOS，沒有 systemd）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(ROOT, 'deploy', 'linux');
const SERVER_UNIT = 'ly-dashboard-server.service';
const FB_UNIT = 'ly-dashboard-fb-daily.service';
const FB_TIMER = 'ly-dashboard-fb-daily.timer';

const template = (name) => readFileSync(join(DEPLOY, name), 'utf8');

/**
 * 有沒有可以跑 bash 的環境（Windows 的 CI 沒有）。
 * Windows 的 runner 其實有 Git Bash，但那裡的 `bash` 跑 deploy/linux 的腳本意義不大
 * （那支腳本是寫給 Linux 的，路徑與 getent 都不一樣），而且會讓 `npm test` 在 Windows 紅掉 ——
 * 這一塊由 CI 的 deploy-linux job（ubuntu）負責，Windows 只跑上面的文字層斷言。
 */
function hasBash() {
  return process.platform !== 'win32' && !spawnSync('bash', ['-c', 'exit 0']).error;
}

test('deploy：三份 systemd 樣板都在（服務＋抓取＋timer）', () => {
  for (const f of [SERVER_UNIT, FB_UNIT, FB_TIMER]) {
    assert.ok(existsSync(join(DEPLOY, f)), `缺少 deploy/linux/${f}`);
  }
  assert.ok(existsSync(join(DEPLOY, 'install.sh')));
  assert.ok(existsSync(join(DEPLOY, 'verify-vm.sh')));
  assert.ok(existsSync(join(ROOT, 'docs', 'DEPLOY-VM.md')), '部署說明要在 docs/DEPLOY-VM.md');
});

test('deploy：伺服器 unit 的行為與 macOS 版一對一（重啟、時區、可覆寫的環境檔）', () => {
  const unit = template(SERVER_UNIT);
  // launchd 的 KeepAlive SuccessfulExit=false ↔ systemd Restart=on-failure
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=/m);
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^ExecStart=__NODE__ server\/index\.mjs$/m);
  assert.match(unit, /^WorkingDirectory=__ROOT__$/m);
  assert.match(unit, /^User=__USER__$/m);
  assert.match(unit, /^Environment=TZ=Asia\/Taipei$/m);
  // 環境變數要能從 repo 外覆寫（`-`＝檔案不存在也不能讓服務起不來）
  assert.match(unit, /^EnvironmentFile=-__HOME__\/\.ly-dashboard\/server\.env$/m);
  // CPU 密集端點的保護（macOS 的 ProcessType=Background 教訓）
  assert.match(unit, /^CPUWeight=/m);
  assert.match(unit, /^StandardOutput=journal$/m);
});

test('deploy：抓取 timer 要有 Persistent=true（＝launchd 睡著會補跑的行為）', () => {
  const timer = template(FB_TIMER);
  assert.match(timer, /^OnCalendar=\*-\*-\* 08:00:00$/m);
  assert.match(timer, /^Persistent=true$/m, 'Persistent=true 是「關機／休眠錯過要補跑」的唯一來源');
  assert.match(timer, new RegExp(`^Unit=${FB_UNIT.replace('.', '\\.')}$`, 'm'));
  assert.match(timer, /^WantedBy=timers\.target$/m);

  const service = template(FB_UNIT);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=__NODE__ scripts\/fb-daily\.mjs$/m);
  assert.match(service, /^TimeoutStartSec=/m, '一輪 25–35 分鐘，要有逾時上限');
});

test('deploy：install.sh 的替換不會留下佔位符（不需要 systemd 也能驗）', { skip: !hasBash() }, () => {
  const out = mkdtempSync(join(tmpdir(), 'ly-units-'));
  const nodeBin = process.execPath; // 用「真的存在」的 node，否則 install.sh 會（正確地）拒絕
  execFileSync('bash', [
    join(DEPLOY, 'install.sh'),
    '--render-dir', out,
    '--with-fb',
    '--node', nodeBin,
    '--user', 'someone',
    '--root', ROOT,
    '--port', '8787',
  ], { cwd: ROOT, stdio: 'pipe' });

  const files = readdirSync(out);
  for (const f of [SERVER_UNIT, FB_UNIT, FB_TIMER]) assert.ok(files.includes(f), `沒有產出 ${f}`);
  for (const f of files) {
    const body = readFileSync(join(out, f), 'utf8');
    assert.ok(!body.includes('__'), `${f} 還有沒被替換的佔位符`);
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rendered = readFileSync(join(out, SERVER_UNIT), 'utf8');
  assert.match(rendered, new RegExp(`^ExecStart=${esc(nodeBin)} server/index\\.mjs$`, 'm'));
  assert.match(rendered, new RegExp(`^WorkingDirectory=${esc(ROOT)}$`, 'm'));
  assert.match(rendered, /^User=someone$/m);
  assert.match(rendered, /^Environment=PORT=8787$/m);
});

test('deploy：安裝腳本語法正確（bash -n）', { skip: !hasBash() }, () => {
  for (const f of ['install.sh', 'verify-vm.sh', 'bootstrap-no-fb.sh']) {
    execFileSync('bash', ['-n', join(DEPLOY, f)], { stdio: 'pipe' });
  }
});

test('deploy：verify-vm.sh 有 --live（機房 IP 的來源可達性必須實測，不能只靠推論）', () => {
  const script = readFileSync(join(DEPLOY, 'verify-vm.sh'), 'utf8');
  assert.match(script, /--live/);
  assert.match(script, /data\.ly\.gov\.tw|CONFIG\.endpoints\.id9/);
  assert.match(script, /tailscale/, '對外方式要檢查 Tailscale（PWA 需要安全來源）');
});
