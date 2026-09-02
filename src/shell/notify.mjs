// Desktop notification, cross-platform, best-effort and silent on failure.
// Silenced with OMC_LOOP_NO_NOTIFY=1 (tests, headless, CI).
import { spawnSync } from 'node:child_process';
import { boolEnv } from './util.mjs';

function resolvePowerShell() {
  try { return spawnSync('where', ['pwsh'], { stdio: 'ignore', timeout: 4000 }).status === 0 ? 'pwsh' : 'powershell'; }
  catch { return 'powershell'; }
}

export function notify(title, msg, { env = process.env, timeoutMs = 8000 } = {}) {
  if (boolEnv(env.OMC_LOOP_NO_NOTIFY)) return false;
  const t = Math.max(1000, Math.min(timeoutMs, 8000));
  try {
    if (process.platform === 'win32') {
      const q = (x) => String(x).replace(/'/g, "''");
      const ps = `try { Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${q(title)}','${q(msg)}' | Out-Null } catch { [console]::beep(880,200) }`;
      spawnSync(resolvePowerShell(), ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: t, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      const q = (x) => String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      spawnSync('osascript', ['-e', `display notification "${q(msg)}" with title "${q(title)}"`], { timeout: Math.min(t, 5000), stdio: 'ignore' });
    } else {
      spawnSync('notify-send', [title, msg], { timeout: Math.min(t, 5000), stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}
