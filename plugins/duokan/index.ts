/*!
 * 多看插件（duokan.com）——裸站 + 翻页键桥接 + 双页对开默认。
 *
 * 多看网页阅读器（/reader/www/app.html?id=<bookId>）原生为双页对开的
 * 预分页排版（.book_page 固定 4 页窗口式重渲染），自带 ←/→ 键翻页、
 * 阅读模式（单/双页 j-pattern）、目录（j-toc）、书签、评论——按「站点
 * 插件最小打扰原则」一律不重复、不注入任何样式。
 *
 * 插件做两件事：
 * 1. 双页对开默认：站点在无阅读偏好时默认 vertical_reader（单页）。
 *    阅读页入口观察到 body.id=vertical_reader 即点击一次 j-pattern 切到
 *    horizontal_reader（双页），随后立即收手——用户此后用站点按钮切回
 *    单页不会被翻回（站点会记住选择）。
 * 2. 翻页键桥接：把壳层拦截的 Space/PageUp/PageDown 桥接为站点已实测
 *    响应的合成 ←/→ 方向键（蓝牙遥控器与自动翻页因此在多看可用；
 *    ←/→ 壳层本就不拦截，由站点原生处理）。
 *
 * 另声明 nativeTheme：多看门户/书城/已购页自带暗色设计，壳层反色滤镜
 * 会与站点原生配色打架（反色不完全），深浅完全让位站点自身。
 *
 * 登录 Cookie（token/user_id，约 90 天持久）站点自身已持久化，
 * 无需掌阅式会话 Cookie 续期。
 */

import type {
  PluginManifest,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const DUOKAN_RUNTIME_MANIFEST: PluginManifest = {
  id: 'duokan',
  name: '多看',
  version: '1.0.0',
  description: '多看网页版在线阅读（原生双页排版，桥接空格/翻页键）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['duokan.com'],
    homeUrl: 'https://www.duokan.com/pc/',
    readerPattern: '/reader/www/app\\.html',
  },
  capabilities: {
    autoFlip: true,
    nativeTheme: true,
  },
};

export class DuokanPlugin implements ReaderPlugin {
  readonly manifest = DUOKAN_RUNTIME_MANIFEST;

  private patternObserver: MutationObserver | null = null;
  private patternEnsured = false;

  onLoad(): void {
    this.ensureDoublePage();
  }

  onUnload(): void {
    this.patternObserver?.disconnect();
    this.patternObserver = null;
    this.patternEnsured = false;
  }

  isReaderPage(): boolean {
    return window.location.pathname === '/reader/www/app.html';
  }

  isHomePage(): boolean {
    const pathname = window.location.pathname;
    return pathname === '/' || pathname === '/pc/' || pathname === '/pc';
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
    this.dispatchFlip('ArrowRight', 39);
  }

  prevPage(): void {
    this.dispatchFlip('ArrowLeft', 37);
  }

  /*!
   * 阅读页入口确保双页对开：站点阅读器异步初始化，body.id 先空后有值，
   * 用 body 属性观察器捕获首次赋值；horizontal（已是双页）或处理过一次
   * 即解除观察，此后用户在站点内手动切单页不干预。
   */
  private ensureDoublePage(): void {
    if (!this.isReaderPage() || this.patternEnsured) return;
    if (this.applyDoublePage()) return;
    const body = document.body;
    if (!body || this.patternObserver) return;
    this.patternObserver = new MutationObserver(() => {
      if (this.applyDoublePage() && this.patternObserver) {
        this.patternObserver.disconnect();
        this.patternObserver = null;
      }
    });
    this.patternObserver.observe(body, { attributes: true, attributeFilter: ['id'] });
  }

  private applyDoublePage(): boolean {
    if (this.patternEnsured || !document.body) return false;
    if (document.body.id === 'horizontal_reader') {
      this.patternEnsured = true;
      return true;
    }
    if (document.body.id === 'vertical_reader') {
      this.patternEnsured = true;
      document.querySelector<HTMLElement>('.j-pattern')?.click();
      return true;
    }
    return false;
  }

  private dispatchFlip(key: 'ArrowLeft' | 'ArrowRight', keyCode: number): void {
    if (!this.isReaderPage()) return;
    const init: KeyboardEventInit & { keyCode: number; which: number } = {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  getStyles() {
    return {};
  }

  getReaderMenuItems(): string[] {
    return ['auto_flip'];
  }
}

export default DuokanPlugin;
