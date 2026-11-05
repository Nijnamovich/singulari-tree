import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '@core/services/ipc-bridge.service';
import type { RepoFetchState } from '../../remote-models';
import { FetchAllStatus } from './fetch-all-status';

interface Options {
  open?: boolean;
  repoName?: string;
  status?: Readonly<Record<string, RepoFetchState>>;
  error?: AppError | null;
}

async function setup(opts: Options = {}): Promise<ComponentFixture<FetchAllStatus>> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(FetchAllStatus);
  fixture.componentRef.setInput('open', opts.open ?? true);
  fixture.componentRef.setInput('repoName', opts.repoName ?? '');
  fixture.componentRef.setInput('status', opts.status ?? {});
  fixture.componentRef.setInput('error', opts.error ?? null);
  fixture.detectChanges();
  return fixture;
}

function query<T extends Element>(fixture: { nativeElement: unknown }, testId: string): T | null {
  return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
}

describe('FetchAllStatus', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing when closed', async () => {
    const fixture = await setup({ open: false });

    expect(query(fixture, 'fetch-all-status')).toBeNull();
  });

  it('renders the single repository being fetched on one line', async () => {
    const fixture = await setup({ repoName: 'local-1', status: { a: 'pending' } });

    const line = query<HTMLElement>(fixture, 'fetch-all-status')!;
    expect(line.textContent).toContain('Fetching repository');
    expect(query(fixture, 'fetch-all-repo-name')?.textContent?.trim()).toBe('local-1');
    // The fake N/M fan-out aggregate is gone.
    expect(query(fixture, 'fetch-all-count')).toBeNull();
    expect(line.querySelector('[data-testid="fetch-all-row"]')).toBeNull();
  });

  it('settles the title to the success state instead of claiming a fetch forever', async () => {
    const fixture = await setup({ repoName: 'local-1', status: { a: 'success' } });

    expect(query(fixture, 'fetch-all-title')?.textContent?.trim()).toBe('Repository up to date');
    // The reported repository still names the line.
    expect(query(fixture, 'fetch-all-repo-name')?.textContent?.trim()).toBe('local-1');
    expect(query(fixture, 'fetch-all-failed')).toBeNull();
  });

  it('reports a failed fetch in the title (error detail stays beside it)', async () => {
    const fixture = await setup({
      status: { a: 'failed' },
      error: { code: 'FETCH_FAILED', message: 'network down' },
    });

    expect(query(fixture, 'fetch-all-title')?.textContent?.trim()).toBe('Fetch failed');
    expect(query(fixture, 'fetch-all-error')?.textContent).toContain('network down');
  });

  it('shows the failed count only when a repository failed', async () => {
    const clean = await setup({ status: { a: 'success' } });
    expect(query(clean, 'fetch-all-failed')).toBeNull();
    expect(clean.componentInstance.failedCount()).toBe(0);

    const fixture = await setup({ status: { a: 'success', b: 'failed' } });
    expect(query(fixture, 'fetch-all-failed')?.textContent).toContain('✕');
    expect(query(fixture, 'fetch-all-failed')?.textContent).toContain('1');
    expect(fixture.componentInstance.failedCount()).toBe(1);
  });

  it('surfaces the last failure', async () => {
    const fixture = await setup({
      status: { a: 'failed' },
      error: { code: 'FETCH_FAILED', message: 'network down' },
    });

    expect(query(fixture, 'fetch-all-error')?.textContent).toContain('network down');
  });

  it('emits dismissed when the dismiss control is used', async () => {
    const fixture = await setup();
    let dismissed = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissed++);

    query<HTMLButtonElement>(fixture, 'fetch-all-dismiss')!.click();

    expect(dismissed).toBe(1);
  });

  it('counts every failed repository', async () => {
    const fixture = await setup({ status: { a: 'failed', b: 'failed', c: 'success' } });

    expect(fixture.componentInstance.failedCount()).toBe(2);
  });
});
