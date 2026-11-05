import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WipRow } from './wip-row';

function render(selected = false) {
  const fixture = TestBed.createComponent(WipRow);
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();
  return fixture;
}

describe('WipRow', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the pinned working-tree node with the fixed 28px height', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="wip-row-label"]')?.textContent?.trim()).toBe(
      'Uncommitted changes (WIP)',
    );
    expect(el.style.height).toBe('28px');
    // Dashed, neutral node: no commit lane is involved (no backend call).
    expect(el.querySelector('circle')?.getAttribute('stroke-dasharray')).toBe('2 2');
  });

  it('emits picked on click and reflects the selected state', () => {
    const fixture = render(true);
    let picked = 0;
    fixture.componentInstance.picked.subscribe(() => (picked += 1));

    const el = fixture.nativeElement as HTMLElement;
    expect(el.className).toContain('st-wip-row--selected');
    el.click();
    expect(picked).toBe(1);
  });
});
