/**
 * 音乐下载器 · 渲染端入口（client.mjs）
 *
 * 职责：
 *  1. 监听 Omni 解析在线音频地址的事件（omni.audioSourceResolved），按歌曲身份缓存
 *     解析结果（歌曲 + 音频 https 地址）；同时用 playback.songChanged 跟踪当前歌曲。
 *  2. 在播放进度条右侧注册「下载」按钮（progressButtons），并在命令面板注册
 *     「下载当前歌曲」命令；两者共用同一段下载逻辑：只取当前这首歌对应的音频
 *     地址交给 main 进程下载到系统下载目录，返回 { outputPath, message }。
 *
 * 说明：宿主会预解析下一首，所以“最近一次解析结果”可能不属于当前歌曲；下载必须
 * 按歌曲身份匹配。Navidrome 等不触发该事件的音源，退回播放器 <audio> 的当前流地址。
 * audioSourceResolved 是实验接口（mod.json 已声明 omni.hooks）。
 */

/** 下载图标（与宿主进度条按钮同一尺寸）。 */
const DOWNLOAD_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
  + '<polyline points="7 10 12 15 17 10"/>'
  + '<line x1="12" y1="3" x2="12" y2="15"/>'
  + '</svg>';

/** 下载完成后的对勾图标。 */
const CHECK_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<polyline points="20 6 9 17 4 12"/>'
  + '</svg>';

const BUTTON_LABEL = '下载当前歌曲';
/** 与宿主进度条按钮一致的按钮边长。 */
const BUTTON_SIZE_PX = 22;
/**
 * 最多缓存多少首歌的音频地址。宿主会预解析下一首，长会话里缓存会持续增长；
 * 保留最近若干条足够覆盖回切与预加载。
 */
const MAX_CACHED_SOURCES = 24;

/** 格式化字节数为可读文本。 */
const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
};

/**
 * 歌曲身份：有 id 时用 source + id，否则用 歌手 + 歌名。
 * 与 Folium 文档对 FoliumSong 的建议一致（id 只在 source 内唯一，ref 不能当键）。
 */
const identityOf = (song) => {
  if (!song) return null;
  if (typeof song.id === 'string' && song.id) {
    return `id\u0000${song.source ?? ''}\u0000${song.id}`;
  }
  const title = typeof song.title === 'string' ? song.title.trim() : '';
  const artist = typeof song.artist === 'string' ? song.artist.trim() : '';
  return title || artist ? `ta\u0000${artist}\u0000${title}` : null;
};

/** 文本归一化：去首尾空白、合并空格、忽略大小写。 */
const normalizeText = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';

/**
 * 两个 DTO 是否是同一首歌。两个事件来源不同，id/source 可能只有一边有值，
 * 所以只有 id 双方都存在时才按 id 判断，否则退回 歌手 + 歌名。
 */
const isSameSong = (left, right) => {
  if (!left || !right) return false;
  const leftId = typeof left.id === 'string' && left.id ? left.id : '';
  const rightId = typeof right.id === 'string' && right.id ? right.id : '';
  if (leftId && rightId) {
    return leftId === rightId && normalizeText(left.source) === normalizeText(right.source);
  }
  const leftTitle = normalizeText(left.title);
  return leftTitle !== ''
    && leftTitle === normalizeText(right.title)
    && normalizeText(left.artist) === normalizeText(right.artist);
};

/** 拼出「歌手 - 歌名」标签，用于输出文件名。 */
const songLabel = (song) => {
  if (!song) return null;
  const title = typeof song.title === 'string' && song.title.trim() ? song.title.trim() : '未知歌曲';
  const artist = typeof song.artist === 'string' && song.artist.trim() ? song.artist.trim() : '';
  return artist && artist !== title ? `${artist} - ${title}` : title;
};

export default function activate(folium) {
  // 当前显示的歌曲（由 playback.songChanged 维护）。
  let currentSong = null;
  // 歌曲身份 → { song, url }。宿主会预解析下一首，因此不能只留“最近一条”。
  const sourcesBySong = new Map();

  const onSongChanged = (event) => {
    currentSong = event?.song ?? null;
  };

  const onAudioSourceResolved = (event) => {
    if (!event) return;
    const url = typeof event.url === 'string' ? event.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) return;
    const song = event.song ?? null;
    const key = identityOf(song);
    if (!key) return;

    sourcesBySong.delete(key);
    sourcesBySong.set(key, { song, url });
    while (sourcesBySong.size > MAX_CACHED_SOURCES) {
      sourcesBySong.delete(sourcesBySong.keys().next().value);
    }
  };

  // on() 返回 disposer；平台也会在模组停止时自动移除处理器。
  const disposeSourceHook = folium.events.on('omni.audioSourceResolved', onAudioSourceResolved);
  const disposeSongHook = folium.events.on('playback.songChanged', onSongChanged);

  /**
   * 当前播放器 <audio> 上的音频地址。
   * Omni 在线音源有 audioSourceResolved，Navidrome 等其它音源不会触发该事件，
   * 它们的实际流地址只反映在播放器元素上（通常是带鉴权参数的 http 地址）。
   */
  const audioElementUrl = () => {
    if (typeof document === 'undefined') return '';
    try {
      const candidates = [...document.querySelectorAll('audio')].filter((audio) => {
        const src = audio.currentSrc || audio.src || '';
        return /^https?:\/\//i.test(src);
      });
      if (candidates.length === 0) return '';
      // 有多个播放器（如交叉淡入）时优先取正在出声的那个。
      const playing = candidates.find((audio) => !audio.paused && audio.currentTime > 0);
      const chosen = playing ?? candidates[0];
      return chosen.currentSrc || chosen.src;
    } catch {
      return '';
    }
  };

  /** 下载当前显示歌曲的原始音频；失败抛错，成功返回命令结果结构。 */
  const downloadCurrentSong = async () => {
    const song = currentSong;
    if (!song) {
      throw new Error('还没拿到当前播放的歌曲信息。请先播放一首在线音源（网易云、酷狗等）的歌曲，再点下载。');
    }
    if (song.source === 'local') {
      throw new Error('本地歌曲的文件本来就在本地磁盘上，无需下载。');
    }

    // 优先用按歌曲身份缓存的解析结果（能避开宿主预解析的下一首）；
    // 没有缓存时退回播放器元素上的实际流地址（Navidrome 等）。
    const findSource = () => {
      const direct = sourcesBySong.get(identityOf(song));
      if (direct) return direct;
      for (const entry of sourcesBySong.values()) {
        if (isSameSong(entry.song, song)) return entry;
      }
      return null;
    };
    const url = findSource()?.url || audioElementUrl();
    if (!url) {
      throw new Error(`《${song.title}》暂时拿不到可下载的音频地址，请稍等片刻或重新播放这首歌再试。`);
    }

    const result = await folium.rpc.call('download', {
      url,
      label: songLabel(song) ?? 'audio',
    });
    if (!result || result.ok !== true) {
      throw new Error(`下载失败：${result?.error ?? '未知错误'}`);
    }

    const size = formatBytes(result.sizeBytes);
    return { outputPath: result.filePath, message: size ? `已下载 ${size}` : '已下载完成' };
  };

  /** 宿主提示条；旧版本没有 toast 时静默忽略，按钮本身仍会给出状态。 */
  const notify = (message, type) => {
    try {
      if (typeof folium.ui?.toast === 'function') {
        folium.ui.toast(message, { type, durationMs: type === 'error' ? 4000 : 2500 });
      }
    } catch {
      // 提示失败不影响下载结果。
    }
  };

  /** 把下载按钮画进进度条槽位。 */
  const mountDownloadButton = (container, ctx) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = BUTTON_LABEL;
    button.setAttribute('aria-label', BUTTON_LABEL);
    button.style.cssText =
      'all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;'
      + `width:${BUTTON_SIZE_PX}px;height:${BUTTON_SIZE_PX}px;border-radius:6px;`
      + 'opacity:0.7;transition:opacity 120ms;';
    button.innerHTML = DOWNLOAD_ICON;

    let busy = false;
    let disposed = false;
    let resetTimer = null;

    const paint = () => {
      const colors = typeof ctx?.getColors === 'function' ? ctx.getColors() : null;
      button.style.color = colors?.text || 'currentColor';
      button.style.opacity = busy ? '0.4' : '0.7';
      button.style.cursor = busy ? 'wait' : 'pointer';
    };

    const reset = () => {
      if (disposed) return;
      button.innerHTML = DOWNLOAD_ICON;
      button.title = BUTTON_LABEL;
      paint();
    };

    button.addEventListener('mouseenter', () => {
      if (!busy) button.style.opacity = '1';
    });
    button.addEventListener('mouseleave', () => {
      if (!busy) button.style.opacity = '0.7';
    });
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      paint();
      try {
        const result = await downloadCurrentSong();
        if (disposed) return;
        button.innerHTML = CHECK_ICON;
        button.title = result.message;
        notify(result.message, 'success');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (disposed) return;
        button.title = message;
        notify(message, 'error');
      } finally {
        busy = false;
        if (!disposed) {
          paint();
          resetTimer = setTimeout(reset, 2500);
        }
      }
    });

    container.appendChild(button);
    if (typeof ctx?.onChange === 'function') ctx.onChange(paint);
    paint();

    return () => {
      disposed = true;
      if (resetTimer !== null) clearTimeout(resetTimer);
      button.remove();
    };
  };

  // 进度条右侧的下载按钮。Folium 1.5 起注册表叫 progressButtons
  // （旧名已在 Folium 2 移除）；没有该注册表时命令仍然可用。
  const progressButtons = folium.registries?.progressButtons;
  if (progressButtons && typeof progressButtons.register === 'function') {
    progressButtons.register({
      id: 'download',
      slot: 'progress.trailing',
      order: 530,
      hideWhenCollapsed: false,
      mount: mountDownloadButton,
    });
  }

  folium.registries.commands.register({
    id: 'download-current-song',
    label: '下载当前歌曲',
    description: '把当前播放歌曲的原始音频下载到系统下载目录。在线音源（网易云、酷狗等）使用播放时解析出的音频地址。',
    keywords: ['下载', '音乐', 'audio', 'download', '保存'],
    run: downloadCurrentSong,
  });

  return () => {
    if (typeof disposeSourceHook === 'function') disposeSourceHook();
    if (typeof disposeSongHook === 'function') disposeSongHook();
  };
}
