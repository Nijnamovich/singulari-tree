import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GitHubRepo } from '@contracts/auth';
import type { AppError } from '@core/services/ipc-bridge.service';
import { RepoList } from './repo-list';

function makeRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    id: 1,
    name: 'repo-1',
    fullName: 'Nijnamovich/repo-1',
    private: true,
    htmlUrl: 'https://github.com/Nijnamovich/repo-1',
    description: 'repo 1',
    language: 'TypeScript',
    stargazersCount: 1,
    updatedAt: '2026-01-02T10:00:00Z',
    nodeId: 'node-1',
    defaultBranch: 'main',
    ownerLogin: 'Nijnamovich',
    ownerAvatarUrl: 'https://avatars.example/u',
    visibility: 'private',
    fork: false,
    archived: false,
    disabled: false,
    cloneUrl: 'https://github.com/Nijnamovich/repo-1.git',
    sshUrl: 'git@github.com:Nijnamovich/repo-1.git',
    gitUrl: 'git://github.com/Nijnamovich/repo-1.git',
    pushedAt: '2026-01-02T10:00:00Z',
    createdAt: '2025-01-02T10:00:00Z',
    forksCount: 0,
    openIssuesCount: 0,
    topics: [],
    licenseSpdxId: 'MIT',
    isTemplate: false,
    homepage: '',
    ...overrides,
  };
}

interface Inputs {
  repos?: readonly GitHubRepo[];
  loading?: boolean;
  offline?: boolean;
  authenticated?: boolean;
  hasMore?: boolean;
  error?: AppError | null;
}

function render(inputs: Inputs = {}) {
  const fixture = TestBed.createComponent(RepoList);
  fixture.componentRef.setInput('repos', inputs.repos ?? []);
  fixture.componentRef.setInput('loading', inputs.loading ?? false);
  fixture.componentRef.setInput('offline', inputs.offline ?? false);
  fixture.componentRef.setInput('authenticated', inputs.authenticated ?? true);
  fixture.componentRef.setInput('hasMore', inputs.hasMore ?? false);
  fixture.componentRef.setInput('error', inputs.error ?? null);
  fixture.detectChanges();
  return fixture;
}

describe('RepoList', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the error state first, even when offline', () => {
    const fixture = render({
      error: { code: 'GITHUB_API_ERROR', message: 'boom' },
      offline: true,
    });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-repos-error"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="gh-repos-error"]')?.textContent).toContain('boom');
    expect(el.querySelector('[data-testid="gh-repos-offline"]')).toBeNull();
  });

  it('renders the offline state when the core is unavailable', () => {
    const fixture = render({ offline: true });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-repos-offline"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="gh-repos-empty"]')).toBeNull();
  });

  it('renders the not-connected state when unauthenticated', () => {
    const fixture = render({ authenticated: false });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-not-connected"]')?.textContent).toContain(
      'Not connected',
    );
  });

  it('renders the loading state while the first page is in flight', () => {
    const fixture = render({ loading: true });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-repos-loading"]')).not.toBeNull();
  });

  it('renders the empty state when authenticated with no repositories', () => {
    const fixture = render({ authenticated: true });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-repos-empty"]')?.textContent).toContain(
      'No repositories',
    );
  });

  it('keeps loaded repos and shows an inline error when pagination fails', () => {
    const fixture = render({
      repos: [makeRepo({ id: 3, fullName: 'Nijnamovich/repo-3' })],
      error: { code: 'GITHUB_API_ERROR', message: 'page 2 failed' },
    });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-repos"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="gh-repos-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="gh-repos-error-inline"]')?.textContent).toContain(
      'page 2 failed',
    );
    expect(el.querySelectorAll('st-repo-card')).toHaveLength(1);
  });

  it('renders one repository card per repo, mapped to the card view', () => {
    const fixture = render({
      repos: [makeRepo({ id: 7, fullName: 'Nijnamovich/repo-7', description: 'hello' })],
    });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-repos"]')).not.toBeNull();
    const cards = el.querySelectorAll('st-repo-card');
    expect(cards).toHaveLength(1);
    expect(el.textContent).toContain('Nijnamovich/repo-7');
    expect(el.querySelector('[data-testid="repo-card-subtitle"]')?.textContent?.trim()).toBe(
      'hello',
    );
    expect(el.querySelector('[data-testid="repo-card-badge"]')?.textContent?.trim()).toBe('private');
  });

  it('emits loadMore when the load-more button is clicked', () => {
    const fixture = render({
      repos: [makeRepo()],
      hasMore: true,
    });
    let emitted = 0;
    fixture.componentInstance.loadMore.subscribe(() => (emitted += 1));

    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector<HTMLElement>('[data-testid="gh-load-more"]');
    expect(button).not.toBeNull();
    button?.click();

    expect(emitted).toBe(1);
  });
});
