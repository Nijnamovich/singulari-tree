import { ChangeDetectionStrategy, Component, input, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ButtonComponent,
  type ButtonSize,
  type ButtonType,
  type ButtonVariant,
} from '@singularitree/ui-kit';

// Exercises the ui-kit `<st-button>` through the renderer test runner (the
// ui-kit package has no test runner of its own; it is AOT-compiled here).

@Component({
  selector: 'st-button-test-host',
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-button
      [variant]="variant()"
      [size]="size()"
      [disabled]="disabled()"
      [type]="type()"
      [ariaLabel]="ariaLabel()"
      (click)="onClick()"
    >
      Save
    </st-button>
  `,
})
class ButtonTestHost {
  readonly variant = input<ButtonVariant>('default');
  readonly size = input<ButtonSize>('md');
  readonly disabled = input(false);
  readonly type = input<ButtonType>('button');
  readonly ariaLabel = input('');

  clicks = 0;

  onClick(): void {
    this.clicks += 1;
  }
}

function render(): ComponentFixture<ButtonTestHost> {
  const fixture = TestBed.createComponent(ButtonTestHost);
  fixture.detectChanges();
  return fixture;
}

function innerButton(fixture: ComponentFixture<ButtonTestHost>): HTMLButtonElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button')!;
}

describe('ButtonComponent (ui-kit)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders projected content inside a native button', () => {
    const button = innerButton(render());

    expect(button.textContent?.trim()).toBe('Save');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('reflects variant and size in the inner button classes', () => {
    const fixture = TestBed.createComponent(ButtonTestHost);
    fixture.componentRef.setInput('variant', 'primary');
    fixture.componentRef.setInput('size', 'sm');
    fixture.detectChanges();

    const button = innerButton(fixture);
    expect(button.className).toContain('st-button--primary');
    expect(button.className).toContain('st-button--sm');
  });

  it('renders the info variant class on the inner button', () => {
    const fixture = TestBed.createComponent(ButtonTestHost);
    fixture.componentRef.setInput('variant', 'info');
    fixture.detectChanges();

    expect(innerButton(fixture).className).toContain('st-button--info');
  });

  it('disables the inner button when disabled', () => {
    const fixture = TestBed.createComponent(ButtonTestHost);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    expect(innerButton(fixture).disabled).toBe(true);
  });

  it('forwards the aria-label to the inner button', () => {
    const fixture = TestBed.createComponent(ButtonTestHost);
    fixture.componentRef.setInput('ariaLabel', 'Save changes');
    fixture.detectChanges();

    expect(innerButton(fixture).getAttribute('aria-label')).toBe('Save changes');
  });

  it('fires the host click listener through the inner button when enabled', () => {
    const fixture = render();

    innerButton(fixture).click();

    expect(fixture.componentInstance.clicks).toBe(1);
  });

  it('does not fire the host click listener when disabled', () => {
    const fixture = TestBed.createComponent(ButtonTestHost);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    innerButton(fixture).click();

    expect(fixture.componentInstance.clicks).toBe(0);
  });
});
