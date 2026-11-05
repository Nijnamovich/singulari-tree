import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ButtonComponent } from './button';

@Component({
  selector: 'st-button-test-host',
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-button
      [pressed]="pressed()"
      [expanded]="expanded()"
      [haspopup]="haspopup()"
      [ariaDescribedby]="describedby()"
    >
      <span>Label</span>
    </st-button>
  `,
})
class ButtonTestHost {
  readonly pressed = signal<boolean | null>(null);
  readonly expanded = signal<boolean | null>(null);
  readonly haspopup = signal<string | null>(null);
  readonly describedby = signal<string | null>(null);
}

async function setup(): Promise<ComponentFixture<ButtonTestHost>> {
  await TestBed.configureTestingModule({
    imports: [ButtonTestHost],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(ButtonTestHost);
  fixture.detectChanges();
  return fixture;
}

function inner(fixture: ComponentFixture<ButtonTestHost>): HTMLButtonElement {
  return (fixture.nativeElement as HTMLElement).querySelector('button')!;
}

describe('ButtonComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('forwards aria-pressed to the inner button', async () => {
    const fixture = await setup();

    fixture.componentInstance.pressed.set(true);
    fixture.detectChanges();
    expect(inner(fixture).getAttribute('aria-pressed')).toBe('true');

    fixture.componentInstance.pressed.set(false);
    fixture.detectChanges();
    expect(inner(fixture).getAttribute('aria-pressed')).toBe('false');
  });

  it('renders no aria-pressed by default', async () => {
    const fixture = await setup();

    expect(inner(fixture).hasAttribute('aria-pressed')).toBe(false);
  });

  it('forwards aria-expanded and aria-haspopup to the inner button', async () => {
    const fixture = await setup();

    fixture.componentInstance.expanded.set(true);
    fixture.componentInstance.haspopup.set('dialog');
    fixture.detectChanges();
    expect(inner(fixture).getAttribute('aria-expanded')).toBe('true');
    expect(inner(fixture).getAttribute('aria-haspopup')).toBe('dialog');

    fixture.componentInstance.expanded.set(false);
    fixture.detectChanges();
    expect(inner(fixture).getAttribute('aria-expanded')).toBe('false');
  });

  it('renders no aria-expanded or aria-haspopup by default', async () => {
    const fixture = await setup();

    expect(inner(fixture).hasAttribute('aria-expanded')).toBe(false);
    expect(inner(fixture).hasAttribute('aria-haspopup')).toBe(false);
  });

  it('forwards aria-describedby to the inner button and omits it by default', async () => {
    const fixture = await setup();

    expect(inner(fixture).hasAttribute('aria-describedby')).toBe(false);

    fixture.componentInstance.describedby.set('st-tooltip');
    fixture.detectChanges();
    expect(inner(fixture).getAttribute('aria-describedby')).toBe('st-tooltip');

    fixture.componentInstance.describedby.set(null);
    fixture.detectChanges();
    expect(inner(fixture).hasAttribute('aria-describedby')).toBe(false);
  });
});
