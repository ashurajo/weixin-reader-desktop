export class LinkManager {
  private clickHandler: ((e: Event) => void) | null = null;
  private originalWindowOpen: typeof window.open | null = null;

  constructor() {
    this.initLinks();
  }

  private initLinks() {
    // 代理 window.open
    this.originalWindowOpen = window.open;
    window.open = function(url: string | URL | undefined, _target?: string | undefined, _features?: string | undefined) {
      if (url) {
        window.location.href = url.toString();
      }
      return null;
    };

    // 监听所有点击事件
    this.clickHandler = (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a');
      // 单窗口壳层没有新窗口委托：除 _self 外的 target（含七猫动态创建的
      // 命名窗口 book_<id>）都会让导航被 WebView 静默吞掉，统一改回当前窗口。
      if (link && link.target && link.target !== '_self') {
        link.target = '_self';
      }
    };
    document.addEventListener('click', this.clickHandler, true);
  }

  public destroy() {
    if (this.clickHandler) {
      document.removeEventListener('click', this.clickHandler, true);
      this.clickHandler = null;
    }
    if (this.originalWindowOpen) {
      window.open = this.originalWindowOpen;
      this.originalWindowOpen = null;
    }
  }
}
