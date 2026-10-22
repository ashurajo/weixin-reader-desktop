import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { AppRuntime } from '../app_runtime';
import { EventBus, Events } from '../event_bus';
import { getPluginLoader } from '../plugin_loader';
import { settingsStore } from '../settings_store';
import { createSiteContext } from '../site_context';

const loader = getPluginLoader();
const context = createSiteContext();
const originals = {
  loaderDestroy: loader.destroy,
  hotReload: loader.hotReload,
  settingsDestroy: settingsStore.destroy,
  refresh: settingsStore.refresh,
  contextDestroy: context.destroy,
  invalidate: context.invalidate,
};

describe('AppRuntime ownership', () => {
  beforeEach(() => {
    EventBus.clearHistory();
    delete (window as any).pluginSystem;
  });

  afterEach(() => {
    loader.destroy = originals.loaderDestroy;
    loader.hotReload = originals.hotReload;
    settingsStore.destroy = originals.settingsDestroy;
    settingsStore.refresh = originals.refresh;
    context.destroy = originals.contextDestroy;
    context.invalidate = originals.invalidate;
    EventBus.clearHistory();
    delete (window as any).pluginSystem;
  });

  it('destroys owned managers in reverse order and releases global resources once', () => {
    const order: string[] = [];
    const runtime = new AppRuntime();
    const pagehideHandler = mock(() => undefined);
    const performanceCleanup = mock(() => order.push('performance'));
    const pluginsUnlisten = mock(() => order.push('plugins-listener'));
    window.addEventListener('pagehide', pagehideHandler);
    Object.assign(runtime as any, {
      disposables: [
        { destroy: () => order.push('first') },
        { destroy: () => order.push('second') },
      ],
      pagehideHandler,
      performanceCleanup,
      pluginsUnlisten,
    });
    loader.destroy = mock(() => order.push('loader'));
    context.destroy = mock(() => order.push('context'));
    settingsStore.destroy = mock(() => order.push('settings'));
    (window as any).pluginSystem = { active: true };
    EventBus.emit(Events.ROUTE_CHANGED, { isReader: true });

    runtime.destroy();
    runtime.destroy();

    expect(order).toEqual([
      'performance',
      'plugins-listener',
      'second',
      'first',
      'loader',
      'context',
      'settings',
    ]);
    expect((window as any).pluginSystem).toBeUndefined();
    expect(EventBus.getLatestEvent(Events.ROUTE_CHANGED)).toBeNull();
    expect((runtime as any).reloadGeneration).toBe(1);
  });

  it('skips the inversion filter only when the active site declares nativeTheme', () => {
    const originalGetActive = loader.getActivePlugin;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (() => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;
    const destroyAll = (runtime: AppRuntime) => {
      for (const disposable of (runtime as any).disposables) disposable.destroy();
      (runtime as any).disposables.length = 0;
    };
    try {
      // 声明 nativeTheme 的站点：非阅读页初始路由也不创建反色滤镜
      loader.getActivePlugin = mock(() => ({
        manifest: { capabilities: { nativeTheme: true } },
      }) as any);
      const nativeRuntime = new AppRuntime();
      (nativeRuntime as any).createManagers(false);
      expect(document.getElementById('wxrd-dark-mode-filter')).toBeNull();
      destroyAll(nativeRuntime);

      // 未声明的站点（老插件）：维持原有反色兜底
      loader.getActivePlugin = mock(() => ({
        manifest: { capabilities: {} },
      }) as any);
      const legacyRuntime = new AppRuntime();
      (legacyRuntime as any).createManagers(false);
      expect(document.getElementById('wxrd-dark-mode-filter')?.textContent).toContain('invert(1)');
      destroyAll(legacyRuntime);
    } finally {
      loader.getActivePlugin = originalGetActive;
      window.matchMedia = originalMatchMedia;
    }
  });

  it('keeps the single-window link policy active on reader pages', () => {
    const originalOpen = window.open;
    const originalGetActive = loader.getActivePlugin;
    loader.getActivePlugin = mock(() => ({
      manifest: { capabilities: {} },
    }) as any);
    const runtime = new AppRuntime();
    try {
      (runtime as any).createManagers(true);
      // 阅读页不建 ThemeManager（反色滤镜会污染站点），但链接策略必须仍在。
      expect(document.getElementById('wxrd-dark-mode-filter')).toBeNull();
      expect(window.open).not.toBe(originalOpen);
    } finally {
      for (const disposable of (runtime as any).disposables) disposable.destroy();
      (runtime as any).disposables.length = 0;
      loader.getActivePlugin = originalGetActive;
    }
    expect(window.open).toBe(originalOpen);
  });

  it('serializes plugin reload and refreshes settings before replacing the runtime', async () => {
    const order: string[] = [];
    const runtime = new AppRuntime();
    settingsStore.refresh = mock(async () => { order.push('settings'); });
    loader.hotReload = mock(async () => { order.push('plugins'); });
    context.invalidate = mock(() => { order.push('context'); });

    (runtime as any).schedulePluginReload();
    (runtime as any).schedulePluginReload();
    await (runtime as any).reloadQueue;

    expect(order).toEqual([
      'settings', 'plugins', 'context',
      'settings', 'plugins', 'context',
    ]);
    loader.destroy = mock(() => undefined);
    context.destroy = mock(() => undefined);
    settingsStore.destroy = mock(() => undefined);
    runtime.destroy();
  });

  it('does not run a queued reload after destruction invalidates its generation', async () => {
    const runtime = new AppRuntime();
    const refresh = mock(async () => undefined);
    settingsStore.refresh = refresh;
    loader.destroy = mock(() => undefined);
    context.destroy = mock(() => undefined);
    settingsStore.destroy = mock(() => undefined);

    (runtime as any).schedulePluginReload();
    runtime.destroy();
    await (runtime as any).reloadQueue;
    expect(refresh).not.toHaveBeenCalled();
  });
});
