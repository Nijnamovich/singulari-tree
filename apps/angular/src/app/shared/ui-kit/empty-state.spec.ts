import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { EmptyStateComponent, type EmptyStateTone } from '@singularitree/ui-kit';

// Exercises the ui-kit `<st-empty-state>` through the renderer test runner (the
// ui-kit package has no test runner of its own; it is AOT-compiled here).

interface EmptyStateInputs {
  icon?: string;
  title?: string;
  message?: string;
  tone?: EmptyStateTone;
}

function render(inputs: EmptyStateInputs = {}) {
  const fixture = TestBed.createComponent(EmptyStateComponent);
  if (inputs.icon !== undefined) fixture.componentRef.setInput('icon', inputs.icon);
  if (inputs.title !== undefined) fixture.componentRef.setInput('title', inputs.title);
  if (inputs.message !== undefined) fixture.componentRef.setInput('message', inputs.message);
  if (inputs.tone !== undefined) fixture.componentRef.setInput('tone', inputs.tone);
  fixture.detectChanges();
  return fixture;
}

function query(fixture: ReturnType<typeof render>, testId: string): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
}

describe('EmptyStateComponent (ui-kit)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders icon, title and message when provided', () => {
    const fixture = render({ icon: '📁', title: 'No repositories', message: 'Add one to begin' });

    expect(query(fixture, 'empty-state-icon')?.textContent?.trim()).toBe('📁');
    expect(query(fixture, 'empty-state-title')?.textContent?.trim()).toBe('No repositories');
    expect(query(fixture, 'empty-state-message')?.textContent?.trim()).toBe('Add one to begin');
  });

  it('omits each optional part when empty', () => {
    const fixture = render();

    expect(query(fixture, 'empty-state')).not.toBeNull();
    expect(query(fixture, 'empty-state-icon')).toBeNull();
    expect(query(fixture, 'empty-state-title')).toBeNull();
    expect(query(fixture, 'empty-state-message')).toBeNull();
  });

  it('applies the tone class, including the error tone', () => {
    const error = render({ tone: 'error' });
    expect(query(error, 'empty-state')?.className).toContain('st-empty-state--error');

    const neutral = render();
    expect(query(neutral, 'empty-state')?.className).toContain('st-empty-state--neutral');
  });
});
