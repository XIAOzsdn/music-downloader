'use strict';

/**
 * 音乐下载器 · main 入口（Node 主进程）
 *
 * 职责：把渲染端（client.mjs）传来的音频地址下载为文件，写入系统下载目录
 * （api.paths.downloads，即用户的「下载」文件夹）。
 *
 * 下载流程：流式写入临时 .part 文件 → 校验成功 → 按内容类型确定扩展名 →
 * 重命名为「歌手 - 歌名.ext」（重名自动加序号）→ 返回最终路径。
 * 任一步失败都会清理残留的 .part 文件，绝不留下半个文件。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------------------
// 可调参数集中区（非开发人员如需调整请改为 api.storage 配置化；见 mods/README）
// ---------------------------------------------------------------------------
const CONFIG = Object.freeze({
  /** 跟随重定向的最大次数。 */
  MAX_REDIRECTS: 5,
  /** 建连/首字节超时（毫秒）。 */
  SOCKET_TIMEOUT_MS: 30_000,
  /** 下载中途空闲超时（毫秒）。 */
  IDLE_TIMEOUT_MS: 30_000,
  /** 请求 User-Agent（部分音源会校验）。 */
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  /** 文件名最长字符数（Windows 路径限制）。 */
  MAX_NAME_LEN: 150,
});

/** 内容类型 → 扩展名（下载时以响应头为准，命中率最高）。 */
const EXT_BY_CONTENT_TYPE = Object.freeze({
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'audio/x-wav': '.wav',
});

/** 内容类型缺失时，从 URL 路径兜底猜测扩展名。 */
const EXT_BY_URL = /\.(mp3|flac|m4a|aac|ogg|wav|webm|opus|wma)(?:$|[?#])/i;

/** 仍无法判断时的兜底扩展名。 */
const FALLBACK_EXT = '.mp3';

/**
 * 解析系统「下载」目录。
 * Folia 0.7.x 的 main API 没有 api.paths，但模组运行在 Electron 主进程里，
 * 可直接向 electron 模块要 app.getPath('downloads')；取不到时退回用户目录下的 Downloads。
 * @param {object} api
 * @returns {string}
 */
const resolveDownloadsDir = (api) => {
  const fromApi = api?.paths?.downloads;
  if (typeof fromApi === 'string' && fromApi) return fromApi;
  try {
    const { app } = require('electron');
    const dir = app.getPath('downloads');
    if (typeof dir === 'string' && dir) return dir;
  } catch {
    // 非 Electron 环境（本地调试）或取路径失败，走下面的兜底。
  }
  return path.join(os.homedir(), 'Downloads');
};

/**
 * 清理文件名中的 Windows 非法字符，并截断长度。
 * @param {string} name
 * @returns {string}
 */
const sanitizeFileName = (name) =>
  String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CONFIG.MAX_NAME_LEN) || 'audio';

/**
 * 依据内容类型（优先）与 URL（兜底）推断文件扩展名。
 * @param {string} url
 * @param {string} contentType
 * @returns {string} 带点的扩展名，如 '.mp3'
 */
const extensionFor = (url, contentType) => {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const fromType = EXT_BY_CONTENT_TYPE[mime];
  if (fromType) return fromType;
  const fromUrl = EXT_BY_URL.exec(String(url));
  if (fromUrl) return '.' + fromUrl[1].toLowerCase();
  return FALLBACK_EXT;
};

/**
 * 在 dir 下生成一个不冲突的路径：`base.ext`、`base (1).ext`、`base (2).ext`…
 * @param {string} dir
 * @param {string} baseName
 * @param {string} ext
 * @returns {Promise<string>}
 */
const uniquePath = async (dir, baseName, ext) => {
  let n = 0;
  for (;;) {
    const candidate = path.join(dir, n === 0 ? `${baseName}${ext}` : `${baseName} (${n})${ext}`);
    try {
      await fs.promises.access(candidate);
      n += 1;
    } catch {
      return candidate;
    }
  }
};

/**
 * 把 http(s) 地址流式下载为 destPath 中的文件。
 * 跟随重定向、处理超时；任何失败都会删除已写入的 destPath。
 * @param {string} url
 * @param {string} destPath
 * @param {number} redirectsLeft
 * @returns {Promise<{ sizeBytes: number, contentType: string }>}
 */
const downloadToFile = (url, destPath, redirectsLeft) =>
  new Promise((resolve, reject) => {
    const client = /^https:/i.test(url) ? https : http;
    const request = client.get(
      url,
      {
        headers: {
          'User-Agent': CONFIG.USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;

        // 重定向：丢弃当前响应体，跟随 Location 递归下载。
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new Error('redirection-limit'));
          const nextUrl = new URL(location, url).toString();
          return downloadToFile(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
        }

        if (status !== 200) {
          response.resume();
          return reject(new Error(`http-status-${status}`));
        }

        const out = fs.createWriteStream(destPath, { flags: 'wx' });
        let sizeBytes = 0;
        response.on('data', (chunk) => {
          sizeBytes += chunk.length;
        });
        response.pipe(out);

        const fail = (error) => {
          response.unpipe(out);
          out.destroy();
          // 清理半成品，忽略清理失败（文件可能本就不存在）。
          fs.unlink(destPath, () => {});
          reject(error);
        };

        out.on('error', fail);
        out.on('finish', () => {
          out.close(() => resolve({ sizeBytes, contentType: String(response.headers['content-type'] || '') }));
        });
        response.on('aborted', () => fail(new Error('connection-aborted')));
        request.setTimeout(CONFIG.IDLE_TIMEOUT_MS, () => fail(new Error('idle-timeout')));
      },
    );

    request.setTimeout(CONFIG.SOCKET_TIMEOUT_MS, () => request.destroy(new Error('socket-timeout')));
    request.on('error', (error) => reject(error));
  });

/**
 * 模组激活入口。
 * @param {import('./mainContract').FoliumMainApi} api
 * @returns {() => void} 卸载回调
 */
module.exports = function activate(api) {
  // 启动诊断标记：每次模组被宿主加载时写入数据目录，便于确认 main 入口正常激活。
  const writeStartupMarker = () => {
    try {
      const dataDir = api.storage.paths.data;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'startup.json'),
        JSON.stringify(
          {
            activatedAt: new Date().toISOString(),
            modVersion: api.manifest.version,
            downloadsDir: resolveDownloadsDir(api),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      // 诊断标记失败不影响主功能。
    }
  };
  writeStartupMarker();

  // 渲染端「下载当前歌曲」：request = { url, label }。
  // 返回 { ok: true, filePath, sizeBytes, contentType } 或 { ok: false, error }。
  api.rpc.handle('download', async (request) => {
    try {
      const url = typeof request?.url === 'string' ? request.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: 'invalid-url' };
      }

      const title = sanitizeFileName(typeof request?.label === 'string' ? request.label : '');
      const downloadsDir = resolveDownloadsDir(api);
      await fs.promises.mkdir(downloadsDir, { recursive: true });

      // 先写入唯一临时文件，成功后再落位，避免中断留下半个文件。
      const partPath = path.join(downloadsDir, `.music-downloader-${crypto.randomUUID()}.part`);
      const { sizeBytes, contentType } = await downloadToFile(url, partPath, CONFIG.MAX_REDIRECTS);

      const ext = extensionFor(url, contentType);
      const finalPath = await uniquePath(downloadsDir, title, ext);
      await fs.promises.rename(partPath, finalPath);

      return {
        ok: true,
        filePath: finalPath,
        sizeBytes,
        contentType,
        modVersion: api.manifest.version,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  return () => {
    // rpc 处理器由平台随模组停止一并清理，此处无需额外操作。
  };
};
