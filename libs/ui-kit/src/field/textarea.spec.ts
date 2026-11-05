import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TextareaComponent } from './textarea';

async function setup(
  inputs: { value?: string; disabled?: boolean; rows?: number; testId?: string } = {},
): Promise<ComponentFixture<TextareaComponent>> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(TextareaComponent);
  if (inputs.value !== undefined) fixture.componentRef.setInput('value', inputs.value);
  if (inputs.disabled !== undefined) fixture.componentRef.setInput('disabled', inputs.disabled);
  if (inputs.rows !== undefined) fixture.componentRef.setInput('rows', inputs.rows);
  if (inputs.testId !== undefined) fixture.componentRef.setInput('testId', inputs.testId);
  fixture.detectChanges();
  return fixture;
}

function field(fixture: ComponentFixture<TextareaComponent>): HTMLTextAreaElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLTextAreaElement>(
    '[data-testid="textarea"]',
  )!;
}

describe('TextareaComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('binds the controlled value and row count', async () => {
    const fixture = await setup({ value: 'Initial commit', rows: 4 });

    expect(field(fixture).value).toBe('Initial commit');
    expect(field(fixture).getAttribute('rows')).toBe('4');
  });

  it('emits the typed value', async () => {
    const fixture = await setup();
    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((value) => emitted.push(value));

    const el = field(fixture);
    el.value = 'feat: add graph';
    el.dispatchEvent(new Event('input'));

    expect(emitted).toEqual(['feat: add graph']);
  });

  it('disables the native control', async () => {
    const fixture = await setup({ disabled: true });

    expect(field(fixture).disabled).toBe(true);
  });

  it('keeps the default testid when no consumer testId is set', async () => {
    const fixture = await setup();

    expect(field(fixture).getAttribute('data-testid')).toBe('textarea');
  });

  it('lets a consumer own the native testid', async () => {
    const fixture = await setup({ testId: 'commit-message-input' });

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="commit-message-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="textarea"]')).toBeNull();
  });
});
