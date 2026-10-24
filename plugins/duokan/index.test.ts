import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { PluginManifest } from '../../src/scripts/core/plugin_types';
import { DuokanPlugin } from './index';

const withManifestDomain = (plugin: DuokanPlugin, domain: string[]): void => {
  const site = plugin.manifest.site;
  const manifest: PluginManifest = {
    ...plugin.manifest,
    site: {
      domain,
      homeUrl: site?.homeUrl ?? 'https://www.duokan.com/pc/',
      readerPattern: site?.readerPattern ?? '/reader/www/app\\.html',
    },
  };
  Object.defineProperty(plugin, 'manifest', { value: manifest, configurable: true });
};

describe('DuokanPlugin', () => {
  afterEach(() => {
    history.replaceState({}, '', '/');
    document.body.id = '';
    document.body.replaceChildren();
  });

  it('清单契约：裸站 + 翻页桥接——仅声明 autoFlip', () => {
    const plugin = new DuokanPlugin();
    expect(plugin.manifest.id).toBe('duokan');
    expect(plugin.manifest.site?.domain).toEqual(['duokan.com']);
    expect(plugin.manifest.site?.homeUrl).toBe('https://www.duokan.com/pc/');
    expect(plugin.manifest.site?.readerPattern).toBe('/reader/www/app\\.html');
    expect(plugin.manifest.capabilities.autoFlip).toBe(true);
    expect(plugin.manifest.capabilities.nativeTheme).toBe(true);
    expect(plugin.manifest.capabilities.doubleColumn).toBeUndefined();
    expect(plugin.manifest.capabilities.hideToolbar).toBeUndefined();
    expect(plugin.manifest.capabilities.chapterNav).toBeUndefined();
    expect(plugin.manifest.capabilities.progressTracker).toBeUndefined();
    expect(plugin.getReaderMenuItems()).toEqual(['auto_flip']);
    expect(plugin.getStyles()).toEqual({});
  });

  it('域名匹配遵循 DNS label 后缀且不误匹配父串', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=x');
    const plugin = new DuokanPlugin();
    const host = window.location.hostname;

    withManifestDomain(plugin, [host]);
    expect(plugin.matchesDomain()).toBe(true);
    withManifestDomain(plugin, [`sub.${host}`]);
    expect(plugin.matchesDomain()).toBe(false);
    withManifestDomain(plugin, ['duokan.com']);
    expect(plugin.matchesDomain()).toBe(false);
  });

  it('阅读页与首页判定（带书号 query 也算阅读页）', () => {
    const plugin = new DuokanPlugin();
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    expect(plugin.isReaderPage()).toBe(true);
    expect(plugin.isHomePage()).toBe(false);
    history.replaceState({}, '', '/pc/');
    expect(plugin.isReaderPage()).toBe(false);
    expect(plugin.isHomePage()).toBe(true);
  });

  it('双页对开默认：单页态点击一次阅读模式键，双页态不干预，处理后不再重复', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'vertical_reader';
    const patternClick = mock(() => undefined);
    const pattern = document.createElement('span');
    pattern.className = 'j-pattern';
    pattern.addEventListener('click', patternClick);
    document.body.append(pattern);

    const plugin = new DuokanPlugin();
    plugin.onLoad();
    expect(patternClick).toHaveBeenCalledTimes(1);

    // 处理过后即使模式再变化也不再干预（用户手动切单页不被翻回）
    document.body.id = 'vertical_reader';
    plugin.onLoad();
    expect(patternClick).toHaveBeenCalledTimes(1);
    plugin.onUnload();
  });

  it('双页对开默认：已是 horizontal_reader 时不点击', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    document.body.id = 'horizontal_reader';
    const patternClick = mock(() => undefined);
    const pattern = document.createElement('span');
    pattern.className = 'j-pattern';
    pattern.addEventListener('click', patternClick);
    document.body.append(pattern);

    const plugin = new DuokanPlugin();
    plugin.onLoad();
    expect(patternClick).not.toHaveBeenCalled();
    plugin.onUnload();
  });

  it('翻页桥接：阅读页上派发合成 ←/→ 方向键，非阅读页不派发', () => {
    history.replaceState({}, '', '/reader/www/app.html?id=ed873c9e');
    const seen: Array<Record<string, unknown>> = [];
    const listener = (event: KeyboardEvent) => {
      seen.push({ type: event.type, key: event.key, keyCode: event.keyCode, defaultPrevented: event.defaultPrevented });
    };
    document.addEventListener('keydown', listener);
    document.addEventListener('keyup', listener);

    const plugin = new DuokanPlugin();
    plugin.nextPage();
    plugin.prevPage();
    document.removeEventListener('keydown', listener);
    document.removeEventListener('keyup', listener);
    expect(seen).toEqual([
      { type: 'keydown', key: 'ArrowRight', keyCode: 39, defaultPrevented: false },
      { type: 'keyup', key: 'ArrowRight', keyCode: 39, defaultPrevented: false },
      { type: 'keydown', key: 'ArrowLeft', keyCode: 37, defaultPrevented: false },
      { type: 'keyup', key: 'ArrowLeft', keyCode: 37, defaultPrevented: false },
    ]);

    history.replaceState({}, '', '/pc/');
    seen.length = 0;
    plugin.nextPage();
    expect(seen).toEqual([]);
  });
});
