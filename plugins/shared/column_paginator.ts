export const DEFAULT_COLUMN_GAP = 64;
const MIN_PAGE_HEIGHT = 320;
const PROGRESS_INDICATOR_INSET = 48;

export interface SpreadMetrics {
  pageCount: number;
  pageStride: number;
}

/**
 * CSS 多栏的相邻栏间距也存在于两组跨页之间，所以一整页的位移是
 * `容器宽度 + 一份栏间距`，而不是单纯的 clientWidth。
 */
export function calculateSpreadMetrics(
  clientWidth: number,
  scrollWidth: number,
  columnGap: number,
): SpreadMetrics {
  if (clientWidth <= 0 || scrollWidth <= 0) {
    return { pageCount: 1, pageStride: 0 };
  }
  const safeGap = Number.isFinite(columnGap) && columnGap >= 0
    ? columnGap
    : DEFAULT_COLUMN_GAP;
  const pageStride = clientWidth + safeGap;
  const pageCount = Math.max(1, Math.ceil((scrollWidth + safeGap) / pageStride));
  return { pageCount, pageStride };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * 站点无关的 CSS 多栏分页器：官方站点插件（番茄、七猫等）共用同一套
 * 整页位移逻辑，站点差异全部通过构造参数注入。构建时本模块被内联进
 * 各插件的 plugin.js，运行时不产生跨包依赖。
 */
export interface ColumnPaginatorOptions {
  /** 分页激活时挂在 body 上的类名，插件 CSS 以它为布局开关。 */
  pagedClass: string;
  /** 整页跳转时临时挂载、下一帧移除的“禁用过渡”类名。 */
  noTransitionClass: string;
  /** 包裹正文、裁切视口的容器类名。 */
  viewportClass: string;
  /** 底部“当前页 / 总页数”指示器类名。 */
  indicatorClass: string;
  /** 站点正文内容选择器。 */
  contentSelector: string;
  onPositionChange?: (pageIndex: number, pageCount: number) => void;
  onChapterChange?: (chapterKey: string) => void;
  getChapterKey?: () => string;
}

export class ColumnPaginator {
  private readonly pagedClass: string;
  private readonly noTransitionClass: string;
  private readonly viewportClass: string;
  private readonly indicatorClass: string;
  private readonly contentSelector: string;
  private readonly onPositionChange?: ColumnPaginatorOptions['onPositionChange'];
  private readonly onChapterChange?: ColumnPaginatorOptions['onChapterChange'];
  private readonly getChapterKey: () => string;
  private content: HTMLElement | null = null;
  private viewport: HTMLDivElement | null = null;
  private indicator: HTMLDivElement | null = null;
  private bodyObserver: MutationObserver | null = null;
  /** 样式开关（隐藏导航/宽屏等）注入或移除 <style> 时触发重排。 */
  private headObserver: MutationObserver | null = null;
  private domReadyHandler: (() => void) | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMutations: MutationRecord[] = [];
  private enabled = false;
  private progressVisible = true;
  private pageIndex = 0;
  private pageCount = 1;
  private pageStride = 0;
  private positionRatio = 0;
  private chapterKey = '';
  private openAtEnd = false;
  private lastNotification = '';
  private chapterTransitionPending = false;

  constructor(options: ColumnPaginatorOptions) {
    this.pagedClass = options.pagedClass;
    this.noTransitionClass = options.noTransitionClass;
    this.viewportClass = options.viewportClass;
    this.indicatorClass = options.indicatorClass;
    this.contentSelector = options.contentSelector;
    this.onPositionChange = options.onPositionChange;
    this.onChapterChange = options.onChapterChange;
    this.getChapterKey = options.getChapterKey ?? (() => location.pathname + location.search);
  }

  isActive(): boolean {
    return this.enabled && document.body?.classList.contains(this.pagedClass) === true;
  }

  isAtLastPage(): boolean {
    return this.pageIndex >= this.pageCount - 1;
  }

  getPositionRatio(): number {
    return this.positionRatio;
  }

  setProgressVisible(visible: boolean): void {
    if (visible === this.progressVisible) return;
    this.progressVisible = visible;
    if (visible && this.enabled && document.body) {
      this.ensureIndicator();
      this.updateIndicator();
    } else if (!visible) {
      this.indicator?.remove();
      this.indicator = null;
    }
    if (this.enabled) this.scheduleLayout();
  }

  enable(openAtEnd = false): void {
    this.openAtEnd ||= openAtEnd;
    if (this.enabled) {
      this.scheduleLayout();
      return;
    }
    this.enabled = true;
    this.initializeDocument();
  }

  disable(): void {
    if (!this.enabled) return;
    const ratio = this.getPositionRatio();
    this.enabled = false;
    this.clearTimers();
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
    this.headObserver?.disconnect();
    this.headObserver = null;
    if (this.domReadyHandler) {
      document.removeEventListener('DOMContentLoaded', this.domReadyHandler);
      this.domReadyHandler = null;
    }
    window.removeEventListener('resize', this.handleResize);
    document.body?.classList.remove(
      this.pagedClass,
      this.noTransitionClass,
    );
    this.resetContent();
    this.indicator?.remove();
    this.indicator = null;
    this.chapterKey = '';
    this.pageIndex = 0;
    this.pageCount = 1;
    this.pageStride = 0;
    this.positionRatio = 0;
    this.lastNotification = '';
    this.setChapterTransitionPending(false);

    window.requestAnimationFrame(() => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: ratio * maxScroll, behavior: 'instant' });
    });
  }

  destroy(): void {
    this.disable();
  }

  nextPage(): boolean {
    if (!this.isActive() || !this.content) return false;
    if (this.pageIndex >= this.pageCount - 1) return false;
    this.setPage(this.pageIndex + 1, false);
    return true;
  }

  prevPage(): boolean {
    if (!this.isActive() || !this.content) return false;
    if (this.pageIndex <= 0) return false;
    this.setPage(this.pageIndex - 1, false);
    return true;
  }

  restorePosition(ratio: number): void {
    if (!Number.isFinite(ratio)) return;
    const safeRatio = clamp(ratio, 0, 1);
    const target = Math.round(safeRatio * (this.pageCount - 1));
    this.setPage(target, true);
    this.positionRatio = safeRatio;
  }

  requestOpenAtEnd(): void {
    this.openAtEnd = true;
  }

  /**
   * 在站点已经确认章节切换、但正文 DOM 尚未完成替换时隐藏旧章节，
   * 避免用户看到旧章节末页或旧章节首页的过渡残影。
   */
  prepareChapterTransition(): void {
    if (!this.enabled) return;
    // 章节事件也可能只更新标题、不改变 URL；清空旧 key 让下一次正文更新
    // 一定按“新章节”处理，而不是沿用旧章节页码。
    this.chapterKey = '';
    this.setChapterTransitionPending(true);
  }

  private readonly handleResize = (): void => {
    if (!this.enabled) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.layout(false);
    }, 120);
  };

  private initializeDocument(): void {
    if (!document.body) {
      this.domReadyHandler = () => {
        this.domReadyHandler = null;
        this.initializeDocument();
      };
      document.addEventListener('DOMContentLoaded', this.domReadyHandler, { once: true });
      return;
    }

    document.body.classList.add(this.pagedClass);
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.addEventListener('resize', this.handleResize);
    if (this.progressVisible) this.ensureIndicator();
    this.bodyObserver = new MutationObserver(records => {
      this.pendingMutations.push(...records);
      if (this.mutationTimer) clearTimeout(this.mutationTimer);
      this.mutationTimer = setTimeout(() => {
        this.mutationTimer = null;
        const pendingMutations = this.pendingMutations;
        this.pendingMutations = [];
        this.refreshContent(pendingMutations);
      }, 80);
    });
    this.bodyObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    // 样式开关（隐藏导航栏/宽屏/隐藏工具栏）通过在 <head> 增删 <style> 改变
    // 章节头高度和视口宽度，body 观察不到；单独观察 head 让开关即时重排。
    this.headObserver = new MutationObserver(records => {
      this.pendingMutations.push(...records);
      if (this.mutationTimer) return;
      this.mutationTimer = setTimeout(() => {
        this.mutationTimer = null;
        const pendingMutations = this.pendingMutations;
        this.pendingMutations = [];
        this.refreshContent(pendingMutations);
      }, 80);
    });
    this.headObserver.observe(document.head, { childList: true });
    this.refreshContent();
  }

  private ensureIndicator(): void {
    if (this.indicator?.isConnected) return;
    this.indicator = document.createElement('div');
    this.indicator.className = this.indicatorClass;
    this.indicator.setAttribute('aria-live', 'polite');
    if (this.chapterTransitionPending) this.indicator.style.visibility = 'hidden';
    document.body?.append(this.indicator);
  }

  private refreshContent(records: MutationRecord[] = []): void {
    if (!this.enabled) return;
    const nextContent = document.querySelector<HTMLElement>(this.contentSelector);
    const nextChapterKey = this.getChapterKey();
    const contentChanged = nextContent !== this.content;
    const chapterChanged = nextChapterKey !== this.chapterKey;

    // 站点可能先更新 URL/章节头部，再异步替换正文。此时不要把仍属于旧章节的
    // 内容重排到第 1 页，否则用户会短暂看到“旧章节首页 → 新章节首页”的闪烁。
    // 等正文节点或其子树真正发生变化后，再确认章节切换并执行首屏定位。
    const chapterContentChanged = contentChanged || (
      nextContent !== null
      && records.some(record => nextContent.contains(record.target))
    );
    if (chapterChanged && !chapterContentChanged) {
      this.setChapterTransitionPending(true);
      return;
    }

    if (this.chapterTransitionPending) this.setChapterTransitionPending(false);

    if (contentChanged) {
      this.resetContent();
      this.bindContent(nextContent);
    }
    if (chapterChanged) {
      this.setChapterTransitionPending(false);
      this.chapterKey = nextChapterKey;
      this.pageIndex = 0;
      this.positionRatio = 0;
      this.onChapterChange?.(nextChapterKey);
    }
    if (this.content) {
      this.layout(chapterChanged);
    }
  }

  private scheduleLayout(): void {
    window.requestAnimationFrame(() => this.refreshContent());
  }

  private layout(resetPosition: boolean): void {
    const content = this.content;
    const viewport = this.viewport;
    if (!this.enabled || !content?.isConnected || !viewport?.isConnected) return;

    const previousRatio = resetPosition
      ? (this.openAtEnd ? 1 : 0)
      : this.getPositionRatio();
    const top = Math.max(0, viewport.getBoundingClientRect().top);
    // 页码关闭后留少量底边空白（16px），避免正文紧贴窗口底部。
    const bottomInset = this.progressVisible ? PROGRESS_INDICATOR_INSET : 16;
    const pageHeight = Math.max(MIN_PAGE_HEIGHT, window.innerHeight - top - bottomInset);
    viewport.style.setProperty('--atreader-page-height', `${Math.round(pageHeight)}px`);
    content.style.setProperty('--atreader-page-offset', '0px');

    const computedGap = Number.parseFloat(window.getComputedStyle(content).columnGap);
    const metrics = calculateSpreadMetrics(
      content.clientWidth,
      content.scrollWidth,
      computedGap,
    );
    this.pageCount = metrics.pageCount;
    this.pageStride = metrics.pageStride;
    const target = this.openAtEnd
      ? this.pageCount - 1
      : Math.round(previousRatio * (this.pageCount - 1));
    this.openAtEnd = false;
    this.setPage(target, true);
    this.positionRatio = clamp(previousRatio, 0, 1);
  }

  private setPage(index: number, instant: boolean): void {
    if (!this.content) return;
    this.pageIndex = clamp(index, 0, this.pageCount - 1);
    this.positionRatio = this.pageCount <= 1
      ? 0
      : this.pageIndex / (this.pageCount - 1);
    if (instant) document.body?.classList.add(this.noTransitionClass);
    this.content.style.setProperty(
      '--atreader-page-offset',
      `${-this.pageIndex * this.pageStride}px`,
    );
    this.updateIndicator();
    if (instant) {
      window.requestAnimationFrame(() => {
        document.body?.classList.remove(this.noTransitionClass);
      });
    }
  }

  private updateIndicator(): void {
    if (this.indicator) {
      this.indicator.textContent = `${this.pageIndex + 1} / ${this.pageCount}`;
    }
    const notification = `${this.pageIndex}:${this.pageCount}`;
    if (notification !== this.lastNotification) {
      this.lastNotification = notification;
      this.onPositionChange?.(this.pageIndex, this.pageCount);
    }
  }

  private bindContent(content: HTMLElement | null): void {
    const parent = content?.parentNode;
    if (!content || !parent) return;
    const viewport = document.createElement('div');
    viewport.className = this.viewportClass;
    parent.insertBefore(viewport, content);
    viewport.append(content);
    this.viewport = viewport;
    this.content = content;
  }

  private resetContent(): void {
    if (!this.content) return;
    this.content.style.removeProperty('--atreader-page-offset');
    this.content.style.removeProperty('visibility');
    this.viewport?.style.removeProperty('--atreader-page-height');
    if (this.viewport?.parentNode && this.content.parentNode === this.viewport) {
      this.viewport.parentNode.insertBefore(this.content, this.viewport);
    }
    this.viewport?.remove();
    this.viewport = null;
    this.content = null;
  }

  private setChapterTransitionPending(pending: boolean): void {
    this.chapterTransitionPending = pending;
    if (this.content) {
      if (pending) this.content.style.setProperty('visibility', 'hidden');
      else this.content.style.removeProperty('visibility');
    }
    if (this.indicator) {
      this.indicator.style.visibility = pending ? 'hidden' : '';
    }
  }

  private clearTimers(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.resizeTimer = null;
    this.mutationTimer = null;
    this.pendingMutations = [];
  }
}
