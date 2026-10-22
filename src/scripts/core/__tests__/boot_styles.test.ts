/**
 * Unit Tests for Boot Styles
 *
 * 首绘样式引导：壳内嵌快照（__ATREADER_BOOT__）在 documentStart 同步套用
 * 站点插件的导航/工具栏隐藏 CSS，插件系统就绪后移除。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { applyBootStyles, settleBootStyles } from '../boot_styles';

const NAVBAR_CSS = 'header { display: none !important; }';
const TOOLBAR_CSS = '.rail { display: none !important; }';

const setSnapshot = (snapshot: unknown): void => {
  (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__ = snapshot;
};

describe('boot styles', () => {
  afterEach(() => {
    settleBootStyles();
    delete (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__;
  });

  it('applies capability-gated styles for the matching site before first paint', () => {
    setSnapshot({
      siteSettings: { zread: { hideNavbar: true, hideToolbar: true } },
      plugins: [
        {
          id: 'zread',
          domains: ['example.com'],
          capabilities: { hideNavbar: true, hideToolbar: true },
          styles: { navbar: NAVBAR_CSS, toolbar: TOOLBAR_CSS },
        },
      ],
    });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-navbar')?.textContent).toBe(NAVBAR_CSS);
    expect(document.getElementById('atreader-boot-toolbar')?.textContent).toBe(TOOLBAR_CSS);
  });

  it('ignores plugins whose domains do not match the host', () => {
    setSnapshot({
      siteSettings: { qidian: { hideNavbar: true } },
      plugins: [
        {
          id: 'qidian',
          domains: ['qidian.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('requires both the manifest capability and the site setting', () => {
    setSnapshot({
      siteSettings: {
        a: { hideNavbar: true },
        b: { hideNavbar: false },
      },
      plugins: [
        {
          id: 'a',
          domains: ['example.com'],
          capabilities: { hideNavbar: false },
          styles: { navbar: NAVBAR_CSS },
        },
        {
          id: 'b',
          domains: ['example.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });

    applyBootStyles();

    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('tolerates malformed snapshots and entries', () => {
    setSnapshot('not-an-object');
    expect(() => applyBootStyles()).not.toThrow();

    setSnapshot({ plugins: [null, { domains: 'oops' }, { id: 'zread', domains: ['zread.ai'] }] });
    expect(() => applyBootStyles()).not.toThrow();
    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('settle removes boot styles and stays idempotent', () => {
    setSnapshot({
      siteSettings: { zread: { hideNavbar: true } },
      plugins: [
        {
          id: 'zread',
          domains: ['example.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });
    applyBootStyles();
    expect(document.getElementById('atreader-boot-navbar')).not.toBeNull();

    settleBootStyles();
    expect(document.getElementById('atreader-boot-navbar')).toBeNull();

    settleBootStyles();
    expect(document.getElementById('atreader-boot-navbar')).toBeNull();
  });

  it('applies each style at most once per page', () => {
    setSnapshot({
      siteSettings: { zread: { hideNavbar: true } },
      plugins: [
        {
          id: 'zread',
          domains: ['example.com'],
          capabilities: { hideNavbar: true },
          styles: { navbar: NAVBAR_CSS },
        },
      ],
    });

    applyBootStyles();
    applyBootStyles();

    expect(document.querySelectorAll('#atreader-boot-navbar')).toHaveLength(1);
  });
});
