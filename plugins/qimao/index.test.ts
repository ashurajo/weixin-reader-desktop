import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginAPI, PluginManifest } from '../../src/scripts/core/plugin_types';
import { QimaoPlugin } from './index';

const READER_URL = '/shuku/222767-16480917400002/';

const readerMarkup = () => {
  document.body.innerHTML = `
    <div class="reader-header"><div class="reader-header-con">七猫</div></div>
    <ul class="reader-fixed-left">
      <li class="go-back"><a class="reader-fixed-left-link"><span class="title">返回</span></a></li>
    </ul>
    <div class="chapter-detail">
      <div class="chapter-detail-wrap reader-box">
        <div class="chapter-detail-wrap-info">
          <h2 class="chapter-title">第2章 一鸣惊人</h2>
          <dl class="chapter-tips"><dt>书名：</dt><dd>测试之书</dd></dl>
        </div>
        <div class="chapter-detail-wrap-content">
          <div class="chapter-detail-article"><div class="article"><p>正文</p></div></div>
        </div>
      </div>
    </div>
    <ul class="qm-fixed-right">
      <li class="qm-fixed-right-item click catalog">目录</li>
      <li class="clearfix ref-catalog-li-1">第1章</li>
      <li class="clearfix active ref-catalog-li-2">第2章</li>
      <li class="clearfix ref-catalog-li-3">第3章</li>
    </ul>
    <a class="qm-btn" href="/shuku/222767-16480917400001/">上一章</a>
    <a class="qm-btn" href="/shuku/222767-16480917400003/">下一章</a>`;
};

const createApi = (settings: Record<string, unknown> = {}) => {
  const stored = new Map<string, unknown>();
  const toastMessages: string[] = [];
  const styleFiles: Record<string, string> = {
    'reader.css': 'body.atreader-qimao-paged { overflow: hidden; }',
    'progress.css': '.atreader-qimao-page-indicator { position: fixed; }',
    'wide.css': 'body.atreader-qimao-paged { --atreader-page-ratio: 90%; }',
    'toolbar.css': '.reader-fixed-left, .qm-fixed-right { display: none; }',
    'navbar.css': '.reader-header { display: none; }',
    'layout-toggle.css': '.atreader-qimao-layout-toggle { cursor: pointer; }',
  };
  const api = {
    style: {
      inject(id: string, css: string) {
        let style = document.getElementById(`test-${id}`) as HTMLStyleElement | null;
        if (!style) {
          style = document.createElement('style');
          style.id = `test-${id}`;
          document.head.append(style);
        }
        style.textContent = css;
      },
      remove(id: string) { document.getElementById(`test-${id}`)?.remove(); },
      has(id: string) { return document.getElementById(`test-${id}`) !== null; },
      getFile(name: string) { return styleFiles[name] ?? null; },
      listFiles() { return Object.keys(styleFiles); },
    },
    settings: {
      get<T>(_key: string, defaultValue?: T) { return defaultValue as T; },
      async set() {},
      getAll() { return settings; },
      subscribe() { return () => undefined; },
    },
    storage: {
      async get<T>(key: string) { return (stored.get(key) as T | undefined) ?? null; },
      async set(key: string, value: unknown) { stored.set(key, value); },
      async remove(key: string) { stored.delete(key); },
      async keys() { return [...stored.keys()]; },
    },
    toast: { show(text: string) { toastMessages.push(text); } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PluginAPI;
  return { api, stored, toastMessages };
};

/** 记录章节链接点击并阻止 happy-dom 触发导航。 */
const captureChapterClicks = (): { clicked: string[]; release: () => void } => {
  const clicked: string[] = [];
  const capture = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target?.tagName === 'A') {
      clicked.push((target.textContent || '').trim());
      event.preventDefault();
    }
  };
  document.addEventListener('click', capture);
  return { clicked, release: () => document.removeEventListener('click', capture) };
};

describe('Qimao page detection', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
  });

  it('recognizes chapter pages and the reader index page', () => {
    const plugin = new QimaoPlugin();

    history.replaceState({}, '', READER_URL);
    expect(plugin.isReaderPage()).toBe(true);

    history.replaceState({}, '', '/reader/index/222767/');
    expect(plugin.isReaderPage()).toBe(true);

    history.replaceState({}, '', '/shuku/222767/');
    expect(plugin.isReaderPage()).toBe(false);

    history.replaceState({}, '', '/');
    expect(plugin.isReaderPage()).toBe(false);
    expect(plugin.isHomePage()).toBe(true);
  });
});

describe('Qimao reading progress from the native catalog', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    document.body.replaceChildren();
  });

  it('derives chapter progress and book summary from the active catalog item', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const plugin = new QimaoPlugin();

    expect(plugin.getChapterProgress()).toBe(67);
    expect(await plugin.getBookProgress()).toEqual({
      progress: 67,
      chapterIdx: 2,
      summary: '测试之书 · 第 2/3 章',
    });
  });

  it('returns zero progress when the catalog is missing or unpositioned', () => {
    history.replaceState({}, '', READER_URL);
    document.body.innerHTML = '<p>正文</p>';
    const plugin = new QimaoPlugin();

    expect(plugin.getChapterProgress()).toBe(0);
  });
});

describe('Qimao native toolbar layout toggle', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    sessionStorage.clear();
    document.body.replaceChildren();
    document.body.className = '';
    document.head.querySelectorAll('style[id^="test-"]').forEach(style => style.remove());
  });

  it('appends the action button and cycles double, single, double', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api, stored } = createApi();
    const plugin = new QimaoPlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    const toolbar = document.querySelector('.qm-fixed-right')!;
    const toggle = toolbar.firstElementChild as HTMLElement;
    expect(toggle.classList.contains('atreader-qimao-layout-toggle')).toBe(true);
    expect(toggle.lastElementChild?.textContent).toBe('单列');
    expect(document.body.classList.contains('atreader-qimao-paged')).toBe(true);
    expect(document.getElementById('test-progress')).not.toBeNull();

    toggle.click();
    expect(toggle.lastElementChild?.textContent).toBe('双栏');
    expect(document.body.classList.contains('atreader-qimao-paged')).toBe(false);
    expect(document.getElementById('test-progress')).toBeNull();
    expect(stored.get('double-column-enabled')).toBe(false);

    toggle.click();
    expect(toggle.lastElementChild?.textContent).toBe('单列');
    expect(document.body.classList.contains('atreader-qimao-paged')).toBe(true);
    expect(document.getElementById('test-progress')).not.toBeNull();

    plugin.onUnload();
    expect(document.querySelector('.atreader-qimao-layout-toggle')).toBeNull();
  });

  it('does not inject the button or pagination when the editor capability is off', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QimaoPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, doubleColumn: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    await Promise.resolve();

    expect(document.querySelector('.atreader-qimao-layout-toggle')).toBeNull();
    expect(document.body.classList.contains('atreader-qimao-paged')).toBe(false);
    plugin.onUnload();
  });

  it('hides the page indicator and reclaims its bottom space when progress tracking is off', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QimaoPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, progressTracker: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });

    plugin.onLoad(api);
    await Promise.resolve();

    const viewport = document.querySelector<HTMLElement>('.atreader-qimao-page-viewport');
    expect(document.querySelector('.atreader-qimao-page-indicator')).toBeNull();
    expect(document.getElementById('test-progress')).toBeNull();
    expect(viewport?.style.getPropertyValue('--atreader-page-height'))
      .toBe(`${Math.max(320, window.innerHeight - 16)}px`);

    plugin.onUnload();
  });

  it('manifest 声明 nativeTheme，壳层不注入反色滤镜', () => {
    const plugin = new QimaoPlugin();
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
  });

  it('hides the site header through the navbar style file', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi({ hideNavbar: true });
    const plugin = new QimaoPlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    expect(document.getElementById('test-navbar')?.textContent)
      .toContain('.reader-header { display: none; }');
    expect(plugin.getReaderMenuItems()).toContain('hide_navbar');
    plugin.onUnload();
    expect(document.getElementById('test-navbar')).toBeNull();
  });
});

describe('Qimao double-column chapter keyboard navigation', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    sessionStorage.clear();
    document.body.replaceChildren();
    document.body.className = '';
    document.head.querySelectorAll('style[id^="test-"]').forEach(style => style.remove());
  });

  it('maps up and down to the native chapter links when enabled', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api, toastMessages } = createApi();
    const plugin = new QimaoPlugin();
    const { clicked, release } = captureChapterClicks();

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.body.dispatchEvent(up);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(down);

    expect(clicked).toEqual(['上一章', '下一章']);
    expect(toastMessages).toEqual(['上一章', '下一章']);
    expect(up.defaultPrevented).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    // 显式跳章落章首，不能复用 ← 翻页溢出的“落章尾”标记
    expect(sessionStorage.getItem('atreader-qimao-open-chapter-at-start')).not.toBeNull();
    expect(sessionStorage.getItem('atreader-qimao-open-previous-at-end')).toBeNull();

    plugin.onUnload();
    release();
  });

  it('falls through to chapter links when paging past the chapter boundary', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QimaoPlugin();
    const { clicked, release } = captureChapterClicks();

    plugin.onLoad(api);
    await Promise.resolve();

    plugin.nextPage();
    expect(clicked).toEqual(['下一章']);

    plugin.prevPage();
    expect(clicked).toEqual(['下一章', '上一章']);
    // ← 翻页溢出的连续阅读流：新章节应落在末尾而不是开头
    expect(sessionStorage.getItem('atreader-qimao-open-previous-at-end')).not.toBeNull();

    plugin.onUnload();
    release();
  });

  it('leaves arrows untouched when chapter navigation capability is off', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QimaoPlugin();
    const manifest: PluginManifest = {
      ...plugin.manifest,
      capabilities: { ...plugin.manifest.capabilities, chapterNav: false },
    };
    Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
    const { clicked, release } = captureChapterClicks();

    plugin.onLoad(api);
    await Promise.resolve();

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    document.body.dispatchEvent(up);
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    document.body.dispatchEvent(down);

    expect(clicked).toEqual([]);
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);

    plugin.onUnload();
    release();
  });
});

describe('Qimao wheel paging yields to native popup scrolling', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    sessionStorage.clear();
    document.body.replaceChildren();
    document.body.className = '';
    document.head.querySelectorAll('style[id^="test-"]').forEach(style => style.remove());
  });

  const appendCatalogPopup = (): HTMLElement => {
    // 模拟七猫章节目录弹窗：浮层内一个纵向溢出的滚动列表
    const list = document.createElement('div');
    list.className = 'qm-pop-list';
    list.style.overflowY = 'auto';
    list.innerHTML = '<p>第一章</p><p>第二章</p><p>第三章</p>';
    const popup = document.createElement('div');
    popup.className = 'qm-pop';
    popup.append(list);
    document.body.append(popup);
    Object.defineProperty(list, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    return list;
  };

  it('lets the chapter popup list scroll instead of turning pages', async () => {
    history.replaceState({}, '', READER_URL);
    readerMarkup();
    const { api } = createApi();
    const plugin = new QimaoPlugin();

    plugin.onLoad(api);
    await Promise.resolve();

    const list = appendCatalogPopup();
    const popupWheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list.firstElementChild!.dispatchEvent(popupWheel);
    expect(popupWheel.defaultPrevented).toBe(false);

    // 正文上的滚轮仍被翻页接管
    const contentWheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    document.querySelector('.chapter-detail-article')!.dispatchEvent(contentWheel);
    expect(contentWheel.defaultPrevented).toBe(true);

    plugin.onUnload();
  });
});

describe('Qimao plugin shell styles', () => {
  it('targets the qimao reading containers from the style files', async () => {
    const read = (name: string): Promise<string> =>
      Bun.file(new URL(`./styles/${name}`, import.meta.url)).text();
    const readerCss = await read('reader.css');
    const wideCss = await read('wide.css');
    const toolbarCss = await read('toolbar.css');
    const navbarCss = await read('navbar.css');
    const progressCss = await read('progress.css');
    const layoutToggleCss = await read('layout-toggle.css');

    expect(readerCss).toContain('body.atreader-qimao-paged .reader-wrapper > .book-info');
    expect(readerCss).toContain('body.atreader-qimao-paged .chapter-detail-wrap.reader-box');
    expect(readerCss).toContain('.atreader-qimao-page-viewport');
    expect(readerCss).toContain('column-count: 2 !important');
    expect(readerCss).toContain('--atreader-page-ratio: 80%');
    expect(readerCss).toContain('--atreader-shell-width: var(--atreader-page-ratio)');
    expect(readerCss).toContain('padding-right: var(--atreader-shell-padding) !important');
    expect(readerCss).toContain('body.atreader-qimao-paged .main');
    expect(readerCss).toContain('body.atreader-qimao-paged .reader-fixed-left');
    expect(readerCss).toContain('.reader-header .reader-header-con');
    expect(readerCss).toContain('transition: none !important');
    expect(readerCss).not.toContain('.atreader-qimao-page-indicator');
    expect(wideCss).toContain('--atreader-page-ratio: 90%');
    expect(wideCss).toContain('body.atreader-qimao-paged');
    expect(toolbarCss).toContain('.reader-fixed-left');
    expect(toolbarCss).toContain('.qm-fixed-right');
    expect(navbarCss).toContain('.reader-header');
    expect(navbarCss).toContain('.chapter-detail-wrap-info .chapter-title');
    expect(navbarCss).toContain('font-size: 12px !important');
    expect(navbarCss).toContain('.chapter-detail-wrap-info .chapter-tips');
    expect(progressCss).toContain('[功能能力 6/6：进度追踪]');
    expect(progressCss).toContain('.atreader-qimao-page-indicator');
    expect(layoutToggleCss).toContain('.atreader-qimao-layout-toggle');
    expect(layoutToggleCss).toContain("data-theme='dark']");
    expect(layoutToggleCss).toContain('#cc6d29');
  });
});
