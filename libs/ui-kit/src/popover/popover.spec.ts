import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PopoverComponent } from './popover';

@Component({
  selector: 'st-popover-test-host',
  imports: [PopoverComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-popover [open]="open" (closed)="onClosed()">
      <button type="button" data-testid="popover-item">Settings</button>
    </st-popover>
  `,
})
class PopoverTestHost {
  open = false;
  closes = 0;
  onClosed(): void {
    this.closes += 1;
  }
}

async function setup(open = true): Promise<ComponentFixture<PopoverTestHost>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(PopoverTestHost);
  fixture.componentInstance.open = open;
  fixture.detectChanges();
  return fixture;
}

function el(fixture: ComponentFixture<PopoverTestHost>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

describe('PopoverComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing while closed', async () => {
    const fixture = await setup(false);

    expect(el(fixture).querySelector('[data-testid="popover"]')).toBeNull();
    expect(el(fixture).querySelector('[data-testid="popover-backdrop"]')).toBeNull();
  });

  it('renders the panel and backdrop while open', async () => {
    const fixture = await setup(true);

    expect(el(fixture).querySelector('[data-testid="popover"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-testid="popover-backdrop"]')).not.toBeNull();
  });

  it('exposes the panel as a dialog with projected content', async () => {
    const fixture = await setup(true);

    const panel = el(fixture).querySelector('[data-testid="popover"]')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.querySelector('[data-testid="popover-item"]')).not.toBeNull();
  });

  it('closes on Escape while open', async () => {
    const fixture = await setup(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(fixture.componentInstance.closes).toBe(1);
  });

  it('ignores Escape while closed', async () => {
    const fixture = await setup(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(fixture.componentInstance.closes).toBe(0);
  });

  it('closes on a backdrop click', async () => {
    const fixture = await setup(true);

    el(fixture).querySelector<HTMLElement>('[data-testid="popover-backdrop"]')!.click();

    expect(fixture.componentInstance.closes).toBe(1);
  });
});
