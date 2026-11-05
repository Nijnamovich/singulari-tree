import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SelectableRowDirective } from './selectable-row';

@Component({
  selector: 'st-selectable-row-test-host',
  imports: [SelectableRowDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="row"
      stSelectableRow
      [selected]="selected"
      [disabled]="disabled"
      (rowActivated)="onActivated()"
    >
      row
    </div>
  `,
})
class SelectableRowTestHost {
  selected = false;
  disabled = false;
  activations = 0;
  onActivated(): void {
    this.activations += 1;
  }
}

async function setup(
  inputs: { selected?: boolean; disabled?: boolean } = {},
): Promise<ComponentFixture<SelectableRowTestHost>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(SelectableRowTestHost);
  fixture.componentInstance.selected = inputs.selected ?? false;
  fixture.componentInstance.disabled = inputs.disabled ?? false;
  fixture.detectChanges();
  return fixture;
}

function row(fixture: ComponentFixture<SelectableRowTestHost>): HTMLElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="row"]')!;
}

describe('SelectableRowDirective', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('applies the shared row classes and makes the host focusable', async () => {
    const fixture = await setup();

    const el = row(fixture);
    expect(el.classList.contains('st-selectable-row')).toBe(true);
    expect(el.classList.contains('st-focus-ring--inset')).toBe(true);
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('adds the selected fill and selection bar when selected', async () => {
    const fixture = await setup({ selected: true });

    const el = row(fixture);
    expect(el.classList.contains('st-selectable-row--selected')).toBe(true);
    expect(el.classList.contains('st-selection-bar')).toBe(true);
  });

  it('emits rowActivated on click', async () => {
    const fixture = await setup();

    row(fixture).click();

    expect(fixture.componentInstance.activations).toBe(1);
  });

  it('emits rowActivated on Enter and Space', async () => {
    const fixture = await setup();

    row(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    row(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));

    expect(fixture.componentInstance.activations).toBe(2);
  });

  it('removes tabindex and stays inert when disabled', async () => {
    const fixture = await setup({ disabled: true });

    const el = row(fixture);
    expect(el.hasAttribute('tabindex')).toBe(false);

    el.click();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(fixture.componentInstance.activations).toBe(0);
  });
});
