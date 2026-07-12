// WSL2-only: grabs whatever image is on the Windows clipboard via
// powershell.exe interop and saves it to a real file an agent CLI can be
// pointed at. Contreex is headless/non-interactive (one CLI invocation, not
// a REPL you paste into) — this exists because the user's actual workflow is
// "screenshot -> Ctrl+V" in an interactive terminal, and there's no paste
// event to intercept here; instead this reads the same OS clipboard
// powershell.exe already has access to and turns it into a file path.

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec } from './exec.mjs';

export class ClipboardError extends Error {}

const POWERSHELL = 'powershell.exe';

// PNG bytes via .NET's Clipboard/Bitmap classes — Add-Type loads both
// assemblies explicitly since PowerShell doesn't always pull in
// System.Drawing as a side effect of System.Windows.Forms.
const GRAB_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output 'NO_IMAGE'; exit 0 }
$img = [System.Windows.Forms.Clipboard]::GetImage();
$path = Join-Path $env:TEMP ('contreex-clipboard-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.png');
$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png);
Write-Output $path;
`.trim();

async function runPowershell(script) {
  let r;
  try {
    r = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000 });
  } catch (e) {
    throw new ClipboardError(`Could not reach powershell.exe — --from-clipboard only works under WSL2 with Windows interop enabled: ${e.message}`);
  }
  if (!r.ok) throw new ClipboardError(`powershell.exe failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/**
 * Saves the current Windows clipboard image to `destDir` as a PNG and
 * returns its absolute (WSL-visible) path. Throws ClipboardError if there's
 * no image on the clipboard right now, or if powershell.exe isn't reachable.
 */
export async function saveClipboardImage(destDir) {
  const winPath = await runPowershell(GRAB_SCRIPT);
  if (!winPath || winPath === 'NO_IMAGE') {
    throw new ClipboardError('No image found on the Windows clipboard — take a screenshot first, then run again.');
  }

  const wslPathResult = await exec('wslpath', ['-u', winPath], { timeout: 5_000 });
  if (!wslPathResult.ok) {
    throw new ClipboardError(`wslpath could not translate '${winPath}': ${wslPathResult.stderr.trim()}`);
  }
  const sourcePath = wslPathResult.stdout.trim();

  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const destPath = join(destDir, `clipboard-${Date.now()}.png`);

  const copyResult = await exec('cp', [sourcePath, destPath], { timeout: 5_000 });
  if (!copyResult.ok) throw new ClipboardError(`Failed to copy clipboard image from '${sourcePath}' to '${destPath}': ${copyResult.stderr.trim()}`);

  return destPath;
}
