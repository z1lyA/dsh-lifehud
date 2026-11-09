// 本机路径推导：spike 脚本共用。仓库里不写任何人的绝对路径。
// 需要覆盖时用环境变量：LIFEHUD_DATA_DIR / LIFEHUD_MI_SESSION / LIFEHUD_MI_DID。
import { join } from 'node:path';
import { homedir } from 'node:os';

const appData = (...parts) => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), ...parts);
const localAppData = (...parts) => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), ...parts);

/** LifeHud 自己的可写目录（与 plugin/index.js 的默认值一致）。 */
export const DATA_DIR = process.env.LIFEHUD_DATA_DIR || join(homedir(), '.dsh', 'lifehud');
/** DSH 的家目录。 */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
/** NowTree 的 SQLite / WebView2 localStorage。 */
export const NOWTREE_DB = appData('com.nowtree.app', 'nowtree.sqlite');
export const NOWTREE_LEVELDB = localAppData('com.nowtree.app', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
/** 体重镜像库与小米云会话文件。 */
export const WEIGHT_DB = join(DATA_DIR, 'lifehud-weight.db');
export const MI_SESSION = process.env.LIFEHUD_MI_SESSION || join(DATA_DIR, 'mi-session.json');
