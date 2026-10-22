/*!
 * Zread 插件（zread.ai）
 *
 * 仅增强网页呈现：隐藏顶部导航栏与两侧栏区（沉浸模式，保留章节目录树），
 * 隐藏鼠标由壳级 CursorHider 承担，深浅主题由站点自身机制接管
 * （manifest 声明 nativeTheme，壳层不注入反色与背景兜底）。
 * 不复制正文、不读取正文文本，也不抓取或导出内容。
 *
 * 翻页语义：Zread 阅读页为单栏纵向滚动，nextPage/prevPage 即上下滚动一屏。
 * 另含网关 504 错误页的自动重载自愈（源站冷启动间歇性超时，刷新必成功）。
 */

import type {
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';

/// 阅读页 = 仓库 Wiki 页（/{owner}/{repo}[/…-slug]）。
/// 排除站点自身的单段应用页与保留首段（trending/library/mcp/cli/subscription/private）。
/// 仅使用向前环视（lookahead），旧 WebKit 完整支持；禁用的是 lookbehind。
const READER_PAGE_PATTERN =
  /^\/(?!(?:trending|library|mcp|cli|subscription|private)(?:\/|$))[^/]+\/[^/]+/;

const STYLE_IDS = ['navbar', 'toolbar'] as const;
type StyleId = (typeof STYLE_IDS)[number];

/// 504 自愈参数：zread 源站（Cloudflare → Next.js SSR）冷启动时网关约 10 秒
/// 即切 504，而手动刷新必命中热源站成功。自动重载等价于用户手动刷新。
const GATEWAY_TIMEOUT_RE = /gateway[\s-]*time[\s-]*out/i;
const RETRY_STORAGE_KEY = 'atreader-zread-504-retry';
const RETRY_WINDOW_MS = 30_000;
const RETRY_DELAY_MS = 1_500;
const RETRY_MAX = 2;

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const ZREAD_RUNTIME_MANIFEST: PluginManifest = {
  id: 'zread',
  name: 'Zread',
  version: '1.0.0',
  description: 'Zread（zread.ai）深度 Wiki 阅读增强：沉浸模式、隐藏导航栏与滚动翻页',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['zread.ai'],
    homeUrl: 'https://zread.ai/',
    readerPattern: '/',
  },
  capabilities: {
    hideToolbar: true,
    hideNavbar: true,
    hideCursor: true,
    nativeTheme: true,
    // 滚动翻页走遥控器/菜单的上一页/下一页（nextPage = 上下滚动一屏）。
    autoFlip: true,
    // 章节切换：按左侧章节树的顺序跳上一章/下一章。
    chapterNav: true,
  },
};

export class ZreadPlugin implements ReaderPlugin {
  readonly manifest = ZREAD_RUNTIME_MANIFEST;

  private api: PluginAPI | null = null;
  private cleanupFunctions: Array<() => void> = [];

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Zread plugin loaded');
    this.maybeRetryGatewayTimeout();

    // Zread 是 Next.js SPA，切章不刷新页面；路由变化时重新评估样式注入。
    const routeChanged = () => this.applySettings(api.settings.getAll());
    window.addEventListener('ipc:route-changed', routeChanged);
    this.cleanupFunctions.push(() =>
      window.removeEventListener('ipc:route-changed', routeChanged)
    );

    const unsubscribe = api.settings.subscribe(settings => this.applySettings(settings));
    this.cleanupFunctions.push(unsubscribe);
    this.applySettings(api.settings.getAll());
  }

  onUnload(): void {
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];
    if (this.api) {
      for (const id of STYLE_IDS) {
        this.api.style.remove(id);
      }
      this.api.log.info('Zread plugin unloaded');
    }
    this.api = null;
  }

  isReaderPage(): boolean {
    return READER_PAGE_PATTERN.test(window.location.pathname);
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '';
  }

  matchesDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = Array.isArray(this.manifest.site?.domain)
      ? this.manifest.site.domain
      : [this.manifest.site?.domain];
    return domains.some(domain =>
      typeof domain === 'string'
      && (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  }

  nextPage(): void {
    window.scrollBy(0, window.innerHeight);
  }

  prevPage(): void {
    window.scrollBy(0, -window.innerHeight);
  }

  isAtBottom(): boolean {
    const totalHeight = document.documentElement.scrollHeight;
    return window.innerHeight + window.scrollY >= totalHeight - 300;
  }

  /*!
   * @capability chapterNav [能力 3/3：章节切换]
   * 左侧章节树就是按阅读顺序排列的章节链接表（href 形如
   * /<owner>/<repo>/<slug>，与 READER_PAGE_PATTERN 同源、首段排除保留词）。
   * 当前章 = href 与 pathname 完全一致的条目；根 Wiki 页（/owner/repo，
   * 即「概述」）不在树里，按第 0 章处理。跳转直接点击树链接，
   * 走 Next.js 客户端路由，无整页刷新。
   */
  private getChapterTreeLinks(): HTMLAnchorElement[] {
    const seen = new Set<string>();
    const links: HTMLAnchorElement[] = [];
    for (const link of Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'),
    )) {
      const href = link.getAttribute('href') || '';
      // 章节链接 = 领域保留词之外的 /<owner>/<repo>/<slug> 三段路径
      if (!/^\/(?!(?:trending|library|mcp|cli|subscription|private)(?:\/|$))[^/]+\/[^/]+\/.+/.test(href)) {
        continue;
      }
      if (seen.has(href)) continue;
      const rect = link.getBoundingClientRect();
      // 移动端抽屉里的重复树不可见，仅收集当前呈现的目录
      if (rect.width === 0 && rect.height === 0) continue;
      seen.add(href);
      links.push(link);
    }
    return links;
  }

  private getCurrentChapterIndex(links: HTMLAnchorElement[]): number {
    const path = window.location.pathname;
    for (let i = 0; i < links.length; i += 1) {
      if (links[i].getAttribute('href') === path) return i;
    }
    // 根 Wiki 页就是第一章（概述）
    if (/^\/[^/]+\/[^/]+$/.test(path)) return 0;
    return -1;
  }

  prevChapter(): boolean {
    const links = this.getChapterTreeLinks();
    const index = this.getCurrentChapterIndex(links);
    if (index <= 0) return false;
    links[index - 1].click();
    return true;
  }

  nextChapter(): boolean {
    const links = this.getChapterTreeLinks();
    const index = this.getCurrentChapterIndex(links);
    if (index < 0 || index >= links.length - 1) return false;
    links[index + 1].click();
    return true;
  }

  getStyles(): PluginStyles {
    return {
      toolbar: {
        enabled: this.api?.style.getFile('toolbar.css') ?? '',
        disabled: '',
      },
      navbar: {
        enabled: this.api?.style.getFile('navbar.css') ?? '',
        disabled: '',
      },
    };
  }

  getReaderMenuItems(): string[] {
    return ['hide_toolbar', 'hide_navbar', 'auto_flip'];
  }

  private applySettings(settings: Record<string, unknown>): void {
    if (!this.api) return;
    if (!this.isReaderPage()) {
      for (const id of STYLE_IDS) {
        this.api.style.remove(id);
      }
      return;
    }

    /*! @capability hideNavbar [能力 2/3：隐藏导航栏] 菜单状态与清单能力同时开启才注入 navbar.css。 */
    const hideNavbar = settings.hideNavbar === true
      && this.manifest.capabilities.hideNavbar === true;
    /*! @capability hideToolbar [能力 1/3：隐藏工具栏] 菜单状态与清单能力同时开启才注入 toolbar.css（左右两栏沉浸模式）。 */
    const hideToolbar = settings.hideToolbar === true
      && this.manifest.capabilities.hideToolbar === true;

    this.applyStyleFile('navbar', hideNavbar);
    this.applyStyleFile('toolbar', hideToolbar);
  }

  private applyStyleFile(id: StyleId, enabled: boolean): void {
    if (!this.api) return;
    if (!enabled) {
      this.api.style.remove(id);
      return;
    }
    const css = this.api.style.getFile(`${id}.css`);
    if (css) this.api.style.inject(id, css);
  }

  /// 网关 504 自愈：插件会随 504 错误页一起注入（错误页域名仍是 zread.ai）。
  /// 检测到超时页时延迟自动重载——刷新必命中热源站，等价于用户手动刷新。
  /// sessionStorage 记录 30 秒窗口内的重试次数（上限 2 次），
  /// 防止源站持续不可用时陷入重载循环；正常加载时清零。
  private maybeRetryGatewayTimeout(): void {
    const title = document.title || '';
    const bodyText = document.body?.textContent?.slice(0, 800) ?? '';
    const isGatewayTimeout =
      GATEWAY_TIMEOUT_RE.test(title) || GATEWAY_TIMEOUT_RE.test(bodyText);
    if (!isGatewayTimeout) {
      sessionStorage.removeItem(RETRY_STORAGE_KEY);
      return;
    }

    let state: { count: number; ts: number };
    try {
      const raw = sessionStorage.getItem(RETRY_STORAGE_KEY);
      state = raw ? JSON.parse(raw) : { count: 0, ts: Date.now() };
      if (!Number.isFinite(state.count) || !Number.isFinite(state.ts)) {
        state = { count: 0, ts: Date.now() };
      }
      if (Date.now() - state.ts > RETRY_WINDOW_MS) {
        state = { count: 0, ts: Date.now() };
      }
    } catch {
      state = { count: 0, ts: Date.now() };
    }
    if (state.count >= RETRY_MAX) return;

    state.count += 1;
    sessionStorage.setItem(RETRY_STORAGE_KEY, JSON.stringify(state));
    this.api?.log.warn(
      `[Zread] Gateway timeout page detected, auto-reloading (attempt ${state.count}/${RETRY_MAX})`,
    );
    setTimeout(() => location.reload(), RETRY_DELAY_MS);
  }
}

export default ZreadPlugin;
