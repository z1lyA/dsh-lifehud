/**
 * 路径推导小工具：仓库里不写任何人的绝对路径，能推导的一律推导。
 */
import { join } from 'node:path';

/* ------------------------------------------------- 默认路径（不写死用户名） */

/**
 * LifeHud 不把任何人的绝对路径写进仓库：能推导的一律推导。
 * Windows 的 `%APPDATA%` / `%LOCALAPPDATA%` 已经指向 `C:\Users\<你>\AppData\…`。
 */
const envPath = (...parts) => {
  const root = parts.shift();
  return root ? join(root, ...parts) : '';
};
export { envPath };
