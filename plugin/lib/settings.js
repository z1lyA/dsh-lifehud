/** Host 侧设置文件（lifehud-settings.json）：只存 latitude/longitude/locationName/appAliases。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} dir @returns {object} settings */
function readSettingsFile(dir) {
  if (!dir) return {};
  try {
    return JSON.parse(readFileSync(join(dir, 'lifehud-settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** @param {string} dir @param {object} patch @returns {object} merged */
function mergeSettingsFile(dir, patch) {
  const current = readSettingsFile(dir);
  const merged = { ...current, ...patch };
  writeFileSync(join(dir, 'lifehud-settings.json'), JSON.stringify(merged, null, 2));
  return merged;
}
export { readSettingsFile, mergeSettingsFile };
