/**
 * 书城切换浮层的 Manager 薄壳：把 IPC 命令注入纯控制器
 * （get_bookstore_list 取有序列表，switch_bookstore_by_index 落地切换）。
 * 远程站点页与本地阅读页共用 AppRuntime，注册一次双端生效。
 */

import { BaseManager } from '../core/base_manager';
import {
  BookstoreSwitcherController,
  type BookstoreEntry,
  type BookstoreListModel,
} from '../core/bookstore_switcher';
import { showSiteSwitchLoading, startupWindowFromGlobal } from '../core/site_switch_loading';
import { invoke } from '../core/tauri';

interface BookstoreListItemPayload {
  id: string;
  name: string;
  icon: string | null;
  index: number;
  current: boolean;
}

export class BookstoreSwitcherManager extends BaseManager {
  private controller: BookstoreSwitcherController;

  constructor() {
    super();
    // 最近一次列表里「当前站」的下标（0-based，-1 = 无当前站）。
    // 切换前预铺过场层前必须用它短路同站提交：switch_to_site 对同站直接
    // return，不发生导航——预铺的 sticky 过场没有新文档来接管，只能不铺。
    let lastCurrentIndex = -1;
    this.controller = new BookstoreSwitcherController(
      {
        loadEntries: async (): Promise<BookstoreListModel> => {
          const items = await invoke<BookstoreListItemPayload[]>('get_bookstore_list');
          const list = Array.isArray(items) ? items : [];
          const entries: BookstoreEntry[] = list.map((item) => ({
            id: item.id,
            name: item.name,
            icon: item.icon ?? null,
            index: item.index,
          }));
          lastCurrentIndex = list.findIndex((item) => item.current);
          return { entries, currentIndex: lastCurrentIndex };
        },
        commit: (entry) => {
          if (lastCurrentIndex >= 0 && entry.index - 1 === lastCurrentIndex) return;
          // 启动窗口期内不预铺过场（与 documentStart 侧判定一致，避免
          // 预铺了过场而新文档不铺的半截状态）
          if (startupWindowFromGlobal()) {
            invoke('switch_bookstore_by_index', { index: entry.index }).catch(() => undefined);
            return;
          }
          // 松手即铺过场：赶在导航延迟之前，旧页面带着过场进入跳转
          showSiteSwitchLoading(document, { sticky: true });
          invoke('switch_bookstore_by_index', { index: entry.index }).catch(() => undefined);
        },
      },
      document,
      navigator.userAgent.includes('Windows'),
    );
  }

  destroy(): void {
    this.controller.destroy();
    super.destroy();
  }
}
