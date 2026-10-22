import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { PluginAPI, PluginManifest } from '../../src/scripts/core/plugin_types';
import { ZreadPlugin } from './index';

const createApi = (settings: Record<string, unknown> = {}) => {
  const styleFiles: Record<string, string> = {
    'navbar.css': 'header { display: none !important; }',
    'toolbar.css': '[class*="w-72"][class*="top-[61px]"] { display: none !important; }',
  };
  const injectedCss = new Map<string, string>();
  const api = {
    style: {
      inject(id: string, css: string) { injectedCss.set(id, css); },
      remove(id: string) { injectedCss.delete(id); },
      has(id: string) { return injectedCss.has(id); },
      getFile(name: string) { return styleFiles[name] ?? null; },
      listFiles() { return Object.keys(styleFiles); },
    },
    settings: {
      get<T>(_key: string, defaultValue?: T) { return defaultValue as T; },
      async set() {},
      getAll() { return settings; },
      subscribe() { return () => undefined; },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PluginAPI;
  return { api, injectedCss, styleFiles };
};

const withManifestDomain = (plugin: ZreadPlugin, domain: string[]): void => {
  const site = plugin.manifest.site;
  const manifest: PluginManifest = {
    ...plugin.manifest,
    site: {
      domain,
      homeUrl: site?.homeUrl ?? 'https://zread.ai/',
      readerPattern: site?.readerPattern ?? '/',
    },
  };
  Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
};

describe('ZreadPlugin', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
  });

  it('域名匹配遵循 DNS label 后缀且不误匹配父串', () => {
    history.replaceState({}, '', '/owner/repo');
    const plugin = new ZreadPlugin();
    const host = window.location.hostname;

    withManifestDomain(plugin, [host]);
    expect(plugin.matchesDomain()).toBe(true);
    withManifestDomain(plugin, [`sub.${host}`]);
    expect(plugin.matchesDomain()).toBe(false);
    withManifestDomain(plugin, ['zread.ai']);
    expect(plugin.matchesDomain()).toBe(false);
  });

  it('仓库 Wiki 页是阅读页，站点应用页不是', () => {
    const plugin = new ZreadPlugin();
    const readerPaths = [
      '/d2lang/d2',
      '/d2lang/d2/1-overview',
      '/zai-org/ZCode/27-go-library-api',
      '/cli-service/repo',
    ];
    for (const path of readerPaths) {
      history.replaceState({}, '', path);
      expect(plugin.isReaderPage()).toBe(true);
    }
    const nonReaderPaths = [
      '/',
      '/trending',
      '/library',
      '/mcp',
      '/cli',
      '/subscription',
      '/private/repo',
      '/trending/anything',
    ];
    for (const path of nonReaderPaths) {
      history.replaceState({}, '', path);
      expect(plugin.isReaderPage()).toBe(false);
    }
  });

  it('根路径是首页', () => {
    const plugin = new ZreadPlugin();
    history.replaceState({}, '', '/');
    expect(plugin.isHomePage()).toBe(true);
    history.replaceState({}, '', '/d2lang/d2');
    expect(plugin.isHomePage()).toBe(false);
  });

  it('阅读页上按设置注入与移除样式', () => {
    history.replaceState({}, '', '/d2lang/d2');
    const { api, injectedCss } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);
    expect(injectedCss.has('toolbar')).toBe(true);
    expect(injectedCss.has('navbar')).toBe(true);

    plugin.onUnload();
    expect(injectedCss.has('toolbar')).toBe(false);
    expect(injectedCss.has('navbar')).toBe(false);
  });

  it('设置关闭时不注入样式', () => {
    history.replaceState({}, '', '/d2lang/d2');
    const { api, injectedCss } = createApi({});
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);
    expect(injectedCss.has('toolbar')).toBe(false);
    expect(injectedCss.has('navbar')).toBe(false);
    plugin.onUnload();
  });

  it('能力关闭后即使设置开启也不注入', () => {
    history.replaceState({}, '', '/d2lang/d2');
    const { api, injectedCss } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, hideToolbar: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    expect(injectedCss.has('toolbar')).toBe(false);
    expect(injectedCss.has('navbar')).toBe(true);
    plugin.onUnload();
  });

  it('离开阅读页后样式被移除，且路由事件驱动重新评估', () => {
    history.replaceState({}, '', '/d2lang/d2');
    const { api, injectedCss } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);
    expect(injectedCss.has('navbar')).toBe(true);

    history.replaceState({}, '', '/');
    window.dispatchEvent(new Event('ipc:route-changed'));
    expect(injectedCss.has('navbar')).toBe(false);
    expect(injectedCss.has('toolbar')).toBe(false);

    history.replaceState({}, '', '/d2lang/d2/1-overview');
    window.dispatchEvent(new Event('ipc:route-changed'));
    expect(injectedCss.has('navbar')).toBe(true);
    expect(injectedCss.has('toolbar')).toBe(true);
    plugin.onUnload();
  });

  it('onUnload 后不再响应路由事件', () => {
    history.replaceState({}, '', '/d2lang/d2');
    const { api, injectedCss } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);
    plugin.onUnload();

    window.dispatchEvent(new Event('ipc:route-changed'));
    expect(injectedCss.size).toBe(0);
  });

  it('翻页即上下滚动一屏', () => {
    const scrolls: number[] = [];
    const original = window.scrollBy;
    window.scrollBy = ((_x: number, y: number) => {
      scrolls.push(y);
    }) as typeof window.scrollBy;
    try {
      const plugin = new ZreadPlugin();
      plugin.nextPage();
      plugin.prevPage();
      expect(scrolls).toEqual([window.innerHeight, -window.innerHeight]);
    } finally {
      window.scrollBy = original;
    }
  });

  it('滚动到底部时 isAtBottom 为真', () => {
    const plugin = new ZreadPlugin();
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 9000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 9700,
      configurable: true,
    });
    try {
      expect(plugin.isAtBottom()).toBe(true);
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      expect(plugin.isAtBottom()).toBe(false);
    } finally {
      delete (window as { innerHeight?: number }).innerHeight;
      delete (window as { scrollY?: number }).scrollY;
      delete (document.documentElement as unknown as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('manifest 声明 nativeTheme，壳层让位于站点自身深浅机制', () => {
    const plugin = new ZreadPlugin();
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
  });

  it('manifest 声明 nativeTheme，壳层让位于站点自身深浅机制', () => {
    const plugin = new ZreadPlugin();
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
  });

  it('章节切换按章节树顺序点击上一章/下一章链接', () => {
    history.replaceState({}, '', '/d2lang/d2/2-quick-start');
    const { api } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);

    const clicked: string[] = [];
    const mk = (href: string) => {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = href;
      a.getBoundingClientRect = () =>
        ({ width: 100, height: 20, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) } as DOMRect);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        clicked.push(href);
      });
      document.body.append(a);
      return a;
    };
    mk('/d2lang/d2/1-overview');
    mk('/d2lang/d2/2-quick-start');
    mk('/d2lang/d2/3-advanced');
    // 移动端抽屉里的重复链接（不可见）应被忽略
    const hidden = mk('/d2lang/d2/3-advanced');
    hidden.getBoundingClientRect = () =>
      ({ width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect);
    // 站点自身的非章节链接（外链/保留首段）不参与
    mk('https://github.com/d2lang/d2');
    mk('/trending');

    expect(plugin.nextChapter()).toBe(true);
    expect(clicked).toEqual(['/d2lang/d2/3-advanced']);

    // 点击被 preventDefault，path 仍是第二章：再退应到第一章
    expect(plugin.prevChapter()).toBe(true);
    expect(clicked).toEqual(['/d2lang/d2/3-advanced', '/d2lang/d2/1-overview']);

    // 进入第一章：上一章越界返回 false，下一章进第二节
    history.replaceState({}, '', '/d2lang/d2/1-overview');
    expect(plugin.prevChapter()).toBe(false);
    expect(plugin.nextChapter()).toBe(true);
    expect(clicked[2]).toBe('/d2lang/d2/2-quick-start');

    // 根 Wiki 页（/owner/repo）即第一章：上一章 false、下一章进第二节
    history.replaceState({}, '', '/d2lang/d2');
    expect(plugin.prevChapter()).toBe(false);
    expect(plugin.nextChapter()).toBe(true);
    expect(clicked[3]).toBe('/d2lang/d2/2-quick-start');

    // 最后一章：下一章越界返回 false
    history.replaceState({}, '', '/d2lang/d2/3-advanced');
    expect(plugin.nextChapter()).toBe(false);

    document.body.replaceChildren();
    plugin.onUnload();
  });

  it('getStyles 返回包内 CSS，菜单项声明隐藏能力与自动翻页', () => {
    history.replaceState({}, '', '/d2lang/d2');
    const { api, styleFiles } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);

    const styles = plugin.getStyles();
    expect(styles.toolbar?.enabled).toBe(styleFiles['toolbar.css']);
    expect(styles.navbar?.enabled).toBe(styleFiles['navbar.css']);
    expect(plugin.getReaderMenuItems()).toEqual(['hide_toolbar', 'hide_navbar', 'auto_flip']);
    plugin.onUnload();
  });
});

describe('ZreadPlugin gateway 504 self-heal', () => {
  const reload = mock(() => undefined);
  let capturedTimers: Array<{ fn: () => void; delay: number }>;
  let originalSetTimeout: typeof setTimeout;
  let originalTitle: string;

  beforeEach(() => {
    reload.mockClear();
    originalTitle = document.title;
    (location as { reload: () => void }).reload = reload as unknown as () => void;
    capturedTimers = [];
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedTimers.push({ fn, delay: delay ?? 0 });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    sessionStorage.removeItem('atreader-zread-504-retry');
    document.title = originalTitle;
  });

  const loadPlugin = () => {
    const { api } = createApi({ hideToolbar: true, hideNavbar: true });
    const plugin = new ZreadPlugin();
    plugin.onLoad(api);
    return plugin;
  };

  it('检测到网关超时页时安排 1.5 秒后自动重载并计数', () => {
    document.title = '504 Gateway Time-out';
    loadPlugin();

    expect(capturedTimers).toHaveLength(1);
    expect(capturedTimers[0].delay).toBe(1500);
    const state = JSON.parse(sessionStorage.getItem('atreader-zread-504-retry')!);
    expect(state.count).toBe(1);

    capturedTimers[0].fn();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('正文含网关超时特征同样触发（标题缺失的网关变体）', () => {
    document.title = '';
    document.body.innerHTML = '<h1>504 Gateway Time-out</h1><hr><center>nginx</center>';
    loadPlugin();

    expect(capturedTimers).toHaveLength(1);
    document.body.innerHTML = '';
  });

  it('正常页面清除重试计数且不安排重载', () => {
    sessionStorage.setItem(
      'atreader-zread-504-retry',
      JSON.stringify({ count: 1, ts: Date.now() }),
    );
    document.title = '概述 | d2lang/d2 | Zread';
    loadPlugin();

    expect(capturedTimers).toHaveLength(0);
    expect(sessionStorage.getItem('atreader-zread-504-retry')).toBeNull();
  });

  it('30 秒窗口内最多重试 2 次，源站持续不可用时不死循环', () => {
    sessionStorage.setItem(
      'atreader-zread-504-retry',
      JSON.stringify({ count: 2, ts: Date.now() }),
    );
    document.title = '504 Gateway Time-out';
    loadPlugin();

    expect(capturedTimers).toHaveLength(0);
  });

  it('超过 30 秒窗口后计数重置，允许新一轮自愈', () => {
    sessionStorage.setItem(
      'atreader-zread-504-retry',
      JSON.stringify({ count: 2, ts: Date.now() - 31_000 }),
    );
    document.title = '504 Gateway Time-out';
    loadPlugin();

    expect(capturedTimers).toHaveLength(1);
    const state = JSON.parse(sessionStorage.getItem('atreader-zread-504-retry')!);
    expect(state.count).toBe(1);
  });
});
