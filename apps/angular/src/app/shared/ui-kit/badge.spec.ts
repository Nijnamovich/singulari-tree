import { ChangeDetectionStrategy, Component, input, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { BadgeComponent, type BadgeVariant } from '@singularitree/ui-kit';

// Exercises the ui-kit `<st-badge>` through the renderer test runner (the
// ui-kit package has no test runner of its own; it is AOT-compiled here).

@Component({
  selector: 'st-badge-test-host',
  imports: [BadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<st-badge [variant]="variant()">main</st-badge>`,
})
class BadgeTestHost {
  readonly variant = input<BadgeVariant>('neutral');
}

function render(variant?: BadgeVariant) {
  const fixture = TestBed.createComponent(BadgeTestHost);
  if (variant) {
    fixture.componentRef.setInput('variant', variant);
  }
  fixture.detectChanges();
  return fixture;
}

function badge(fixture: ReturnType<typeof render>): HTMLElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    '[data-testid="badge"]',
  )!;
}

describe('BadgeComponent (ui-kit)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the projected text', () => {
    const el = badge(render());

    expect(el.textContent?.trim()).toBe('main');
    expect(el.className).toContain('st-badge--neutral');
  });

  it('applies the requested variant class', () => {
    const el = badge(render('branch'));

    expect(el.className).toContain('st-badge--branch');
    expect(el.className).not.toContain('st-badge--neutral');
  });
});
