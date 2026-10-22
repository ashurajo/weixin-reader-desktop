/**
 * 首绘样式引导（Boot Styles）
 *
 * 插件样式（沉浸模式/隐藏导航栏等）要等 get_runtime_plugin IPC + 动态
 * import 之后才注入，zread 这类整页改造型站点会先闪现原版布局、再塌陷成
 * 沉浸模式。Rust 壳在启动时把已启用站点插件的导航/工具栏隐藏 CSS 与设置
 * 快照嵌进初始化脚本（window.__ATREADER_BOOT__），本模块在 documentStart
 * 同步套用；插件系统就绪后由 AppRuntime 调 settleBootStyles() 移除引导
 * 样式，之后完全由插件接管。
 *
 * 只读取壳内嵌数据，不向站点写任何存储（起点风控脚本会因未知存储键触发
 * 自刷新，整页预接管方案因此回退，见 qidian-site-injection-gotchas 记忆）。
 * 快照是应用启动时刻的设置；会话内改设置后由插件注入正确样式并移除引导，
 * 下一页面的引导快照在应用重启前保持启动时的值。
 */

interface BootStyleEntry {
  id?: string;
  domains?: unknown;
  capabilities?: Record<string, unknown>;
  styles?: { navbar?: unknown; toolbar?: unknown };
}

interface BootSnapshot {
  siteSettings?: Record<string, Record<string, unknown>>;
  plugins?: BootStyleEntry[];
}

const BOOT_PREFIX = 'atreader-boot-';

const hostMatchesDomain = (host: string, domain: string): boolean => {
  const normalizedDomain = domain.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
  const normalizedHost = host.replace(/\.+$/, '').toLowerCase();
  if (normalizedDomain.length === 0) return false;
  return normalizedHost === normalizedDomain
    || normalizedHost.endsWith(`.${normalizedDomain}`);
};

const readSnapshot = (): BootSnapshot | null => {
  try {
    const raw = (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__;
    if (!raw || typeof raw !== 'object') return null;
    return raw as BootSnapshot;
  } catch {
    return null;
  }
};

/**
 * documentStart 同步调用（先于任何 await）：按域名匹配站点插件，把设置
 * 开启且清单能力允许的导航/工具栏隐藏 CSS 在首绘前注入。
 */
export const applyBootStyles = (): void => {
  const snapshot = readSnapshot();
  const plugins = Array.isArray(snapshot?.plugins) ? snapshot!.plugins : [];
  if (plugins.length === 0) return;
  const host = window.location.hostname;

  for (const entry of plugins) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const domains = Array.isArray(entry.domains)
      ? entry.domains.filter((domain): domain is string => typeof domain === 'string')
      : [];
    if (!domains.some(domain => hostMatchesDomain(host, domain))) continue;

    const capabilities = (entry.capabilities ?? {}) as Record<string, unknown>;
    const siteSettings = snapshot?.siteSettings?.[entry.id] ?? {};
    const wants: Array<[string, unknown, boolean]> = [
      [
        'navbar',
        entry.styles?.navbar,
        capabilities.hideNavbar === true && siteSettings.hideNavbar === true,
      ],
      [
        'toolbar',
        entry.styles?.toolbar,
        capabilities.hideToolbar === true && siteSettings.hideToolbar === true,
      ],
    ];
    for (const [key, css, enabled] of wants) {
      if (enabled !== true || typeof css !== 'string' || css.length === 0) continue;
      const id = `${BOOT_PREFIX}${key}`;
      if (document.getElementById(id)) continue;
      try {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head ?? document.documentElement).appendChild(style);
      } catch {
        /* ignore */
      }
    }
  }
};

/** 移除引导样式；幂等，之后由插件样式接管。 */
export const settleBootStyles = (): void => {
  try {
    document.querySelectorAll(`style[id^="${BOOT_PREFIX}"]`).forEach(el => el.remove());
  } catch {
    /* ignore */
  }
};
