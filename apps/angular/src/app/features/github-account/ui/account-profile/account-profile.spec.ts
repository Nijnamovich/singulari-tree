import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthStatus } from '@contracts/auth';
import { AccountProfile } from './account-profile';

function makeStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    authenticated: true,
    source: 2,
    accountLogin: 'Nijnamovich',
    name: 'David',
    avatarUrl: 'https://avatars.example/u',
    email: 'david@example.com',
    scopes: ['repo'],
    rateLimit: undefined,
    ...overrides,
  };
}

function render(status: AuthStatus | null, sourceLabel = 'gh CLI') {
  const fixture = TestBed.createComponent(AccountProfile);
  fixture.componentRef.setInput('status', status);
  fixture.componentRef.setInput('sourceLabel', sourceLabel);
  fixture.detectChanges();
  return fixture;
}

describe('AccountProfile', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the login, source badge and email when a status is present', () => {
    const fixture = render(makeStatus(), 'OAuth');
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-profile"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="gh-email"]')?.textContent?.trim()).toBe(
      'david@example.com',
    );
    expect(el.querySelector('[data-testid="badge"]')?.textContent?.trim()).toBe('OAuth');
    expect(el.textContent).toContain('Nijnamovich');
  });

  it('falls back to "no disponible" when the email is empty', () => {
    const fixture = render(makeStatus({ email: '' }));
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-email"]')?.textContent?.trim()).toBe('no disponible');
  });

  it('renders the empty state when status is null', () => {
    const fixture = render(null);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="gh-profile"]')).toBeNull();
    expect(el.querySelector('[data-testid="empty-state-title"]')?.textContent?.trim()).toBe(
      'Not connected',
    );
  });
});
