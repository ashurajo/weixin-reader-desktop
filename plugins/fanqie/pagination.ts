export const FANQIE_PAGED_CLASS = 'atreader-fanqie-paged';
export const FANQIE_NO_TRANSITION_CLASS = 'atreader-fanqie-no-transition';
export const FANQIE_CONTENT_SELECTOR = '.muye-reader-content';

import {
  ColumnPaginator,
  type ColumnPaginatorOptions,
} from '../shared/column_paginator';

export { calculateSpreadMetrics } from '../shared/column_paginator';

interface FanqiePaginatorOptions
  extends Pick<ColumnPaginatorOptions, 'onPositionChange' | 'onChapterChange' | 'getChapterKey'> {}

/*!
 * @capability doubleColumn
 * [功能能力 1/6：双栏模式]
 * 只管理原页面 DOM 的“呈现方式”：不复制正文，也不读取正文文本。
 * 正文仍由番茄页面渲染，CSS columns 负责分栏，本类只计算整页位移。
 * 分页实现来自 plugins/shared/column_paginator.ts，站点差异只在下方常量。
 */
export class FanqiePaginator extends ColumnPaginator {
  constructor(options: FanqiePaginatorOptions = {}) {
    super({
      pagedClass: FANQIE_PAGED_CLASS,
      noTransitionClass: FANQIE_NO_TRANSITION_CLASS,
      viewportClass: 'atreader-fanqie-page-viewport',
      indicatorClass: 'atreader-fanqie-page-indicator',
      contentSelector: FANQIE_CONTENT_SELECTOR,
      ...options,
    });
  }
}
