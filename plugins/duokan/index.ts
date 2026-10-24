/*!
 * 多看插件（duokan.com）——裸站 + 翻页键桥接。
 *
 * 多看网页阅读器（/reader/www/app.html?id=<bookId>）原生为双页对开的
 * 预分页排版（.book_page 固定 4 页窗口式重渲染），自带 ←/→ 键翻页、
 * 阅读模式（单/双页 j-pattern）、目录（j-toc）、书签、评论——按「站点
 * 插件最小打扰原则」一律不重复、不注入任何样式。
 *
 * 插件唯一职责：把壳层拦截的 Space/PageUp/PageDown 翻页键桥接为站点
 * 已实测响应的合成 ←/→ 方向键（蓝牙遥控器与自动翻页因此在多看可用；
 * ←/→ 壳层本就不拦截，由站点原生处理）。合成按键在 document 上派发，
 * 实测可直接驱动站点翻页，无循环风险（本插件不监听方向键）。
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
  },
};

export class DuokanPlugin implements ReaderPlugin {
  readonly manifest = DUOKAN_RUNTIME_MANIFEST;

  onLoad(): void {}

  onUnload(): void {}

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
