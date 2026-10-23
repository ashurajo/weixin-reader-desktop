/*!
 * 得到插件（dedao.cn）——裸站声明。
 *
 * 得到 PC 阅读器高度完善（SVG 预分页、单/双/三栏、四套主题、字号、目录、
 * 搜索、全屏、←/→/空格翻页、点击正文显隐工具栏），按「站点插件最小打扰
 * 原则」，当前不注入任何样式、不桥接任何交互，给用户一个裸的得到。
 *
 * 唯一保留的声明是 nativeTheme：告诉壳层本站深浅模式完全由站点自身控制，
 * 禁止 ThemeManager 注入 html 反色滤镜（该滤镜会破坏 WebKit 在 SPA 路由
 * 切换后的点击命中）。这不是一项「功能」，而是一条「请勿打扰」声明。
 *
 * nextPage/prevPage 为接口必填的空实现：壳层拦截的 Space/PageUp/PageDown
 * 暂不做翻页桥接（蓝牙遥控器在得到内暂无翻页），←/→ 键壳层本就不拦截、
 * 由站点原生处理。
 */

import type {
  PluginManifest,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';

// 运行时代码中不内联 manifest 的 base64 图标，避免插件编辑器顶部出现超长数据行。
const DEDAO_RUNTIME_MANIFEST: PluginManifest = {
  id: 'dedao',
  name: '得到',
  version: '0.1.0',
  description: '得到（dedao.cn）在线阅读（裸站接入，深浅主题由站点自身控制）',
  author: '艾特阅读团队',
  homepage: 'https://github.com/dengcb/weixin-reader-desktop',
  sourceType: 'web',
  renderMode: 'webview',
  site: {
    domain: ['dedao.cn'],
    homeUrl: 'https://www.dedao.cn/',
    readerPattern: '/ebook/reader',
  },
  capabilities: {
    nativeTheme: true,
  },
};

export class DedaoPlugin implements ReaderPlugin {
  readonly manifest = DEDAO_RUNTIME_MANIFEST;

  onLoad(): void {}

  onUnload(): void {}

  isReaderPage(): boolean {
    return window.location.pathname === '/ebook/reader';
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

  nextPage(): void {}

  prevPage(): void {}

  getStyles() {
    return {};
  }

  getReaderMenuItems(): string[] {
    return [];
  }
}

export default DedaoPlugin;
