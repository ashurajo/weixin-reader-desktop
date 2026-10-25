import { afterEach, describe, expect, it } from 'bun:test';
import { ColumnPaginator } from './column_paginator';

const PAGED = 'atreader-test-paged';
const NO_TRANSITION = 'atreader-test-no-transition';
const VIEWPORT = 'atreader-test-page-viewport';
const INDICATOR = 'atreader-test-page-indicator';
const CONTENT_SELECTOR = '.reader-content';

interface BuildResult {
  paginator: ColumnPaginator;
  anomalies: string[];
}

const buildPaginator = (
  overrides: Partial<ConstructorParameters<typeof ColumnPaginator>[0]> = {},
): BuildResult => {
  const anomalies: string[] = [];
  const paginator = new ColumnPaginator({
    pagedClass: PAGED,
    noTransitionClass: NO_TRANSITION,
    viewportClass: VIEWPORT,
    indicatorClass: INDICATOR,
    contentSelector: CONTENT_SELECTOR,
    bindMode: 'self',
    onAnomaly: detail => anomalies.push(detail),
    ...overrides,
  });
  return { paginator, anomalies };
};

const mountContent = (): HTMLElement => {
  const content = document.createElement('div');
  content.className = 'reader-content';
  content.innerHTML = '<p>第一段</p><p>第二段</p>';
  document.body.append(content);
  return content;
};

describe('ColumnPaginator self-mode viewport class integrity', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
  });

  it('binds the viewport class onto the content itself without DOM mutation', () => {
    const content = mountContent();
    const { paginator } = buildPaginator();
    paginator.enable();

    expect(document.body.classList.contains(PAGED)).toBe(true);
    expect(content.classList.contains(VIEWPORT)).toBe(true);
    // self 模式零 DOM 改动：正文仍是 body 的直接子节点
    expect(content.parentElement).toBe(document.body);
    expect(document.querySelectorAll('.reader-content')).toHaveLength(1);
    expect(paginator.getStats().viewportClassApplied).toBe(true);

    paginator.destroy();
    expect(content.classList.contains(VIEWPORT)).toBe(false);
  });

  it('restores the viewport class when the site framework rewrites className', async () => {
    const content = mountContent();
    const { paginator, anomalies } = buildPaginator();
    paginator.enable();
    expect(content.classList.contains(VIEWPORT)).toBe(true);

    // 站点框架按自己的类模板重写 className：视口类被抹掉、元素保持连接
    // （掌阅单栏事故现场：contentConnected=true 而 liveClasses 无视口类）
    content.className = 'reader-content';
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(content.classList.contains(VIEWPORT)).toBe(true);
    expect(anomalies).toContain('viewport-class-lost');
    expect(paginator.getStats().viewportClassApplied).toBe(true);

    paginator.destroy();
  });

  it('re-binds a replacement rendered after the old content was removed', async () => {
    const content = mountContent();
    const { paginator, anomalies } = buildPaginator();
    paginator.enable();

    content.remove();
    // 断连由 400ms 完整性轮询取证（变异去抖先行重绑时轮询兜底）
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(anomalies).toContain('content-disconnected');

    const replacement = document.createElement('div');
    replacement.className = 'reader-content';
    replacement.innerHTML = '<p>新章节</p>';
    document.body.append(replacement);
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(replacement.classList.contains(VIEWPORT)).toBe(true);
    expect(anomalies).toContain('rebound');
    expect(paginator.getStats().contentConnected).toBe(true);

    paginator.destroy();
  });
});
