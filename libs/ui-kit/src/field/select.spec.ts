import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SelectComponent } from './select';

@Component({
  selector: 'st-select-test-host',
  imports: [SelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-select [(value)]="value" [testId]="testId" (valueChange)="onValue($event)">
      <option value="en">English</option>
      <option value="es">Spanish</option>
    </st-select>
  `,
})
class SelectTestHost {
  value = 'en';
  testId = '';
  emitted: string[] = [];
  onValue(value: string): void {
    this.emitted.push(value);
  }
}

async function setup(value = 'en', testId = ''): Promise<ComponentFixture<SelectTestHost>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(SelectTestHost);
  fixture.componentInstance.value = value;
  fixture.componentInstance.testId = testId;
  fixture.detectChanges();
  return fixture;
}

function field(fixture: ComponentFixture<SelectTestHost>): HTMLSelectElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
    '[data-testid="select"]',
  )!;
}

describe('SelectComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('projects the options and reflects the controlled value', async () => {
    const fixture = await setup('es');

    expect(field(fixture).options).toHaveLength(2);
    expect(field(fixture).value).toBe('es');
  });

  it('emits the picked value', async () => {
    const fixture = await setup('en');

    const el = field(fixture);
    el.value = 'es';
    el.dispatchEvent(new Event('change'));

    expect(fixture.componentInstance.emitted).toEqual(['es']);
  });

  it('keeps the default testid when no consumer testId is set', async () => {
    const fixture = await setup('en');

    expect(field(fixture).getAttribute('data-testid')).toBe('select');
  });

  it('lets a consumer own the native testid', async () => {
    const fixture = await setup('en', 'pull-remote-select');

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="pull-remote-select"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="select"]')).toBeNull();
  });
});
