/*!
 * 七猫小说插件
 *
 * 仅增强网页呈现：CSS 多栏负责排版，代码负责整页位移和章节边界。
 * 不复制正文、不破解字体，也不抓取或导出内容。
 *
 * 七猫阅读页是 SSR 多页架构：每个章节都是一次全新文档加载，翻章直接
 * 点击站点自带的「上一章 / 下一章」链接；跨页阅读位置经 sessionStorage
 * 标记与插件存储在新文档中恢复。
 *
 * 插件编辑器中的六项“功能能力”均有实际控制入口：
 * 1. 双栏模式：分页器 + 原生右侧工具栏单列/双栏按钮；
 * 2. 宽屏模式：按菜单状态注入 wide.css；
 * 3. 隐藏工具栏：按菜单状态注入 toolbar.css（左右浮动工具栏）；
 * 4. 隐藏导航栏：按菜单状态注入 navbar.css（站点顶部导航）；
 * 5. 章节导航：双栏时用上/下键切换上一章/下一章；
 * 6. 进度追踪：显示底部页码，关闭后同时回收页码占用的高度。
 */

import type {
  BookProgress,
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';
import {
  ColumnPaginator,
  calculateSpreadMetrics,
} from '../shared/column_paginator';

export { calculateSpreadMetrics };

const QIMAO_PAGED_CLASS = 'atreader-qimao-paged';
const QIMAO_NO_TRANSITION_CLASS = 'atreader-qimao-no-transition';
const QIMAO_CONTENT_SELECTOR = '.chapter-detail-article';
const PREVIOUS_CHAPTER_FLAG = 'atreader-qimao-open-previous-at-end';
const CHAPTER_START_FLAG = 'atreader-qimao-open-chapter-at-start';
const CHAPTER_NAVIGATION_FLAG_TTL = 15_000;
const WHEEL_THRESHOLD = 56;
const WHEEL_RESET_MS = 220;
const WHEEL_COOLDOWN_MS = 520;
const SCROLLABLE_OVERFLOW_Y = new Set(['auto', 'scroll', 'overlay']);
const LAYOUT_PREFERENCE_KEY = 'double-column-enabled';
const READER_INDEX_PATTERN = /\/reader\/index\/\d+/;
const CHAPTER_PATH_PATTERN = /^\/shuku\/\d+-\d+/;

const SINGLE_COLUMN_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8.5 8H15.5M8.5 11.5H15.5M8.5 15H14" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const DOUBLE_COLUMN_ICON = `
  <svg width="24" height="24" viewBox="0 0 24 24"
    fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="3.5" y="4" width="17" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 4.5V19.5M6.5 8H9.5M14.5 8H17.5M6.5 11.5H9.5M14.5 11.5H17.5"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const QIMAO_RUNTIME_MANIFEST: PluginManifest = {
  id: 'qimao',
  name: '七猫小说',
  version: '1.0.0',
  description: '七猫小说网站支持插件（官方）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['qimao.com'],
    homeUrl: 'https://www.qimao.com/',
    readerPattern: '/(reader/index/\\d+|shuku/\\d+-\\d+)',
  },
  capabilities: {
    wideMode: true,
    hideToolbar: true,
    autoFlip: true,
    chapterNav: true,
    progressTracker: true,
    doubleColumn: true,
    hideNavbar: true,
    hideCursor: true,
    remoteControl: true,
    // 非阅读页交还站点自身样式：全局反色滤镜在七猫上会斑驳（行内背景图
    // 一刀切重转，白卡片维持原样），站点无整站深色模式时保持默认浅色。
    nativeTheme: true,
  },
};

export class QimaoPlugin implements ReaderPlugin {
  readonly manifest = QIMAO_RUNTIME_MANIFEST;

  private api: PluginAPI | null = null;
  private paginator: ColumnPaginator | null = null;
  private cleanupFunctions: Array<() => void> = [];
  private restoreGeneration = 0;
  private positionReady = false;
  private wheelAccumulator = 0;
  private wheelResetTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelCooldown = false;
  private doubleColumnEnabled = true;
  private layoutToggleButton: HTMLLIElement | null = null;
  private toolbarObserver: MutationObserver | null = null;
  private toolbarSyncFrame: number | null = null;
  private toolbarBootstrapTimer: ReturnType<typeof setInterval> | null = null;

  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('Qimao plugin loaded');

    this.paginator = new ColumnPaginator({
      pagedClass: QIMAO_PAGED_CLASS,
      noTransitionClass: QIMAO_NO_TRANSITION_CLASS,
      viewportClass: 'atreader-qimao-page-viewport',
      indicatorClass: 'atreader-qimao-page-indicator',
      contentSelector: QIMAO_CONTENT_SELECTOR,
      getChapterKey: () => this.getChapterKey(),
      onChapterChange: chapterKey => this.restoreChapterPosition(chapterKey),
      onPositionChange: (pageIndex, pageCount) => {
        if (!this.positionReady || pageCount <= 0) return;
        const ratio = pageCount <= 1 ? 0 : pageIndex / (pageCount - 1);
        void this.api?.storage.set(this.positionStorageKey(this.getChapterKey()), ratio);
      },
    });

    window.addEventListener('keydown', this.handleKeyboard, { capture: true });
    window.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
    this.cleanupFunctions.push(() => {
      window.removeEventListener('keydown', this.handleKeyboard, { capture: true });
      window.removeEventListener('wheel', this.handleWheel, { capture: true });
    });

    const unsubscribe = api.settings.subscribe(settings => this.applySettings(settings));
    this.cleanupFunctions.push(unsubscribe);
    this.startToolbarEnhancement();
    this.applySettings(api.settings.getAll());
    void this.restoreLayoutPreference(api);
  }

  onUnload(): void {
    this.restoreGeneration++;
    this.clearWheelState();
    this.stopToolbarEnhancement();
    this.paginator?.destroy();
    this.paginator = null;
    document.body?.classList.remove(QIMAO_PAGED_CLASS);
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];

    if (this.api) {
      for (const id of ['reader', 'wide', 'toolbar', 'navbar', 'progress', 'layout-toggle']) {
        this.api.style.remove(id);
      }
      this.api.log.info('Qimao plugin unloaded');
    }
    this.api = null;
  }

  isReaderPage(): boolean {
    const pathname = window.location.pathname;
    return READER_INDEX_PATTERN.test(pathname) || CHAPTER_PATH_PATTERN.test(pathname);
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
    if (this.paginator?.nextPage()) return;
    this.nextChapter();
  }

  prevPage(): void {
    if (this.paginator?.prevPage()) return;
    if (this.paginator?.isActive()) {
      sessionStorage.setItem(PREVIOUS_CHAPTER_FLAG, String(Date.now()));
    }
    this.prevChapter();
  }

  getStyles(): PluginStyles {
    const file = (name: string): string => this.api?.style.getFile(name) ?? '';
    return {
      wideMode: {
        enabled: file('wide.css'),
        disabled: '',
      },
      toolbar: {
        enabled: file('toolbar.css'),
        disabled: '',
      },
      navbar: {
        enabled: file('navbar.css'),
        disabled: '',
      },
      custom: {
        reader: file('reader.css'),
        progress: file('progress.css'),
        layoutToggle: file('layout-toggle.css'),
      },
    };
  }

  isDoubleColumn(): boolean {
    return this.paginator?.isActive() ?? false;
  }

  isAtBottom(): boolean {
    if (this.paginator?.isActive()) return this.paginator.isAtLastPage();
    const totalHeight = document.documentElement.scrollHeight;
    return window.innerHeight + window.scrollY >= totalHeight - 300;
  }

  /** 当前章在右侧目录中的位置；目录未渲染或不完整时返回 null。 */
  private getCatalogPosition(): { index: number; total: number } | null {
    const items = document.querySelectorAll('.qm-fixed-right li[class*="ref-catalog-li"]');
    const total = items.length;
    if (!total) return null;
    let index = -1;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].classList.contains('active')) {
        index = i;
        break;
      }
    }
    return index >= 0 ? { index, total } : null;
  }

  private getBookName(): string {
    const item = document.querySelector('.chapter-tips dd');
    return item ? (item.textContent || '').trim() : '';
  }

  getChapterProgress(): number {
    const position = this.getCatalogPosition();
    if (!position || position.total <= 0) return 0;
    return Math.min(
      100,
      Math.round(((position.index + 1) / position.total) * 100),
    );
  }

  async getBookProgress(): Promise<BookProgress | null> {
    const position = this.getCatalogPosition();
    if (!position) return null;
    const chapterIdx = position.index + 1;
    const bookName = this.getBookName();
    return {
      progress: position.total > 0
        ? Math.round((chapterIdx / position.total) * 100)
        : 0,
      chapterIdx,
      summary: bookName
        ? `${bookName} · 第 ${chapterIdx}/${position.total} 章`
        : undefined,
    };
  }

  getReaderMenuItems(): string[] {
    return ['reader_wide', 'hide_toolbar', 'hide_navbar', 'auto_flip'];
  }

  private readonly handleKeyboard = (event: KeyboardEvent): void => {
    const keyMatches = (key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => (
      event.key === key || event.code === key
    );
    if (!this.paginator?.isActive()) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.matches('input, textarea, select')) return;

    if (keyMatches('ArrowRight')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.nextPage();
    } else if (keyMatches('ArrowLeft')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.prevPage();
    /*!
     * @capability chapterNav
     * [功能能力 5/6：章节导航]
     * 这是纯交互能力，不需要 CSS；仅在双栏分页激活且能力开启时接管上下键。
    */
    } else if (
      keyMatches('ArrowUp')
      && this.manifest.capabilities.chapterNav === true
    ) {
      this.api?.toast.show('上一章');
      event.preventDefault();
      event.stopImmediatePropagation();
      // 显式跳章应落在上一章开头（与微信读书、番茄、目录跳转一致）；
      // ← 在本章第一页的翻页溢出才落上一章结尾（PREVIOUS_CHAPTER_FLAG）。
      sessionStorage.setItem(CHAPTER_START_FLAG, String(Date.now()));
      this.prevChapter();
    } else if (
      keyMatches('ArrowDown')
      && this.manifest.capabilities.chapterNav === true
    ) {
      this.api?.toast.show('下一章');
      event.preventDefault();
      event.stopImmediatePropagation();
      this.nextChapter();
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.paginator?.isActive() || event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (this.isWithinNativeScrollArea(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.wheelCooldown || Math.abs(event.deltaY) < 1) return;

    this.wheelAccumulator += event.deltaY;
    if (this.wheelResetTimer) clearTimeout(this.wheelResetTimer);
    this.wheelResetTimer = setTimeout(() => {
      this.wheelResetTimer = null;
      this.wheelAccumulator = 0;
    }, WHEEL_RESET_MS);

    if (Math.abs(this.wheelAccumulator) < WHEEL_THRESHOLD) return;
    if (this.wheelAccumulator > 0) this.nextPage();
    else this.prevPage();
    this.wheelAccumulator = 0;
    this.wheelCooldown = true;
    this.wheelCooldownTimer = setTimeout(() => {
      this.wheelCooldownTimer = null;
      this.wheelCooldown = false;
    }, WHEEL_COOLDOWN_MS);
  };

  /// 章节目录等原生弹窗浮在正文上层时，滚轮应滚动弹窗自身的列表。
  /// 本插件的 wheel 监听在 window capture 阶段先于弹窗拿到事件，若不在此
  /// 放行，preventDefault 会吞掉弹窗的原生滚动并变成翻页（“滚动穿透”）。
  /// 判定不依赖七猫弹窗的具体选择器：目标到 body 之间存在纵向可滚动
  /// （overflow-y 为 auto/scroll/overlay 且实际溢出）的祖先即视为弹窗内部。
  private isWithinNativeScrollArea(target: EventTarget | null): boolean {
    // 用 nodeType 而非 instanceof Element 判定元素节点，兼容宿主未暴露
    // Element 全局的注入环境（测试运行时）。
    const start = target && (target as Node).nodeType === Node.ELEMENT_NODE
      ? target as Element
      : null;
    for (let node = start; node; node = node.parentElement) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (SCROLLABLE_OVERFLOW_Y.has(overflowY) && node.scrollHeight > node.clientHeight) {
        return true;
      }
      if (node === document.body) return false;
    }
    return false;
  }

  /** 七猫翻章控件是站点自带的文字链接（底部「上一章 / 下一章」按钮）。 */
  private clickChapterLink(label: '上一章' | '下一章'): boolean {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'))
      .find(a => (a.textContent || '').trim().includes(label));
    if (!link) return false;
    link.click();
    return true;
  }

  prevChapter(): boolean {
    return this.clickChapterLink('上一章');
  }

  nextChapter(): boolean {
    return this.clickChapterLink('下一章');
  }

  private applySettings(settings: Record<string, unknown>): void {
    if (!this.api) return;
    if (!this.isReaderPage()) {
      this.paginator?.disable();
      for (const id of ['reader', 'wide', 'toolbar', 'navbar', 'progress', 'layout-toggle']) {
        this.api.style.remove(id);
      }
      this.removeLayoutToggle();
      return;
    }

    const styles = this.getStyles();
    const readerCss = styles.custom?.reader ?? '';

    /*! @capability doubleColumn [功能能力 1/6：双栏模式] 能力开关是总开关，工具栏按钮负责临时切换。 */
    const hasDoubleColumn = this.manifest.capabilities.doubleColumn === true;
    const doubleColumn = hasDoubleColumn
      && this.doubleColumnEnabled
      && readerCss.trim().length > 0;
    /*! @capability wideMode [功能能力 2/6：宽屏模式] 菜单状态决定是否注入 wide.css。 */
    const wide = settings.readerWide === true;
    /*! @capability hideToolbar [功能能力 3/6：隐藏工具栏] 菜单状态决定是否注入 toolbar.css。 */
    const hideToolbar = settings.hideToolbar === true;
    /*! @capability hideNavbar [功能能力 4/6：隐藏导航栏] 同时要求清单能力和菜单状态开启。 */
    const hideNavbar = settings.hideNavbar === true
      && this.manifest.capabilities.hideNavbar === true;
    /*! @capability progressTracker [功能能力 6/6：进度追踪] 清单能力直接控制底部页码及其预留高度。 */
    const showProgress = this.manifest.capabilities.progressTracker === true;

    // 进度能力关闭时不创建底部页码，并让分页视口回收其 48px 预留区。
    this.paginator?.setProgressVisible(showProgress);

    // reader.css 提供 80% 基线；wide.css 必须随后注入，才能把同级规则覆盖为 90%。
    this.applyStyleFile('reader', readerCss, doubleColumn);
    this.applyStyleFile('wide', styles.wideMode?.enabled ?? '', wide);
    this.applyStyleFile('toolbar', styles.toolbar?.enabled ?? '', hideToolbar);
    this.applyStyleFile('navbar', styles.navbar?.enabled ?? '', hideNavbar);
    this.applyStyleFile(
      'progress',
      styles.custom?.progress ?? '',
      doubleColumn && showProgress,
    );
    this.applyStyleFile(
      'layout-toggle',
      styles.custom?.layoutToggle ?? '',
      hasDoubleColumn,
    );

    if (doubleColumn) this.paginator?.enable();
    else this.paginator?.disable();
    this.syncLayoutToggle();
  }

  private async restoreLayoutPreference(api: PluginAPI): Promise<void> {
    const stored = await api.storage.get<boolean>(LAYOUT_PREFERENCE_KEY);
    if (this.api !== api) return;
    const legacyValue = api.settings.get<boolean>('doubleColumn', true);
    this.doubleColumnEnabled = typeof stored === 'boolean' ? stored : legacyValue !== false;
    if (stored === null) {
      void api.storage.set(LAYOUT_PREFERENCE_KEY, this.doubleColumnEnabled);
    }
    this.applySettings(api.settings.getAll());
  }

  private startToolbarEnhancement(): void {
    if (this.toolbarObserver) return;
    const root = document.documentElement;
    if (!root) {
      this.ensureToolbarBootstrap();
      return;
    }
    this.toolbarObserver = new MutationObserver(() => {
      if (!this.layoutToggleButton?.isConnected) this.ensureToolbarBootstrap();
      this.scheduleToolbarSync();
    });
    // 插件可能在 <body> 与七猫工具栏创建前加载，因此从文档根节点开始监听。
    this.toolbarObserver.observe(root, { childList: true, subtree: true });
    this.syncLayoutToggle();
  }

  private stopToolbarEnhancement(): void {
    this.toolbarObserver?.disconnect();
    this.toolbarObserver = null;
    if (this.toolbarSyncFrame !== null) {
      window.cancelAnimationFrame(this.toolbarSyncFrame);
      this.toolbarSyncFrame = null;
    }
    this.stopToolbarBootstrap();
    this.removeLayoutToggle();
  }

  private ensureToolbarBootstrap(): void {
    if (this.toolbarBootstrapTimer !== null) return;
    if (!this.isReaderPage() || this.manifest.capabilities.doubleColumn !== true) return;
    // SSR 页面正文已就绪，但右侧工具栏可能在首屏脚本之后插入；短间隔补偿确保按钮无需等到首次翻页。
    this.toolbarBootstrapTimer = setInterval(() => this.syncLayoutToggle(), 100);
  }

  private stopToolbarBootstrap(): void {
    if (this.toolbarBootstrapTimer === null) return;
    clearInterval(this.toolbarBootstrapTimer);
    this.toolbarBootstrapTimer = null;
  }

  private scheduleToolbarSync(): void {
    if (this.toolbarSyncFrame !== null) return;
    this.toolbarSyncFrame = window.requestAnimationFrame(() => {
      this.toolbarSyncFrame = null;
      this.syncLayoutToggle();
    });
  }

  private syncLayoutToggle(): void {
    /*! @capability doubleColumn [功能能力 1/6：双栏模式] 只在能力开启时增强七猫原生工具栏。 */
    const shouldShow = this.isReaderPage()
      && this.manifest.capabilities.doubleColumn === true;
    if (!shouldShow) {
      this.stopToolbarBootstrap();
      this.removeLayoutToggle();
      return;
    }

    if (this.layoutToggleButton?.isConnected) {
      this.stopToolbarBootstrap();
      this.updateLayoutToggle();
      return;
    }

    const host = document.querySelector<HTMLElement>('.qm-fixed-right');
    if (!host) {
      this.ensureToolbarBootstrap();
      return;
    }
    if (!this.layoutToggleButton) {
      const item = document.createElement('li');
      item.className = 'atreader-qimao-layout-toggle';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.addEventListener('click', this.toggleLayoutMode);
      item.addEventListener('keydown', this.handleLayoutToggleKeydown);
      this.layoutToggleButton = item;
    }
    if (this.layoutToggleButton.parentElement !== host) {
      // 插入为首个条目：官方卡片的顶部圆角由首条目承担，末条目（举报）
      // 保持站点原生样式，底部圆角不会被抢走。
      host.insertBefore(this.layoutToggleButton, host.firstElementChild);
    }
    this.stopToolbarBootstrap();
    this.updateLayoutToggle();
  }

  private updateLayoutToggle(): void {
    if (!this.layoutToggleButton) return;
    const switchToDoubleColumn = !this.doubleColumnEnabled;
    const label = switchToDoubleColumn ? '双栏' : '单列';
    if (this.layoutToggleButton.dataset.targetMode === label) return;
    this.layoutToggleButton.dataset.targetMode = label;
    this.layoutToggleButton.innerHTML = switchToDoubleColumn
      ? DOUBLE_COLUMN_ICON
      : SINGLE_COLUMN_ICON;
    const text = document.createElement('span');
    text.className = 'title';
    text.textContent = label;
    this.layoutToggleButton.append(text);
    this.layoutToggleButton.setAttribute('aria-label', `切换为${label}阅读`);
    this.layoutToggleButton.setAttribute('title', `切换为${label}阅读`);
  }

  private readonly toggleLayoutMode = (): void => {
    const api = this.api;
    if (!api || this.manifest.capabilities.doubleColumn !== true) return;
    this.doubleColumnEnabled = !this.doubleColumnEnabled;
    void api.storage.set(LAYOUT_PREFERENCE_KEY, this.doubleColumnEnabled);
    this.applySettings(api.settings.getAll());
  };

  private readonly handleLayoutToggleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.toggleLayoutMode();
  };

  private removeLayoutToggle(): void {
    this.layoutToggleButton?.remove();
    this.layoutToggleButton = null;
  }

  private applyStyleFile(id: string, css: string, enabled: boolean): void {
    if (!this.api) return;
    if (enabled && css) this.api.style.inject(id, css);
    else this.api.style.remove(id);
  }

  private restoreChapterPosition(chapterKey: string): void {
    const api = this.api;
    const paginator = this.paginator;
    if (!api || !paginator) return;
    const generation = ++this.restoreGeneration;
    this.positionReady = false;

    // 章首：分页器章节重置后默认就在第一页，跳过进度恢复即可；
    // 章尾：← 翻页溢出的连续阅读流，显式请求落在最后一页。
    const openMode = this.consumeChapterOpenMode();
    if (openMode === 'end') {
      paginator.requestOpenAtEnd();
    }
    if (openMode !== null) {
      this.positionReady = true;
      return;
    }

    void api.storage.get<number>(this.positionStorageKey(chapterKey))
      .then(ratio => {
        if (generation !== this.restoreGeneration || ratio === null) return;
        if (chapterKey !== this.getChapterKey()) return;
        paginator.restorePosition(ratio);
      })
      .finally(() => {
        if (generation === this.restoreGeneration) this.positionReady = true;
      });
  }

  /// 消费章节打开模式标记：两个标记互斥，读取时一并清空，
  /// 防止 15 秒 TTL 内先后触发“跳章”和“翻页溢出”时旧标记误伤下一次章节加载。
  private consumeChapterOpenMode(): 'start' | 'end' | null {
    const startRaw = sessionStorage.getItem(CHAPTER_START_FLAG);
    const endRaw = sessionStorage.getItem(PREVIOUS_CHAPTER_FLAG);
    sessionStorage.removeItem(CHAPTER_START_FLAG);
    sessionStorage.removeItem(PREVIOUS_CHAPTER_FLAG);
    const isFresh = (raw: string | null): boolean => {
      const timestamp = Number(raw);
      return Number.isFinite(timestamp)
        && timestamp > 0
        && Date.now() - timestamp <= CHAPTER_NAVIGATION_FLAG_TTL;
    };
    if (isFresh(startRaw)) return 'start';
    if (isFresh(endRaw)) return 'end';
    return null;
  }

  private getChapterKey(): string {
    return `${location.pathname}${location.search}`;
  }

  private positionStorageKey(chapterKey: string): string {
    return `spread:${chapterKey}`;
  }

  private clearWheelState(): void {
    if (this.wheelResetTimer) clearTimeout(this.wheelResetTimer);
    if (this.wheelCooldownTimer) clearTimeout(this.wheelCooldownTimer);
    this.wheelResetTimer = null;
    this.wheelCooldownTimer = null;
    this.wheelAccumulator = 0;
    this.wheelCooldown = false;
  }
}

export default QimaoPlugin;
