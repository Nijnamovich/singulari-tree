import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { IconComponent } from './icon';

async function render(name: string): Promise<HTMLElement> {
  await TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(IconComponent);
  fixture.componentRef.setInput('name', name);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('IconComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders an inline svg for a known name', async () => {
    const host = await render('history');

    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-width')).toBe('1.8');
    expect(svg?.querySelectorAll('path, circle, line, rect').length).toBeGreaterThan(0);
  });

  it('renders nothing for an unknown name', async () => {
    const host = await render('not-a-real-icon');

    expect(host.querySelector('svg')).toBeNull();
  });

  it('hides the glyph from assistive technology', async () => {
    const host = await render('plus');

    expect(host.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies an explicit pixel size when provided', async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', 'plus');
    fixture.componentRef.setInput('size', 22);
    fixture.detectChanges();

    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
    expect(svg?.style.width).toBe('22px');
  });
});
