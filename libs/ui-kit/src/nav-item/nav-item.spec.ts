import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { NavItemComponent } from './nav-item';

async function setup(
  inputs: { icon?: string; label?: string; count?: number; active?: boolean; disabled?: boolean } = {},
): Promise<ComponentFixture<NavItemComponent>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(NavItemComponent);
  fixture.componentRef.setInput('icon', inputs.icon ?? 'history');
  fixture.componentRef.setInput('label', inputs.label ?? 'History');
  if (inputs.count !== undefined) fixture.componentRef.setInput('count', inputs.count);
  if (inputs.active !== undefined) fixture.componentRef.setInput('active', inputs.active);
  if (inputs.disabled !== undefined) fixture.componentRef.setInput('disabled', inputs.disabled);
  fixture.detectChanges();
  return fixture;
}

function button(fixture: ComponentFixture<NavItemComponent>): HTMLButtonElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
    '[data-testid="nav-item"]',
  )!;
}

describe('NavItemComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders a native button with the label and icon', async () => {
    const fixture = await setup({ label: 'Cambios' });

    expect(button(fixture).getAttribute('type')).toBe('button');
    expect(button(fixture).textContent).toContain('Cambios');
    expect(button(fixture).querySelector('svg')).not.toBeNull();
  });

  it('marks the active item with aria-current and the selection bar', async () => {
    const fixture = await setup({ active: true });

    const el = button(fixture);
    expect(el.getAttribute('aria-current')).toBe('page');
    expect(el.classList.contains('st-nav-item--active')).toBe(true);
    expect(el.classList.contains('st-selection-bar')).toBe(true);
  });

  it('omits aria-current when inactive', async () => {
    const fixture = await setup({ active: false });

    expect(button(fixture).getAttribute('aria-current')).toBeNull();
    expect(button(fixture).classList.contains('st-selection-bar')).toBe(false);
  });

  it('renders the count pill when the count is positive', async () => {
    const fixture = await setup({ count: 3 });

    expect(fixture.nativeElement.querySelector('[data-testid="nav-item-count"]')).not.toBeNull();
  });

  it('hides the count pill at zero', async () => {
    const fixture = await setup({ count: 0 });

    expect(fixture.nativeElement.querySelector('[data-testid="nav-item-count"]')).toBeNull();
  });

  it('bubbles a click to the host listener', async () => {
    const fixture = await setup();
    let clicks = 0;
    (fixture.nativeElement as HTMLElement).addEventListener('click', () => {
      clicks += 1;
    });

    button(fixture).click();

    expect(clicks).toBe(1);
  });

  it('disables the inner button and flags the host', async () => {
    const fixture = await setup({ disabled: true });

    expect(button(fixture).disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).classList.contains('st-nav-item-host--disabled')).toBe(
      true,
    );
  });
});
