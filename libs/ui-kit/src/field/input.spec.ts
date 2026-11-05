import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { InputComponent } from './input';

async function setup(
  inputs: {
    type?: 'text' | 'search' | 'password';
    value?: string;
    disabled?: boolean;
    ariaLabel?: string;
    testId?: string;
    readonly?: boolean;
  } = {},
): Promise<ComponentFixture<InputComponent>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(InputComponent);
  if (inputs.type) fixture.componentRef.setInput('type', inputs.type);
  if (inputs.value !== undefined) fixture.componentRef.setInput('value', inputs.value);
  if (inputs.disabled !== undefined) fixture.componentRef.setInput('disabled', inputs.disabled);
  if (inputs.ariaLabel !== undefined) fixture.componentRef.setInput('ariaLabel', inputs.ariaLabel);
  if (inputs.testId !== undefined) fixture.componentRef.setInput('testId', inputs.testId);
  if (inputs.readonly !== undefined) fixture.componentRef.setInput('readonly', inputs.readonly);
  fixture.detectChanges();
  return fixture;
}

function field(fixture: ComponentFixture<InputComponent>): HTMLInputElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
    '[data-testid="input"]',
  )!;
}

describe('InputComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('binds the controlled value and type', async () => {
    const fixture = await setup({ type: 'search', value: 'fix' });

    expect(field(fixture).value).toBe('fix');
    expect(field(fixture).getAttribute('type')).toBe('search');
  });

  it('emits the typed value', async () => {
    const fixture = await setup();
    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((value) => emitted.push(value));

    const el = field(fixture);
    el.value = 'main';
    el.dispatchEvent(new Event('input'));

    expect(emitted).toEqual(['main']);
  });

  it('disables the native control', async () => {
    const fixture = await setup({ disabled: true });

    expect(field(fixture).disabled).toBe(true);
  });

  it('forwards the aria-label', async () => {
    const fixture = await setup({ ariaLabel: 'Filter branches' });

    expect(field(fixture).getAttribute('aria-label')).toBe('Filter branches');
  });

  it('keeps the default testid when no consumer testId is set', async () => {
    const fixture = await setup();

    expect(field(fixture).getAttribute('data-testid')).toBe('input');
  });

  it('lets a consumer own the native testid', async () => {
    const fixture = await setup({ testId: 'repos-add-input' });

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="repos-add-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="input"]')).toBeNull();
  });

  it('forwards the readonly state to the native control', async () => {
    const fixture = await setup({ readonly: true });

    expect(field(fixture).readOnly).toBe(true);
  });
});
